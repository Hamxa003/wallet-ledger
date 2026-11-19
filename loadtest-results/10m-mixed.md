Scenario mixed: 100 connections over 4 threads, 5s warmup then 30s measured, against http://localhost:8080

| Endpoint | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
| balance | 311506 | 10384 | 4.37 | 6.41 | 11.96 | 49.59 | 200: 311506 |
| credit | 186827 | 6228 | 4.48 | 6.64 | 12.17 | 50.43 | 200: 186827 |
| debit | 124458 | 4149 | 4.49 | 6.66 | 12.19 | 50.26 | 200: 124457, 409: 1 |

Total 622791 requests (20760 req/s), unexpected statuses: 0, network errors: 0
