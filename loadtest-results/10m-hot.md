Scenario hot: 100 connections over 4 threads, 5s warmup then 30s measured, against http://localhost:8080

| Endpoint | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
| balance (hot user) | 66854 | 2228 | 3.15 | 4.59 | 8.59 | 61.02 | 200: 66854 |
| balance (other users) | 213723 | 7124 | 3.16 | 4.59 | 8.72 | 62.30 | 200: 213723 |
| credit (hot user) | 167119 | 5571 | 4.40 | 6.66 | 11.48 | 68.30 | 200: 167119 |
| credit (other users) | 128319 | 4277 | 3.34 | 4.95 | 9.23 | 64.05 | 200: 128319 |
| debit (hot user) | 100575 | 3353 | 4.39 | 6.64 | 11.51 | 67.55 | 200: 100575 |
| debit (other users) | 85248 | 2842 | 3.35 | 4.95 | 9.33 | 64.27 | 200: 85244, 409: 4 |

Total 761838 requests (25395 req/s), unexpected statuses: 0, network errors: 0
