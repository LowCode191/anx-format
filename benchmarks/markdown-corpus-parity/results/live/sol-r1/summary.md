# ANX versus strong Markdown live corpus smoke (markdown-corpus-parity-v1)

Status: **PASS**

Provider/model: codex / gpt-5.6-sol

| Arm | Completed | Task success | Answer concept recall | Document citation coverage | Citation precision | Median uncached input tokens | Median total tokens | Median tool calls | Median seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| anx | 6/6 | 100.0% | 100.0% | 100.0% | 82.2% | 20587 | 51890 | 3 | 17.04 |
| markdown | 6/6 | 100.0% | 100.0% | 100.0% | 76.7% | 20918 | 69258 | 3 | 19.63 |

One live repetition over six cross-document tasks compares agent behavior through equivalent deterministic corpus tools. It is a smoke test, not an enterprise-scale effect estimate or a universal ANX-versus-Markdown result.
