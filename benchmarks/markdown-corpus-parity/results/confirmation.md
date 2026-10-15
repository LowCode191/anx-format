# ANX versus strong Markdown corpus confirmation (markdown-corpus-parity-v1)

Status: **PASS**  
Observation: **parity-observed**

## Adjudicated live result

| Model | Arm | Task success | Correct answers | Protocol failures | Concept recall | Citation resolution | Required-document citation coverage | Citation precision | Median uncached input | Median total tokens | Median tool calls | Median seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gpt-5.6-luna | anx | 12/12 | 12/12 | 0 | 100.0% | 100.0% | 100.0% | 78.5% | 23536 | 65753 | 3 | 14.36 |
| gpt-5.6-luna | markdown | 11/12 | 12/12 | 1 | 100.0% | 100.0% | 100.0% | 75.8% | 20150 | 70929 | 3 | 13.9 |
| gpt-5.6-sol | anx | 6/6 | 6/6 | 0 | 100.0% | 100.0% | 100.0% | 82.2% | 20587 | 51890 | 3 | 17.04 |
| gpt-5.6-sol | markdown | 6/6 | 6/6 | 0 | 100.0% | 100.0% | 100.0% | 76.7% | 20918 | 69258 | 3 | 19.63 |
| gpt-6-astra | anx | 6/6 | 6/6 | 0 | 100.0% | 100.0% | 100.0% | 64.7% | 19789 | 53497 | 2 | 17.58 |
| gpt-6-astra | markdown | 6/6 | 6/6 | 0 | 100.0% | 100.0% | 100.0% | 71.1% | 19913 | 52893 | 3 | 19.74 |

Task success requires a completed trial within the eight-iteration protocol, every required answer concept, every citation resolving, and a citation from every required document (and relationship, where one is required). Correct answers counts trials whose answer contained every required concept regardless of protocol; protocol failures are trials that exceeded the iteration limit, ran a disallowed command, or returned no parseable answer.

## Runs

- luna-r1: codex / gpt-5.6-luna, 11/12 trials completed within protocol, run status HOLD, 2026-10-15T16:05:43.478Z.
- sol-r1: codex / gpt-5.6-sol, 12/12 trials completed within protocol, run status PASS, 2026-10-15T16:08:07.589Z.
- astra-r1: codex / gpt-6-astra, 12/12 trials completed within protocol, run status PASS, 2026-10-15T16:10:26.247Z.
- luna-r2: codex / gpt-5.6-luna, 12/12 trials completed within protocol, run status PASS, 2026-10-15T16:12:06.334Z.

## Deterministic qualification

Status PASS (10/10 gates). Both arms search the same canonical text with the same lexical ranker; see results/qualification.md.

## Claim boundary

This confirmation pools 4 live run(s) over 6 adjudicated cross-document tasks with 12 public documents. It does not establish enterprise-scale performance, universal format parity, production latency, cost, security, or market demand.
