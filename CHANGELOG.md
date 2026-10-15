# Changelog

## 0.4.1 — importer fixes and the public parity benchmark

- Importer: page-break block ids stay unique when an Office source reports non-monotonic page numbers. DOCX files whose tables or lists were attributed to earlier pages previously failed validation with duplicate `page-break-…` ids. Regression test added.
- Importer: new `ANX_DOCLING_TIMEOUT_SECONDS` (default 240, maximum 600) so long reports can be imported on slower machines without editing code.
- Benchmark: `benchmarks/markdown-corpus-parity/` is a reproducible comparison of a repository of ANX files against a strong Markdown repository built from the same canonical text, on twelve freely downloadable public documents. It ships the corpus manifest with checksums, fetch and import scripts, frozen tasks, deterministic qualification, a live stage for fresh CLI model sessions, an adjudicator and the retained results. CI type-checks the harness (`npm run check:benchmarks`).
- README: CI badge, a Testing and evidence section, and a pointer to the benchmark results.

## 0.4.0 — first public developer preview

Extracted from the private development line of the format. Contents:

- `.anx` package format with `application/anx+zip` identity and read compatibility for the legacy `.anxd`, `.agn` and `.andoc` identities.
- Canonical `andoc.document.v1` model, `andoc.transaction.v1` edit contract, manifest, profiles, finalization, lineage and trust-store schemas, plus the post-0.4 relationships, source-baseline, region-corrections and agent record schemas.
- Reference SDK: package reader and writer with hostile-container preflight, validator, deterministic HTML, PDF, DOCX, Markdown and JSONL projections, transaction engine with cross-process locking and structured conflicts, profiles, Ed25519 finalization and lineage verification, semantic diff.
- Local reference importer for PDF, DOCX, PPTX and XLSX through Docling, deterministic PDF text-quality diagnostics, typed page-object evidence and selective RapidOCR candidate generation that never changes canonical content automatically.
- `anx` CLI, read-only viewer, ANX-C1 to C3 conformance runner, `anx-mcp` and `anx-evidence-mcp` stdio servers.
- Test fixtures are self-made or derived from US government publications; no third-party commercial documents are embedded.
- Developer Preview contracts 0.2, 0.3 and 0.4 with the 0.4 contract as the frozen reference.
