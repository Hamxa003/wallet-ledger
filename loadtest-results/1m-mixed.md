Scenario mixed: 100 connections over 4 threads, 5s warmup then 30s measured, against http://localhost:8080

| Endpoint | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
| balance | 331104 | 11037 | 4.24 | 5.62 | 10.37 | 47.50 | 200: 331104 |
| credit | 198564 | 6619 | 4.32 | 5.73 | 10.45 | 47.42 | 200: 198564 |
| debit | 132092 | 4403 | 4.33 | 5.76 | 10.60 | 47.46 | 200: 132047, 409: 45 |

Total 661760 requests (22059 req/s), unexpected statuses: 0, network errors: 0
