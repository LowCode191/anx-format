# ANX versus strong Markdown live corpus smoke (markdown-corpus-parity-v1)

Status: **PASS**

Provider/model: codex / gpt-5.6-luna

| Arm | Completed | Task success | Answer concept recall | Document citation coverage | Citation precision | Median uncached input tokens | Median total tokens | Median tool calls | Median seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| anx | 6/6 | 100.0% | 100.0% | 100.0% | 77.8% | 16043 | 46992 | 3 | 11.28 |
| markdown | 6/6 | 100.0% | 100.0% | 100.0% | 75.0% | 12401 | 63949 | 3 | 13.08 |

One live repetition over six cross-document tasks compares agent behavior through equivalent deterministic corpus tools. It is a smoke test, not an enterprise-scale effect estimate or a universal ANX-versus-Markdown result.
