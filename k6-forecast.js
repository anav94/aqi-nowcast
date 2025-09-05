import http from 'k6/http'
import { check, sleep } from 'k6'
export const options = {
  thresholds: {
    http_req_duration: ['p(95)<150'],
    http_req_failed: ['rate<0.01']
  }
}
export default function () {
  const res = http.get(`${__ENV.ENDPOINT}/forecast`)
  check(res, { 'status 200': (r) => r.status === 200 })
  sleep(1)
}
