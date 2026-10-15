# ANX versus strong Markdown live corpus smoke (markdown-corpus-parity-v1)

Status: **HOLD**

Provider/model: codex / gpt-5.6-luna

| Arm | Completed | Task success | Answer concept recall | Document citation coverage | Citation precision | Median uncached input tokens | Median total tokens | Median tool calls | Median seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| anx | 6/6 | 100.0% | 100.0% | 100.0% | 79.2% | 23557 | 65753 | 3 | 14.36 |
| markdown | 5/6 | 100.0% | 100.0% | 100.0% | 76.7% | 21791 | 70929 | 3 | 13.90 |

One live repetition over six cross-document tasks compares agent behavior through equivalent deterministic corpus tools. It is a smoke test, not an enterprise-scale effect estimate or a universal ANX-versus-Markdown result.
