Scenario mixed: 100 connections over 4 threads, 5s warmup then 30s measured, against http://localhost:8080

| Endpoint | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
| balance | 298422 | 9947 | 4.39 | 6.90 | 13.64 | 169.26 | 200: 298422 |
| credit | 179416 | 5981 | 4.51 | 7.21 | 14.56 | 128.42 | 200: 179416 |
| debit | 119601 | 3987 | 4.51 | 7.13 | 14.38 | 128.46 | 200: 119595, 409: 6 |

Total 597439 requests (19915 req/s), unexpected statuses: 0, network errors: 0
