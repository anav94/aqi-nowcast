# AQI Nowcast & Alerts — Delhi NCR (Cloudflare Workers)

[![Deploy to Cloudflare Workers](https://github.com/anav94/aqi-nowcast/actions/workflows/deploy.yml/badge.svg)](https://github.com/anav94/aqi-nowcast/actions/workflows/deploy.yml)


Live API: https://aqi-nowcast.aqinowcast.workers.dev  
Endpoints:
- `/healthz`
- `/forecast` — 24h mean ±1σ band
- `/timeseries` — last 72h hourly PM2.5
- `/tasks/ingest` — manual ingestion (cron runs hourly)
- `/tasks/test-alert` — Telegram test

## What it does
- Ingests hourly PM2.5 from OpenAQ v3 for NCR and stores in Workers KV
- Computes a simple nowcast band (mean ± std) and exposes a public API
- Sends Telegram alerts on spikes (anomaly vs recent baseline)
- Serves a lightweight dashboard (Chart.js) from the same Worker
- Runs at the edge with zero infra to manage; designed for $0 on free tier

## Architecture
- Cloudflare Workers (serverless, edge), Workers KV, Cron Triggers
- OpenAQ v3 (requires API key)
- Telegram Bot alerts
- Static assets via `assets.directory=public` with Worker fallback

## Measured results (Sep 5, 2025 IST)
- Functional: ✅ Live endpoints working; hourly cron enabled
- Latency (k6, 20 VUs, 30s, /forecast): avg ~436 ms, p95 ~1.31 s, 0% errors
- Cost: $0 (free tier)
- Alerting: Telegram bot test ✅

> Note: `/forecast` and `/timeseries` are edge-cached for 60s; end-to-end latency includes TLS and per-colo cold starts. Further tuning: increase cache TTL, precompute forecast on ingest, and serve precomputed JSON.

## Runbook
- Deploy: `wrangler deploy`
- Manual ingest: `curl -X POST $BASE/tasks/ingest`
- Forecast: `curl $BASE/forecast`
- Timeseries: `curl $BASE/timeseries`
- Test alert: `curl $BASE/tasks/test-alert`

## Config & Secrets
- `OPENAQ_API_KEY` — OpenAQ v3 API key
- `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` — for alerts
- KV binding: `AQI_KV`
- Cron: `0 * * * *`

## Next improvements
- Precompute 24h forecast JSON during ingest (single KV read, lower p95)
- Daily MAE/MAPE vs ground truth, publish on dashboard
- OpenAPI spec + GitHub Actions CI (lint, typecheck, deploy)
- Cost/usage dashboard (Cloudflare Analytics)

## Credits
- Data: OpenAQ
- Edge runtime: Cloudflare Workers
