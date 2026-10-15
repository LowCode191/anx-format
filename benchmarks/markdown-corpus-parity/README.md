# ANX versus strong Markdown: corpus parity benchmark

This regime tests the ANX format as a repository document type: many independent `.anx` files queried as one corpus, compared with a strong Markdown repository generated from the same canonical content. It exists to make one sentence in the top-level README reproducible: against well-prepared Markdown with equivalent metadata, ANX came out at parity on ordinary corpus retrieval and cross-document answering.

It is not a leaderboard and it does not try to show that ANX retrieves better. The deterministic stage qualifies both transports; the live stage reports what fresh model sessions did with identical tools.

## Corpus

Twelve freely downloadable public documents, fetched from their publishers by `fetch-corpus.mjs` and verified by SHA-256 against [corpus/manifest.json](corpus/manifest.json). The source files are not redistributed in this repository. The retained results and transcripts do quote the passages the corpus tools returned, so the manifest records the rights basis for every document: United States government works (public domain), California Department of Education publications (public records), and two arXiv papers published under CC BY 4.0, with the attribution that licence requires.

| ID | Document | Publisher | Format | Pages |
| --- | --- | --- | --- | ---: |
| doc-001 | Monetary Policy Report June 2025 | Federal Reserve Board | PDF | 81 |
| doc-002 | AI Risk Management Framework (AI RMF 1.0) | NIST | PDF | 48 |
| doc-003 | Docling Technical Report (arXiv 2408.09869v5) | arXiv (IBM Research) | PDF | 9 |
| doc-004 | SmolDocling (arXiv 2503.11576v1) | arXiv (IBM Research and Hugging Face) | PDF | 24 |
| doc-005 | 2025 Annual Report of Waiver Activity | California Department of Education | DOCX | 10 |
| doc-006 | 2024 Annual Report of Waiver Activity | California Department of Education | DOCX | 10 |
| doc-007 | 2023-24 Transitional Kindergarten Teachers of Early Enrollment Children | California Department of Education | DOCX | 33 |
| doc-008 | 2024-25 Transitional Kindergarten Teachers of Early Enrollment Children | California Department of Education | DOCX | 31 |
| doc-009 | Monetary Policy Report February 2025 | Federal Reserve Board | PDF | 83 |
| doc-010 | AI RMF Generative Artificial Intelligence Profile (NIST AI 600-1) | NIST | PDF | 64 |
| doc-011 | Secure Software Development Framework (SSDF) Version 1.1 (NIST SP 800-218) | NIST | PDF | 36 |
| doc-012 | Technology Readiness Assessment Best Practices Guide (NASA/SP-20205003605) | NASA | PDF | 41 |

Four declared benchmark-series relationships are supplied equally to both arms: the 2025 waiver report supersedes the 2024 report, the 2024-25 kindergarten report supersedes the 2023-24 report, the June 2025 Monetary Policy Report supersedes the February 2025 report, and the Generative AI Profile is derived from AI RMF 1.0.

Share of each document's canonical text that appears verbatim somewhere in `results/` (qualification hits plus every tool output stored in the live transcripts), so readers know what the repository carries:

| Document | Quoted share |
| --- | ---: |
| doc-001 Monetary Policy Report June 2025 | 25% |
| doc-002 AI RMF 1.0 | 17% |
| doc-003 Docling Technical Report | 34% |
| doc-004 SmolDocling | 20% |
| doc-005 Waiver report 2025 | 22% |
| doc-006 Waiver report 2024 | 23% |
| doc-007 TK report 2023-24 | 34% |
| doc-008 TK report 2024-25 | 38% |
| doc-009 Monetary Policy Report February 2025 | 27% |
| doc-010 Generative AI Profile | 67% |
| doc-011 SSDF 1.1 | 24% |
| doc-012 NASA TRA guide | 40% |

The Generative AI Profile is high because the twelve-risk task made every model page through its risk section. Nothing is quoted from any document outside the corpus.

The corpus was chosen for public availability, scriptable download, mixed layouts (long reports with charts and tables, research papers, short DOCX reports) and natural document pairs. It contains no personal, employment, customer or contract material and nothing from the energy sector.

## Arms

- **anx-native-corpus**: typed ANX blocks, document metadata, revision-pinned stable citations (`anx://<document>/revisions/<n>/blocks/<id>`) and typed relationship edges carried with the document.
- **markdown-strong-corpus**: one GFM file per document exported from the same package, with YAML-style frontmatter, the same declared relationships and page-independent file/line citations (`markdown://<document>/<file>#L<start>-L<end>`). It is deliberately stronger than loose `.md` files.

Both arms index the same canonical text with the same deterministic BM25-style lexical ranker, the same retrieval limit (12) and per-document cap (4). No embeddings are used. See [contract.json](contract.json) for the frozen controls and claim boundary.

## Tasks

[tasks.json](tasks.json) freezes 24 single-document discovery tasks (two per document), six cross-document tasks (two numeric comparisons across report editions, two syntheses across unrelated documents, two relationship-and-current-edition tasks) and the four relationships. Every evidence fragment is checked against the imported corpus by `verify-tasks.ts`, so a task can never point at text the packages do not contain.

Task success in the live stage requires every required answer concept, every citation resolving to indexed evidence, and a citation from every required document and relationship.

## Stages

1. **Prepare** (`prepare-corpus.ts`): import each source once with the reference CLI (`anx import-document`, Docling underneath) and record import cost, validation and package hashes in `results/preparation.json`.
2. **Qualify** (`run-qualification.ts`): build both arms, score all 30 tasks at retrieval depth 12, check citation resolution, relationship traversal, byte-identical replay and a 240-logical-document scale probe, then write the runtime indexes. Ten gates; PASS qualifies the transport only.
3. **Live** (`run-live-smoke.ts`): for each cross-document task and arm, start a fresh vanilla CLI model session (Codex or Claude Code) with no harness, memory, project files or web access. The session may run only the corpus tool (`search`, `search-document`, `get`, `relationships`, `documents`), through a generated launcher in a clean temporary directory, with at most eight iterations. Answers must follow [answer.schema.json](answer.schema.json). Transcripts are stored with local paths redacted.
4. **Adjudicate** (`adjudicate.ts`): pool the named runs per model and arm into `results/confirmation.{json,md}`.

## Reproduce

Requirements: Node 22+, Python 3.10+ with `docling` on `PATH` (see the top-level README), roughly 8 GB of free memory, and for the live stage a logged-in `codex` or `claude` CLI.

```bash
npm ci
npm run benchmark:parity:fetch
ANX_DOCLING_TIMEOUT_SECONDS=600 npm run benchmark:parity:prepare
npm run benchmark:parity:verify-tasks
npm run benchmark:parity:qualify
npm run benchmark:parity:live -- --provider codex --model gpt-5.6-sol --run-label my-gpt-5-6-sol --confirm-live
npm run benchmark:parity:adjudicate -- --runs my-gpt-5-6-sol
```

Import takes a few minutes per long report. Re-running `prepare` reuses existing packages; pass `--force` to rebuild. Docling versions change layout output slightly, so a fresh import can move evidence recall by a few points; the package hashes of the retained run are in `results/preparation.json`.

## Retained results

Run on 2026-10-15 with Docling 2.76.0 (docling-core 2.66.0, docling-ibm-models 3.11.0, docling-parse 5.4.0; Python 3.12.0; macOS on Apple silicon) on Node v26.4.0 and the Codex CLI. Preparation: 12/12 documents imported, 470 source pages, median import 20 s, peak resident memory 11.7 GB ([preparation.json](results/preparation.json)).

### Deterministic qualification: PASS (10/10 gates)

| Arm | Documents | Evidence units | Discovery document recall@12 | Discovery evidence recall@12 | Cross-document recall@12 | Relationship recall@12 | Citation resolution | Median query ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| anx-native-corpus | 12 | 3976 | 100.0% | 69.8% | 100.0% | 50.0% | 100.0% | 27.2 |
| markdown-strong-corpus | 12 | 4021 | 100.0% | 67.7% | 100.0% | 50.0% | 100.0% | 30.7 |

Both arms return the required documents for every task and every citation resolves. Evidence recall at depth 12 is a property of the shared lexical ranker, not of either format: the same tasks miss in both arms (the waiver tables rank below the paragraph text, and the Monetary Policy Report relationship edge ranks below the reports' own passages under the per-document cap). The 240-logical-document probe ran 30 queries per arm at a median of 27.4 ms (ANX) and 31.1 ms (Markdown). Full record: [qualification.md](results/qualification.md).

### Live answer smoke: PASS (parity-observed)

| Model | Arm | Task success | Correct answers | Protocol failures | Citation resolution | Citation precision | Median uncached input tokens | Median total tokens | Median tool calls | Median seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gpt-5.6-luna | anx | 12/12 | 12/12 | 0 | 100.0% | 78.5% | 23536 | 65753 | 3 | 14.4 |
| gpt-5.6-luna | markdown | 11/12 | 12/12 | 1 | 100.0% | 75.8% | 20150 | 70929 | 3 | 13.9 |
| gpt-5.6-sol | anx | 6/6 | 6/6 | 0 | 100.0% | 82.2% | 20587 | 51890 | 3 | 17.0 |
| gpt-5.6-sol | markdown | 6/6 | 6/6 | 0 | 100.0% | 76.7% | 20918 | 69258 | 3 | 19.6 |
| gpt-6-astra | anx | 6/6 | 6/6 | 0 | 100.0% | 64.7% | 19789 | 53497 | 2 | 17.6 |
| gpt-6-astra | markdown | 6/6 | 6/6 | 0 | 100.0% | 71.1% | 19913 | 52893 | 3 | 19.7 |

Task success requires a completed trial within the eight-iteration protocol, every required answer concept, every citation resolving, and a citation from every required document and relationship. Correct answers counts trials whose answer contained every required concept regardless of protocol. Citation precision is measured against the frozen evidence fragments, so a resolving citation to a neighbouring block counts as imprecise in both arms. The direction of the token, tool-call, latency and citation-precision differences changes from model to model (gpt-6-astra cited more precisely through Markdown, gpt-5.6-sol and gpt-5.6-luna through ANX), so no stable efficiency winner is established. The one protocol failure was a gpt-5.6-luna Markdown-arm trial that answered the twelve-risk task correctly but needed twelve iterations to collect the list.

Full record: [confirmation.md](results/confirmation.md); per-trial prompts, responses and redacted transcripts are under [results/live/](results/live/).

## Claim boundary

Twelve real documents, 30 frozen tasks, a 240-logical-document probe made of archived copies, and a handful of live runs do not establish enterprise-scale performance, vector-search quality, access-control behaviour, human usability, parser quality in general, production latency or cost. They do not show that either format is universally better. Strong Markdown needed frontmatter, relationship conventions, citation generation, an index and controlled tools outside the files; ANX carried typed structure, revision identity and relationships inside the document. This regime does not isolate the maintenance or governance cost of either approach.
