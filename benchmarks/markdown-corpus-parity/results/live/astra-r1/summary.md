# ANX versus strong Markdown live corpus smoke (markdown-corpus-parity-v1)

Status: **PASS**

Provider/model: codex / gpt-6-astra

| Arm | Completed | Task success | Answer concept recall | Document citation coverage | Citation precision | Median uncached input tokens | Median total tokens | Median tool calls | Median seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| anx | 6/6 | 100.0% | 100.0% | 100.0% | 64.7% | 19789 | 53497 | 2 | 17.58 |
| markdown | 6/6 | 100.0% | 100.0% | 100.0% | 71.1% | 19913 | 52893 | 3 | 19.74 |

One live repetition over six cross-document tasks compares agent behavior through equivalent deterministic corpus tools. It is a smoke test, not an enterprise-scale effect estimate or a universal ANX-versus-Markdown result.
