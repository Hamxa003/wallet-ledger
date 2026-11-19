Scenario hot: 100 connections over 4 threads, 5s warmup then 30s measured, against http://localhost:8080

| Endpoint | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
| balance (hot user) | 13018 | 434 | 2.23 | 3.31 | 6.11 | 136.93 | 200: 13018 |
| balance (other users) | 285183 | 9506 | 2.31 | 3.42 | 6.33 | 251.46 | 200: 285183 |
| credit (hot user) | 33370 | 1112 | 25.83 | 36.74 | 56.71 | 507.63 | 200: 33370 |
| credit (other users) | 171534 | 5718 | 2.44 | 3.66 | 6.66 | 253.34 | 200: 171534 |
| debit (hot user) | 19960 | 665 | 25.83 | 36.61 | 56.30 | 498.00 | 200: 19960 |
| debit (other users) | 113824 | 3794 | 2.45 | 3.67 | 6.60 | 250.43 | 200: 113821, 409: 3 |

Total 636889 requests (21230 req/s), unexpected statuses: 0, network errors: 0
