# Changelog

## 0.4.2 — security fixes

Five gaps between what the reference implementation enforced and what the 0.4 contract and SECURITY.md say. None changes the package format, and packages written by 0.4.1 still read.

- Viewer: `anx view` served the package's stored `views/document.html` as it was. That file is written by whoever made the package, so a hostile package could run script on the viewer's loopback origin. The viewer now renders the view from the validated `document.json` on start and never serves the stored one. The view is sent with a Content-Security-Policy that allows only the renderer's own script by hash, inside a sandbox with an opaque origin. Other responses get an inert policy. Assets keep their declared type only for PNG, JPEG, GIF, WebP and SVG; anything else is a download. Requests whose `Host` is not a loopback name on the listening port are refused, which stops DNS rebinding. `StandaloneViewerOptions.allowedHosts` names extra hosts for a deliberate non-loopback bind.
- Stored view: the validator checks the stored view's hash but not that it shows the canonical content. `humanViewStatus(pkg)` now compares it with a fresh render, `anx validate` prints the result, and finalization verification reports `humanViewMatchesCanonical`. A differing view is reported, not rejected, because packages written by earlier versions carry such views. `packAnx` now renders the view from the canonical serialization, so packages written from this version on match.
- Validation: a package without `revisions/transactions.jsonl` or `views/document.html` now fails with `missing_required_entry`. The contract has always required both.
- Transactions: release state, review approvals and decisions, human-approved relationships and human page-object corrections live in document metadata, and any transaction could rewrite them, including one from the agent tools or the MCP server. `applyTransaction` now refuses those changes from a non-human actor with `ProtectedMetadataError` (`PROTECTED_METADATA`). An agent can still add review proposals and annotations under its own name and add or revise `agent-suggested` relationships. The rule gates new writes only: stored history replays as recorded, so a package whose history already holds such a change from an agent, system or import actor still reads. A change made that way under an earlier version is not undone or flagged; the history shows which actor wrote it. The actor type is asserted by the writer, so this closes the agent tool path; signatures checked against a trust store remain the control against a hostile writer.
- MCP servers: path confinement compared written paths only, so a symbolic link inside `ANX_ALLOWED_ROOT` reached files outside it. Both servers now also resolve links, including for output files that do not exist yet. `anx-evidence-mcp` now resolves relative paths against `ANX_ALLOWED_ROOT`, as `anx-mcp` does, where it used the working directory before.
- Both MCP servers report the package version.

Not changed here, and still open: canonical JSON is not yet specified and sorts keys by locale; several writers do not write atomically; the conformance runner's checks are weak. These need a 0.5 contract or larger changes.

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
