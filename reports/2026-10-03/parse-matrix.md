# parse matrix, 2026-10-03

46 cases × 3 runs, measured; 10 of 11 variants run.
Prompts: identify fae24511, parse 23abf308.

| variant | model | effort | strategy | accuracy | cases failed | p50 | p90 | cost / cart | cost / 1,000 carts | errors |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| luna-low | gpt-6-luna | low | parse + identify | 135 / 138 (98 %) | 1 | 1207 ms | 2724 ms | $0.000171 | $0.171 | 0 |
| luna-minimal | gpt-6-luna | minimal | parse + identify | 135 / 138 (98 %) | 1 | 1169 ms | 2474 ms | $0.000171 | $0.171 | 0 |
| luna-none | gpt-6-luna | none | parse + identify | 137 / 138 (99 %) | 1 | 2175 ms | 3206 ms | $0.000187 | $0.187 | 0 |
| luna-pro-low | gpt-6-luna-pro | low | parse + identify | 135 / 138 (98 %) | 1 | 2157 ms | 3338 ms | $0.000368 | $0.368 | 0 |
| gemini-3.1-flash-lite | gemini-3.1-flash-lite | low | parse + identify | 130 / 138 (94 %) | 3 | 1685 ms | 2074 ms | $0.000517 | $0.517 | 0 |
| deepseek-v4.1-flash | deepseek-v4.1-flash | low | parse + identify | 138 / 138 (100 %) | 0 | 2976 ms | 11074 ms | $0.000346 | $0.346 | 0 |
| schematron-v2-small | schematron-v2-small | none | parse + identify | 52 / 137 (38 %) | 41 | 583 ms | 1606 ms | $0.000119 | $0.119 | 1 |
| nex-n2.5-mini | nex-n2.5-mini | low | parse + identify | 111 / 133 (83 %) | 19 | 2333 ms | 8649 ms | $0.000128 | $0.128 | 5 |
| local-llama3.2-3b | llama3.2:3b (local) | none | parse + identify | 59 / 138 (43 %) | 40 | 6248 ms | 9913 ms | $0.000093 | $0.093 | 0 |
| local-qwen2.5-14b | qwen2.5:14b-instruct-q4_K_M (local) | none | parse + identify | — | 46 | 8324 ms | 29576 ms | $0.000096 | $0.096 | 0 |
