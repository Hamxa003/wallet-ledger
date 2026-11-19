Scenario hot: 100 connections over 4 threads, 5s warmup then 30s measured, against http://localhost:8080

| Endpoint | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
| balance (hot user) | 15127 | 504 | 2.06 | 2.82 | 5.25 | 64.80 | 200: 15127 |
| balance (other users) | 318162 | 10605 | 2.19 | 2.97 | 5.50 | 68.03 | 200: 318162 |
| credit (hot user) | 37864 | 1262 | 25.64 | 31.73 | 49.71 | 95.23 | 200: 37864 |
| credit (other users) | 191719 | 6391 | 2.29 | 3.12 | 5.69 | 68.10 | 200: 191719 |
| debit (hot user) | 22784 | 759 | 25.68 | 31.79 | 50.25 | 96.40 | 200: 22784 |
| debit (other users) | 127328 | 4244 | 2.30 | 3.13 | 5.70 | 67.85 | 200: 127273, 409: 55 |

Total 712984 requests (23766 req/s), unexpected statuses: 0, network errors: 0
