import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Context } from 'hono'

export interface Env {
  AQI_KV: KVNamespace
  TELEGRAM_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
  OPENAQ_API_KEY?: string
  ALERT_THRESHOLD_PM25?: string
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Env }>()
app.use('*', cors())

const BBOX_NCR = '76.80,28.10,77.60,28.90'
const OPENAQ = 'https://api.openaq.org/v3'
const SERIES_KEY = 'series:last72'

const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: AQI Nowcast & Alerts - Delhi NCR
  version: "1.0.0"
  description: |
    Serverless AQI nowcast API on Cloudflare Workers.
    Data source: OpenAQ v3. Times are UTC, hourly resolution.
servers:
  - url: https://aqi-nowcast.aqinowcast.workers.dev
paths:
  /healthz:
    get:
      summary: Health check
      responses:
        "200":
          description: OK
  /forecast:
    get:
      summary: 24h nowcast band (mean +/- std)
      responses:
        "200":
          description: Forecast payload
        "503":
          description: No data yet
  /timeseries:
    get:
      summary: Last 72 hours PM2.5
      responses:
        "200":
          description: Time series
        "503":
          description: No data yet
`

const OPENAPI_JSON = {
  openapi: '3.0.3',
  info: {
    title: 'AQI Nowcast & Alerts - Delhi NCR',
    version: '1.0.0',
    description: 'Serverless AQI nowcast API on Cloudflare Workers. Data source: OpenAQ v3. Times are UTC, hourly resolution.'
  },
  servers: [{ url: 'https://aqi-nowcast.aqinowcast.workers.dev' }],
  paths: {
    '/healthz': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
    '/forecast': { get: { summary: '24h nowcast band (mean +/- std)', responses: { '200': { description: 'Forecast payload' }, '503': { description: 'No data yet' } } } },
    '/timeseries': { get: { summary: 'Last 72 hours PM2.5', responses: { '200': { description: 'Time series' }, '503': { description: 'No data yet' } } } }
  }
}

const DOCS_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AQI Nowcast API Docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head><body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.onload=()=>{SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui'})}</script>
</body></html>`

function isoHour(d = new Date()): string {
  const z = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0))
  return z.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
function stddev(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = arr.reduce((a, b) => a + b, 0) / arr.length
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length
  return Math.sqrt(v)
}
async function telegram(env: Env, text: string) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) return
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`
  try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }) }) } catch {}
}
function latestAtOrBefore(keys: string[], targetIso: string): string | undefined {
  const prior = keys.filter(k => k <= targetIso).sort()
  return prior.length ? prior[prior.length - 1] : undefined
}
function authHeaders(env: Env): HeadersInit {
  return env.OPENAQ_API_KEY ? { 'X-API-Key': env.OPENAQ_API_KEY } : {}
}

async function fetchOpenAQAvgPM25(env: Env): Promise<{ ts: string; value?: number }> {
  const now = new Date()
  const lastFullHour = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() - 1, 0, 0))
  const hourIso = isoHour(lastFullHour)
  try {
    const locResp = await fetch(`${OPENAQ}/locations?bbox=${encodeURIComponent(BBOX_NCR)}&parameters_id=2&limit=1000`, { headers: authHeaders(env), cf: { cacheTtl: 120 } })
    if (locResp.ok) {
      const locData: any = await locResp.json()
      const sensorIds: string[] = []
      for (const loc of (locData?.results || [])) for (const s of (loc?.sensors || [])) if (s?.parameter?.id === 2 && s?.id) sensorIds.push(String(s.id))
      const unique = Array.from(new Set(sensorIds)).slice(0, 25)
      const date_from = new Date(lastFullHour.getTime() - 30 * 60 * 60 * 1000).toISOString()
      const date_to = now.toISOString()
      const promises = unique.map(async (sid) => {
        try {
          const r = await fetch(`${OPENAQ}/sensors/${sid}/hours?date_from=${encodeURIComponent(date_from)}&date_to=${encodeURIComponent(date_to)}&limit=1000`, { headers: authHeaders(env), cf: { cacheTtl: 120 } })
          if (!r.ok) return null
          const j: any = await r.json()
          return j?.results || []
        } catch { return null }
      })
      const resultsArrays = await Promise.all(promises)
      const byTs: Record<string, number[]> = {}
      for (const arr of resultsArrays) if (arr) for (const row of arr) {
        const ts = row?.period?.datetimeTo?.utc
        const v = Number(row?.value)
        if (!ts || !Number.isFinite(v)) continue
        if (!byTs[ts]) byTs[ts] = []
        byTs[ts].push(v)
      }
      const keys = Object.keys(byTs)
      const chosenTs = latestAtOrBefore(keys, hourIso)
      if (chosenTs) {
        const vals = byTs[chosenTs]
        if (vals?.length) {
          const mean = vals.reduce((a, b) => a + b, 0) / vals.length
          return { ts: chosenTs, value: Number(mean.toFixed(2)) }
        }
      }
    }
  } catch {}
  try {
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString()
    const r = await fetch(`${OPENAQ}/measurements?parameters_id=2&bbox=${encodeURIComponent(BBOX_NCR)}&date_from=${encodeURIComponent(sixHoursAgo)}&date_to=${encodeURIComponent(now.toISOString())}&limit=10000`, { headers: authHeaders(env), cf: { cacheTtl: 60 } })
    if (!r.ok) return { ts: hourIso }
    const data: any = await r.json()
    const results: any[] = data?.results || []
    const bucket: Record<string, number[]> = {}
    for (const row of results) {
      const t = row?.date?.utc || row?.date?.utcFrom || row?.period?.datetimeTo?.utc
      const v = Number(row?.value)
      if (!Number.isFinite(v) || !t) continue
      const key = isoHour(new Date(t))
      if (!bucket[key]) bucket[key] = []
      bucket[key].push(v)
    }
    const keys = Object.keys(bucket)
    const chosenTs = latestAtOrBefore(keys, hourIso)
    if (chosenTs) {
      const vals = bucket[chosenTs]
      if (vals?.length) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length
        return { ts: chosenTs, value: Number(mean.toFixed(2)) }
      }
    }
  } catch {}
  return { ts: hourIso }
}

async function rebuildSeries(env: Env): Promise<Array<{ ts: string; pm25: number }>> {
  const list = await env.AQI_KV.list({ prefix: 'pm25:' })
  const keys = list.keys.map(k => k.name).sort()
  const last = keys.slice(-72)
  const values = await Promise.all(last.map(k => env.AQI_KV.get<number>(k, 'json')))
  const out: Array<{ ts: string; pm25: number }> = []
  for (let i = 0; i < last.length; i++) {
    const v = values[i]
    if (typeof v === 'number') out.push({ ts: last[i].replace('pm25:', ''), pm25: v })
  }
  await env.AQI_KV.put(SERIES_KEY, JSON.stringify(out))
  return out
}
async function getSeries(env: Env): Promise<Array<{ ts: string; pm25: number }>> {
  const cached = await env.AQI_KV.get<Array<{ ts: string; pm25: number }>>(SERIES_KEY, 'json')
  if (cached && Array.isArray(cached)) return cached
  return rebuildSeries(env)
}

app.get('/healthz', (c: Context) => c.json({ ok: true }))

async function ingest(env: Env) {
  const { ts, value } = await fetchOpenAQAvgPM25(env)
  if (typeof value === 'number') await env.AQI_KV.put(`pm25:${ts}`, JSON.stringify(value))
  const list = await env.AQI_KV.list({ prefix: 'pm25:' })
  const keys = list.keys.map(k => k.name).sort()
  const keep = 24 * 60
  const old = keys.slice(0, Math.max(0, keys.length - keep))
  for (const k of old) await env.AQI_KV.delete(k)
  await rebuildSeries(env)

  if (typeof value === 'number') {
    const series = await getSeries(env)
    const hist = series.slice(-6, -1).map(p => p.pm25)
    const base = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : value
    if (value > base + Math.max(10, stddev(hist) * 2)) {
      await telegram(env, `⚠️ AQI spike in NCR: PM2.5 ~ ${value.toFixed(1)} µg/m³ at ${ts} (vs recent baseline ${base.toFixed(1)})`)
    }
    const abs = Number(env.ALERT_THRESHOLD_PM25 ?? '90')
    if (value >= abs) {
      await telegram(env, `🚨 Unhealthy AQI in NCR: PM2.5 ~ ${value.toFixed(1)} µg/m³ at ${ts} (threshold ${abs})`)
    }
  }
  return { ts, value }
}

app.post('/tasks/ingest', async (c: Context) => {
  const res = await ingest(c.env)
  return c.json({ ingested: true, ...res })
})

app.get('/forecast', async (c: Context) => {
  const cache = caches.default
  const req = new Request(c.req.url, c.req.raw)
  const hit = await cache.match(req)
  if (hit) return hit
  const series = await getSeries(c.env)
  if (!series.length) return c.json({ error: 'no data yet' }, 503)
  const last24 = series.slice(-24)
  const vals = last24.map(p => p.pm25)
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const s = stddev(vals)
  const payload = { city: 'ncr', hour: isoHour(), pm25_mean: Number(mean.toFixed(1)), pm25_low: Number(Math.max(0, mean - s).toFixed(1)), pm25_high: Number((mean + s).toFixed(1)), samples: vals.length, method: 'hourly-mean±std' }
  const res = new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', 'Cache-Control': 'public, s-maxage=60' } })
  c.executionCtx.waitUntil(cache.put(req, res.clone()))
  return res
})

app.get('/timeseries', async (c: Context) => {
  const cache = caches.default
  const req = new Request(c.req.url, c.req.raw)
  const hit = await cache.match(req)
  if (hit) return hit
  const series = await getSeries(c.env)
  const payload = { city: 'ncr', hours: series.length, series }
  const res = new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', 'Cache-Control': 'public, s-maxage=60' } })
  c.executionCtx.waitUntil(cache.put(req, res.clone()))
  return res
})

app.get('/openapi.yaml', () => new Response(OPENAPI_YAML, { headers: { 'content-type': 'text/yaml; charset=utf-8' } }))
app.get('/openapi.json', () => new Response(JSON.stringify(OPENAPI_JSON, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } }))
app.get('/docs', () => new Response(DOCS_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
app.get('/docs.html', () => new Response(DOCS_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }))

app.get('/alerts/rules', (c: Context) => {
  const abs = Number(c.env.ALERT_THRESHOLD_PM25 ?? '90')
  return c.json({ absolute_pm25_threshold: abs, spike_rule: 'value > baseline + max(10, 2*stddev(last 5 hours))' })
})

app.post('/tasks/force-alert', async (c: Context) => {
  const url = new URL(c.req.url)
  const q = url.searchParams
  const v = Number(q.get('pm25') ?? '')
  const ts = isoHour()
  const value = Number.isFinite(v) ? v : (await getSeries(c.env)).slice(-1)[0]?.pm25
  if (!Number.isFinite(value)) return c.json({ error: 'no value available' }, 400)
  await telegram(c.env, `🔔 Forced alert: PM2.5 ~ ${Number(value).toFixed(1)} µg/m³ at ${ts}`)
  return c.json({ ok: true, sent: true, value, ts })
})

app.notFound(async (c) => {
  return await c.env.ASSETS.fetch(c.req.raw)
})

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: async (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) => {
    await ingest(env)
  }
}
