# AGN Developer Preview 0.2

Status: frozen developer-preview contract. This document is normative for the 0.2 conformance fixtures, but it is not a long-term 1.0 compatibility promise.

## 1. Scope

AGN is an open, single-file document container for a canonical structured document, deterministic human projections, stable agent targets, revision-checked transactions, retained sources, integrity metadata, and optional trust records. Studio is a reference application and is not part of the format requirement.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** describe conformance requirements.

## 2. Identity and container

- New files MUST use `.agn` and the internal media type `application/agn+zip`.
- The container MUST be ZIP-compatible and MUST contain `mimetype`, `manifest.json`, `document.json`, `revisions/transactions.jsonl`, and `views/document.html`.
- `document.json` is the only mutable content authority. HTML, PDF, Office, Markdown, JSONL, indexes, and thumbnails are projections.
- A reader MUST identify the format from validated internal metadata rather than the filename alone.
- A reader MAY accept the legacy `.andoc` media type during the pre-1.0 compatibility window, but a writer MUST emit the AGN identity.

## 3. Integrity and safe processing

- Every package entry except `mimetype` and `manifest.json` MUST be declared by path, role, media type, byte size, and SHA-256 in the manifest.
- Readers MUST perform container preflight before decompression and reject traversal, absolute paths, duplicate paths, encryption, multi-disk archives, unsupported ZIP64, undeclared entries, and declared expansion beyond their supported safety profile.
- Readers MUST validate manifest hashes and sizes before using canonical or executable-looking content.
- A previewer MUST treat all package content as untrusted, remove unsafe link schemes, and MUST NOT execute source documents, extension payloads, or package-provided scripts.
- The 0.2 reference safety profile is 96 MiB compressed, 256 MiB expanded, 64 MiB per entry, and 2,048 entries. A larger profile requires a separate identifier and streaming validation.

## 4. Canonical document

- The canonical schema identifier is `andoc.document.v1`; this legacy token remains stable for compatibility.
- A document MUST have an immutable `documentId`, a non-negative monotonically increasing `revision`, title, locale, timestamps, metadata, asset inventory, and ordered blocks.
- Every block, table cell, and nested list item MUST have a unique stable ID in one document-wide namespace.
- Core readers MUST support paragraphs, headings, lists, footnotes, tables, charts, images, page breaks, and declared extension fallbacks.
- Unknown optional extensions MUST be preserved on write and rendered through their core fallback. Unknown required capabilities MUST cause a conformance failure.
- Imported source bytes and unmodified assets MUST be byte-preserved across ordinary canonical transactions.

## 5. Transactions and synchronization

- Human and agent changes MUST use `andoc.transaction.v1` against an explicit `baseRevision`.
- A stale base revision MUST fail without mutation.
- A multi-operation transaction MUST either advance the document exactly one revision with one history record or write nothing.
- An accepted transaction MUST retain actor, time, message, typed operations, and sufficient inverse information for review or undo.
- Derived human and machine views MUST be regenerated from the accepted canonical revision. An exported or retained PDF MUST NOT become a second silently editable authority.
- Evidence-derived replacements such as OCR MUST retain source and candidate provenance and MUST NOT be promoted silently.

## 6. Profiles, finalization, and lineage

- `profiles/declaration.json` declares the core profile, domain profiles, extensions, and optional template reference.
- A finalization record signs a deterministic protected-entry root. Signature validity proves key possession; identity and organizational authority require verifier-owned trust policy.
- A finalized package MUST reject ordinary edits. Continued work MUST derive a new draft with explicit embedded or reference lineage.
- Trusted timestamps, transparency logs, C2PA, and blockchain receipts MAY extend the trust record but do not replace canonical revision history.

## 7. Conformance classes

Conformance is cumulative:

| Class | Name | Minimum behavior |
| --- | --- | --- |
| AGN-C1 | Store | Preserve exact bytes and enforce package safety/integrity checks. |
| AGN-C2 | Preview | Meet C1 and render a safe read-only human projection with revision/finalization disclosure. |
| AGN-C3 | Index | Meet C2 and expose canonical text, stable IDs, provenance, revision, and history for search/citation. |
| AGN-C4 | Map | Meet C3 and project stable AGN nodes to durable external object IDs with a mapping manifest. |
| AGN-C5 | Edit | Meet C4 and translate external edits into previewed, revision-checked AGN transactions with conflict and inverse semantics. |

Implementations MUST claim only the highest class they pass. The reference `agn conformance` runner covers C1-C3. C4 and C5 require adapter-specific fixtures.

## 8. Version and compatibility policy

- Container `formatVersion`, canonical schema IDs, transaction schema IDs, and profile/extension versions are independently versioned.
- Readers MUST reject unsupported required major versions unless an explicit migration exists.
- Writers MUST preserve unknown optional extension envelopes byte-semantically, including their readable fallback.
- A normative change to required package entries, transaction semantics, stable-ID behavior, or integrity processing requires a new developer-preview revision and fixtures.
- AGN 1.0 will be declared only after independent-reader, migration, conformance, security, and governance gates pass.

## 9. Reference assets

- Detailed format notes: [`../docs/format-spec.md`](../docs/format-spec.md)
- Interoperability contract: [`../docs/interoperability.md`](../docs/interoperability.md)
- JSON Schemas: [`../schemas`](../schemas)
- Executable conformance guidance and fixtures: [`../conformance`](../conformance)
- Reference standalone reader: `agn view <document.agn> [port]`
- Reference conformance runner: `agn conformance <document.agn> [AGN-C1|AGN-C2|AGN-C3]`

## 10. Explicit non-claims

Developer Preview 0.2 does not establish universal PDF fidelity, universal OCR accuracy, legal non-repudiation, platform-independent C5 editing, demand, or permanent 1.0 compatibility. Those require their named evidence and governance gates.
