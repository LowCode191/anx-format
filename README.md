<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/anx-lockup-dark.svg">
  <img src="brand/anx-lockup-light.svg" width="264" alt="ANX format">
</picture>

# The ANX format (Agent Native eXtensible)

One file that people and software agents can read, cite, review and change safely.

An ANX document (`.anx`, media type `application/anx+zip`) is an open, portable, single-file package that keeps together:

- a canonical structured document (`document.json`) with stable node IDs for every block, table cell and list item;
- the retained original source (PDF, DOCX, PPTX or XLSX) as immutable evidence;
- content-addressed assets, provenance and typed page-object evidence;
- a deterministic human view and an ordered transaction history;
- integrity metadata, optional profiles, Ed25519 finalization records and version lineage.

Humans and agents edit the same canonical document through one revision-checked transaction contract. HTML, PDF, DOCX, Markdown and JSONL are projections, never a second editable authority. A stale write fails with a structured conflict instead of a lost update.

This repository is the reference implementation: the core SDK, the `anx` CLI, the conformance runner, a read-only viewer, two MCP servers, the JSON Schemas, the Developer Preview contract and the local reference importer. Studio, the reference desktop application, is a separate package and is not published here yet.

## Status

**Developer Preview 0.4 line.** This is a technical-evaluation release, not ANX 1.0.

- The frozen contract is [spec/ANX-DEV-PREVIEW-0.4.md](spec/ANX-DEV-PREVIEW-0.4.md). Conformance classes ANX-C1 through C3 are executable here (`anx conformance`).
- Schemas added after the 0.4 freeze (document relationships, source baselines, region corrections, agent response, execution and attestation records) are implemented and described in [docs/format-spec.md](docs/format-spec.md) but are not yet part of a frozen contract. A 0.5 contract will enumerate them.
- There is no independent second implementation yet. Building one against the conformance fixtures is the most useful contribution we can think of.
- No IANA media-type registration has been made. The `.anx` suffix is also used by other formats (HotDocs answer files, IBM i2 Analyst's Notebook exchange files, and the defunct Annodex media container); readers identify the ANX format from the package's internal `mimetype` and manifest, never from the file name, and the project claims no rights in the bare word "ANX". Refer to it as "the ANX format" or by the package name `anx-format`.

What the retained evidence supports: ANX is a portable, agent-readable document package that keeps structured content, source evidence, stable references and revision history together. Its reference tools enforce validated, revision-checked operations and can reduce retrieval overhead in bounded workflows.

What it does not support: a universal accuracy or cost advantage over well-prepared Markdown, the idea that citations prove every sentence, any claim that documents cannot leak, production security clearance, or market demand. Comparisons against strong Markdown with equivalent metadata came out at parity in the retained runs.

## Requirements

- Node.js 22.13 or newer.
- Optional, for `import-document`, `import-pdf` and OCR candidates: Python 3.10+ with `pip install "docling[rapidocr]"`. The `docling` CLI must be on `PATH` or named by `ANX_DOCLING_BIN`.

Docling conversion is memory-hungry: a 209-page report peaked at 6.9 GiB of resident memory in our measurements. Plan for 8 GB of free RAM or lower `ANX_DOCLING_PAGE_BATCH_SIZE`.

## Install

From a checkout:

```bash
npm ci
npm run check
```

`npm run check` builds `dist/` and runs the test suite. Until the package is published to npm, run the CLI with `node dist/cli.js` or `npm run anx --`.

## Quick start

```bash
# make a package from a canonical document and validate it
node dist/cli.js pack examples/sample.document.json output/sample.anx
node dist/cli.js validate output/sample.anx
node dist/cli.js conformance output/sample.anx ANX-C3

# read like an agent: outline, search, stable citations
node dist/cli.js outline examples/sample.anx 10
node dist/cli.js search examples/sample.anx "agent" 5
node dist/cli.js cite examples/sample.anx heading-1

# legacy identities (.anxd, .agn, .andoc) still read; new writes use .anx
node dist/cli.js migrate examples/pdf-media-fixture.agn output/pdf-media-fixture.anx
node dist/cli.js export-markdown output/pdf-media-fixture.anx output/pdf-media-fixture.md

# open the read-only viewer on loopback
node dist/cli.js view output/pdf-media-fixture.anx 8787

# import a source document (needs Docling)
node dist/cli.js import-document path/to/report.pdf output/report.anx
```

Run `node dist/cli.js` without arguments for the full command list, including preview/apply transactions, image insertion, profiles, finalization, cosigning, lineage verification, semantic diff and the portable exports.

## MCP servers

Two stdio servers are included:

- `anx-mcp`: the full agent surface (open, query, outline, get, search, cite, context, page and table evidence, regions, text-quality, OCR candidates, review status and proposals, transaction preview and apply, image insertion, PDF export, finalization and lineage verification). Mutating tools require the expected revision returned by a preceding read.
- `anx-evidence-mcp`: a compact read-only evidence profile for retrieval-style clients.

Example client configuration:

```json
{
  "mcpServers": {
    "anx": {
      "command": "node",
      "args": ["/path/to/anx-format/dist/mcp-server.js"],
      "env": { "ANX_ALLOWED_ROOT": "/path/to/your/documents" }
    }
  }
}
```

Paths outside `ANX_ALLOWED_ROOT` are refused. The servers never accept private signing keys; finalization and cosigning are local CLI operations.

## SDK

```ts
import { readAnx, validateAnx, anxOutline, transactAnxPackage } from 'anx-format'

const pkg = await readAnx('examples/sample.anx')
const report = await validateAnx(pkg)
const outline = await anxOutline('examples/sample.anx', 20)
```

`Andoc*` and `Agn*` function names remain exported for source compatibility through the pre-1.0 transition; the `anx*` names are canonical.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANX_ALLOWED_ROOT` | Directory the MCP servers may read and write (default: current directory) |
| `ANX_DOCLING_BIN` | Path to the Docling CLI when it is not on `PATH` |
| `ANX_DOCLING_PAGE_BATCH_SIZE`, `ANX_DOCLING_THREADS` | Conversion batch size (default 4) and threads (default 2) |
| `ANX_DOCLING_VERSION` | Override the Docling version recorded in provenance |
| `ANX_OCR_ENGINE`, `ANX_OCR_PYTHON`, `ANX_OCR_PAGE_BATCH_SIZE` | Selective OCR engine (default `rapidocr`), Python interpreter and page batch |
| `ANX_MCP_TOOL_PROFILE` | Tool profile for the evidence server |
| `ANX_EVIDENCE_TRACE_PATH`, `ANX_REQUIRE_EVIDENCE_TRACE` | Optional evidence trace file for agent reads |

Legacy `AGN_*` and `ANDOC_*` names are still read.

## Conformance classes

| Class | Name | Minimum behavior |
| --- | --- | --- |
| ANX-C1 | Store | Preserve exact bytes and enforce package safety and integrity checks |
| ANX-C2 | Preview | C1 plus a safe read-only human projection with revision and finalization disclosure |
| ANX-C3 | Index | C2 plus canonical text, stable IDs, provenance, revision and history for search and citation |
| ANX-C4 | Map | C3 plus a mapping manifest to durable external object IDs |
| ANX-C5 | Edit | C4 plus external edits translated into previewed, revision-checked transactions |

The reference runner covers C1 to C3. C4 and C5 need adapter-specific fixtures. See [docs/interoperability.md](docs/interoperability.md) and [conformance/README.md](conformance/README.md).

## Safety profile

Every package is treated as hostile input. Readers reject traversal, absolute paths, duplicate or undeclared entries, hash and size mismatches, encrypted entries, multi-disk archives, ZIP64 and declared expansion beyond the 0.4 profile (96 MiB compressed, 256 MiB expanded, 64 MiB per entry, 2,048 entries) before decompression. The viewer binds to loopback only. OCR candidates are never promoted into canonical content automatically. See [SECURITY.md](SECURITY.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `spec/` | Frozen Developer Preview contracts (0.4 normative; 0.3 and 0.2 kept for history) |
| `schemas/` | JSON Schemas for the document, manifest, transactions, profiles, finalization, lineage, trust store, relationships, source baselines, region corrections and agent records |
| `conformance/` | Executable conformance guidance and fixtures |
| `docs/` | Format notes, interoperability contract, product boundary, governance, profiles and finalization, migrations |
| `src/` | Core SDK, importer, agent tools, CLI, viewer and MCP servers |
| `test/` | Product tests with self-made fixtures |
| `examples/` | Sample packages in the current and legacy identities, profiles, policies |
| `config/`, `scripts/` | Pinned OCR engine policy, the RapidOCR bridge and the SBOM generator |

## Roadmap

1. Freeze a 0.5 contract covering the schemas added since 0.4.
2. Obtain one independent reader implementation and run hostile-package fuzzing.
3. Expand the conformance fixture set, including malformed and hostile packages.
4. Publish Studio, the reference human application, as a separate package.

The governance model, compatibility policy and 1.0 gates are in [docs/open-format-governance.md](docs/open-format-governance.md). The product boundary that decides what belongs in the format, in Studio, in an importer or outside is in [docs/product-boundary.md](docs/product-boundary.md).

## Licensing

Source code, JSON Schemas, fixtures, examples and scripts are licensed under the [Apache License 2.0](LICENSE). The specification and documentation prose under `spec/` and `docs/` are licensed under [CC BY 4.0](LICENSE-CC-BY-4.0). Docling and RapidOCR are separately installed local programs and are not bundled.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, the proposal process and good first contributions, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
