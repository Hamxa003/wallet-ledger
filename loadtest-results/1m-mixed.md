Scenario mixed: 100 connections over 4 threads, 5s warmup then 30s measured, against http://localhost:8080

| Endpoint | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
| balance | 326106 | 10870 | 4.08 | 5.93 | 12.20 | 144.54 | 200: 326106 |
| credit | 195001 | 6500 | 4.16 | 6.10 | 12.59 | 153.28 | 200: 195001 |
| debit | 130400 | 4347 | 4.18 | 6.11 | 12.59 | 145.78 | 200: 130348, 409: 52 |

Total 651507 requests (21717 req/s), unexpected statuses: 0, network errors: 0
