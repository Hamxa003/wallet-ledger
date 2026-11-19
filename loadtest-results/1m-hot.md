Scenario hot: 100 connections over 4 threads, 5s warmup then 30s measured, against http://localhost:8080

| Endpoint | Requests | Req/s | p50 ms | p90 ms | p99 ms | max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
| balance (hot user) | 70134 | 2338 | 3.18 | 4.37 | 7.68 | 22.90 | 200: 70134 |
| balance (other users) | 223342 | 7445 | 3.15 | 4.31 | 7.63 | 31.46 | 200: 223342 |
| credit (hot user) | 175925 | 5864 | 4.26 | 5.91 | 10.00 | 27.19 | 200: 175925 |
| credit (other users) | 133219 | 4441 | 3.22 | 4.41 | 7.77 | 30.56 | 200: 133219 |
| debit (hot user) | 106013 | 3534 | 4.25 | 5.91 | 10.02 | 24.56 | 200: 106013 |
| debit (other users) | 88919 | 2964 | 3.22 | 4.44 | 7.81 | 31.47 | 200: 88882, 409: 37 |

Total 797552 requests (26585 req/s), unexpected statuses: 0, network errors: 0
