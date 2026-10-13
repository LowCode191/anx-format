# ANX Format Specification 0.4

Status: verified 0.4 implementation notes. The normative developer-preview contract is [ANX Developer Preview 0.4](../spec/ANX-DEV-PREVIEW-0.4.md); neither document is yet a long-term 1.0 compatibility promise. [Developer Preview 0.3](../spec/ANX-DEV-PREVIEW-0.3.md) and [Developer Preview 0.2](../spec/AGN-DEV-PREVIEW-0.2.md) remain immutable historical context.

## Design rule

An ANX document has one editable source of truth: `document.json`. The human view, agent context, search chunks, PDF, and Office exports are projections of that canonical model. Human and agent edits both enter as validated transactions against stable block IDs.

Changing an exported PDF does not silently mutate the ANX document. An edited PDF must be re-imported and reconciled as an explicit transaction because arbitrary PDF drawing operations do not carry enough semantic intent for a lossless reverse edit.

## Container

The `.anx` extension is a ZIP-compatible single-file package with media type `application/anx+zip`.

Readers identify the package from its internal `mimetype` and manifest rather than trusting the filename alone. During the pre-1.0 migration, readers also accept legacy `.anxd` files carrying `application/anx+zip`, `.agn` files carrying `application/agn+zip`, and `.andoc` files carrying `application/vnd.andoc+zip`; all new writes use `.anx` and `application/anx+zip`. See [the `.anxd`-to-`.anx` migration contract](migration-anxd-to-anx.md).

Required entries:

| Path | Role |
| --- | --- |
| `mimetype` | Exact media type marker |
| `manifest.json` | Package inventory, hashes, sizes, and roles |
| `document.json` | Canonical `andoc.document.v1` model |
| `revisions/transactions.jsonl` | Ordered human, agent, import, and system transactions |
| `views/document.html` | Deterministic human-readable projection |

Optional entries:

| Path | Role |
| --- | --- |
| `assets/**` | Images, chart data, fonts, and embedded binary assets |
| `sources/**` | Original import sources or provenance companions |
| `profiles/declaration.json` | Core, domain-profile, extension, and template capability declaration |
| `lineage/record.json` | Structured link to an embedded or externally referenced finalized parent version |
| `finalizations/records.json` | Signed protected-content roots and approval policy state |
| `versions/baseline.document.json` | Integrity-checked canonical baseline used with transaction history to reconstruct stored versions |
| `sources/provenance/source-baselines.json` | Signed organizational designation of exact retained source bytes |

## Source baseline registration

Imported files begin as **unverified sources**. ANX does not infer that a PDF,
Office file, scan, or download is the publisher's original, latest, authentic,
legally authoritative, or redistributable copy.

An organization may explicitly register one retained `sources/original/**`
entry as its controlled source baseline. The `anx.source-baseline.v1` record
binds:

- the ANX document ID and internal revision at registration;
- the exact retained path, file name, media type, SHA-256, and byte size;
- a stable human registrar, registration time, organization, title,
  publisher/edition description, and acquisition metadata;
- the fixed statement that issuer authenticity is not independently verified;
- `not-established` issuer-verification and redistribution-rights states; and
- an Ed25519 signature with role `source-baseline-registrar`.

Registration adds evidence but does not edit `document.json`, add a
transaction, or advance the canonical revision. The record and retained source
are manifest-declared with role `source`, remain protected by finalization, and
survive later canonical transactions and lineage-derived working copies.
Duplicate in-place registration is refused; a changed organizational baseline
must be modeled through a new controlled source or future explicit
supersession workflow rather than by rewriting signed evidence.

Verification reports one of four states:

- `UNVERIFIED_SOURCE`: retained bytes exist but no signed designation exists;
- `TAMPERED`: the record, signature, document binding, or source bytes fail;
- `REGISTERED_UNTRUSTED_SIGNER`: the signed designation is valid but the
  verifier has not trusted the registrar key; or
- `REGISTERED_TRUSTED`: the signed designation is valid and the verifier's
  trust store authorizes that key for `source-baseline-registrar`.

Even `REGISTERED_TRUSTED` means only that a trusted organizational registrar
adopted those exact bytes. Issuer authenticity remains a separate external
verification claim. Studio, SDK responses, and
`andoc_verify_source_baseline` expose this boundary directly to agents.

## PDF import profile

The prototype PDF adapter runs Docling locally and creates a new canonical revision-zero document. It currently maps:

- detected titles and section headers to heading blocks;
- short numbered headings that satisfy conservative deterministic title-case
  rules to heading blocks with explicit `sectionNumber` metadata and a level
  derived from numbering depth;
- text items to paragraph blocks;
- Docling footnote/endnote items to canonical note blocks with subtype, marker,
  source geometry, and stable anchor status;
- detected table grids to semantic ANX tables, ordered by recovered cell geometry when Docling's grid array is not in visual column order;
- picture items to image blocks backed by integrity-checked `assets/pdf/**` entries;
- classified chart pictures to semantic chart blocks with a retained static fallback asset;
- PDF page transitions to explicit page-break blocks;
- Docling page numbers and bounding boxes to block provenance.

Text-layer items geometrically contained by a detected table are represented by the semantic cells and are not emitted again as paragraph blocks. Each imported cell receives a deterministic stable ID, table source provenance, canonical row/column coordinates, original grid position, and its recovered cell bounding box plus coordinate origin when available.

The original PDF is embedded at `sources/original/<file>.pdf`; a compact copy of the Docling document is embedded at `sources/docling/document.json`. Extracted picture bytes are stored once under `assets/pdf/**`. Large inline page or picture data URIs in the Docling companion are replaced with an explicit asset marker to avoid duplicating media. Source and asset entries are integrity-declared in `manifest.json`.

Recurring extracted text is indexed under `document.metadata.anxSharedContent`
using `anx.shared-content.v1`. The reference policy requires at least 40
characters and occurrences on at least three distinct source pages. Matching is
whitespace-normalized but otherwise exact: wording, punctuation, case, numbers,
dates, and legal variants are not merged. Each group stores the text once plus
its source page scope, occurrence evidence, source references, bounding boxes
when available, and integrity hashes. Text that Docling classifies as page
furniture remains outside canonical body flow but is still represented in this
source-bound index. The retained PDF and compact Docling companion remain the
exact evidence.

This index does not rewrite canonical blocks. Repeated body blocks remain
individually addressable in `document.json` so editing, page reconstruction, and
per-occurrence citations stay lossless. The default agent projection may replace
those repeated payloads with one shared-content record and page scope.
`andoc_shared_content` expands the exact occurrence-level node/source evidence
on demand. Suspect or unverified text-layer pages retain their quality warning
even when their repetition scope is deterministic.

Picture and table captions are resolved from Docling references and attached to
their parent image, chart, or table block as canonical text. When the caption
reference has source geometry, ANX also retains a linked `caption` region with
its own page rectangle, provenance, stable region ID, and parent-region
relationship. The region is a visible semantic part, not a second canonical
text node: agent search and reading use the parent's caption once, while page
evidence and Studio can focus, cite, correct, or add the caption boundary.
Unreferenced caption text remains an ordinary source text block rather than
being silently discarded. Page and bounding-box provenance remains attached to
the visual block. A picture classified as a chart receives a structured chart
block plus its static fallback image. The chart spec records whether structured
values were supplied by the importer. If values are unavailable, `data` remains
null and the extraction status is `classified-fallback-only`; the adapter does
not fabricate chart data from pixels. A later `updateChartData` transaction can
attach rectangular `columns` and `rows` together with an explicit method,
source, verification flag, optional confidence, and notes.

Caption Assist may project additional caption regions from the retained
`sources/docling/document.json` companion at read time. This projection is
deterministic and does not rewrite `document.json`, revision history, or the
retained source. An explicit converter `caption` label verifies the caption
classification, text, and rectangle independently of whether its parent visual
can be resolved. Prefix-only inferences such as ordinary text beginning with
`Figure` or `Table` remain `review-required`. A parent-region ID is asserted
only when one nearby compatible object is uniquely resolved; otherwise the
caption remains safely unlinked. Exact-text or geometry-overlap matching
suppresses any retained caption already represented by imported or human
correction evidence.

`mimetype` and `manifest.json` are package metadata and do not list themselves in the manifest. Every other entry must be declared with SHA-256, byte size, media type, and role. Undeclared entries fail validation.

## Office import profile

DOCX, PPTX, and XLSX use the same local Docling adapter and produce the same canonical schema. Unlike PDF layout items, Office items frequently have no bounding boxes. When Docling supplies a `body` tree, ANX traverses that tree as the authoritative reading order instead of sorting by missing geometry. Group descendants are expanded in order; table descendants are consumed by the semantic table and are not emitted again as paragraphs.

DOCX header/footer paragraphs are selectively read from `word/header*.xml` and `word/footer*.xml` and removed from canonical body flow when Docling misclassifies exact furniture text as body content. The original Office container remains embedded under `sources/original/**`, and its media type and SHA-256 remain in document metadata and the manifest.

When Docling fails to label the first short Office paragraph as a visual title, the importer promotes it to the canonical level-one title and records an explicit import warning. Office export is not part of 0.1.

## Canonical document

`andoc.document.v1` currently supports:

- headings and paragraphs as marked text runs;
- ordered/unordered lists with recursively nested, stable-ID items;
- footnotes/endnotes with explicit labels, marked-text content, semantic
  subtype, stable anchor IDs, and `resolved`, `uncertain`, or `unanchored`
  linkage state;
- declared extension envelopes with versioned typed payloads and required core-text fallbacks;
- images linked to integrity-checked asset records;
- semantic tables with cell spans and headers;
- structured chart specifications with optional data and fallback assets;
- explicit page breaks;
- per-block provenance including source, page, bounding box, capture time, and confidence.

Every block has a stable `id`. Every table cell and nested list item is also a first-class stable node. IDs share one document-wide namespace and survive rendering and ordinary content changes. Block and cell IDs are used by editor selections, agent tool calls, comments, citations, transactions, and provenance records; list blocks are currently retrieved and replaced atomically while their item IDs preserve a future granular edit boundary.

## Citation layers

ANX keeps technical evidence identity separate from human bibliography.
Revision-pinned `anx://` URIs identify the exact document revision and stable
block, cell, region, or document relationship used as evidence. They remain the machine/audit
identifier and are never replaced by a presentation style. Studio presents
those identifiers as page/source labels and copies a deterministic human
citation by default; Technical URI remains an explicit copy mode.

The pre-1.0 formatter reads optional CSL-shaped values from
`document.metadata.citation`: `title`, `author` (string entries or
`given`/`family`/`literal` objects), `issued` with `date-parts`, `publisher`,
and `URL`. Simple, APA, MLA, and IEEE copy modes are deterministic for the
common report fields represented there. If author, issued date, or publisher
is absent, Studio reports the missing fields and does not infer them from
unverified body text. General standards-compliance claims across other source
types, locales, DOI rules, editions, and style variants require a governed
citation-metadata profile, a CSL processor, and a separate conformance corpus.

## Document relationships

Portable outbound relationships are optional canonical document metadata under
`document.metadata.anxRelationships`, validated by
`schemas/anx.relationships.v1.schema.json`. The relationship is an assertion
made by the current document revision; it is not a copy of the target and does
not establish target authenticity, legal authority, licensing, or compliance.

The bounded developer-preview vocabulary is:

- `references`;
- `governed-by`;
- `derived-from`;
- `supersedes`; and
- `claims-conformance-to`.

Every relationship has a stable `relationship-*` ID, an active or removed
state, typed internal or external target metadata, target-content resolution,
assertion authority, and timestamps. Target metadata may include identifier,
title, revision or edition, section or clause, publisher, and resolver URI.
`resolved` means an internal ANX target ID is available to the reader.
`metadata-only` means the organization knows the citation but does not hold the
target content. `restricted` means content may exist but this reader is not
authorized to access it. `unresolved` records an incomplete or currently
unmatched reference.

Human-created relationships are `human-approved`. Agents may only introduce
`agent-suggested` candidates; a human approval transaction supplies the
approval actor and time. Removal retains a tombstone with actor and time so
history is not rewritten. Studio stages additions, approvals, and removals in
the current browser working draft and commits the net relationship set with the
next **Save working version** transaction. It does not create one package
revision per click.

`anx_relationships` is the read-only agent surface. It returns target
availability, authority, a revision-pinned relationship citation, and explicit
verification guidance. If an external standard such as ISO 9001 is
metadata-only, an agent may say that this document declares the relationship,
but may not infer the standard's requirements or claim established compliance.
`claims-conformance-to` always requires verification against target content and
retained evidence.

The `.anx` file stores its own outbound assertions. Inbound links, organization-
wide traversal, semantic discovery, and graph analytics are derived repository
indexes or adapters; they are not embedded back into every target file. This
keeps a single `.anx` portable without turning the format into a central
knowledge-graph service.

## Human page-object corrections

Source-bound tables, missing-text recovery regions, notes, captions, charts, figures,
logos, maps, QR codes, signatures, and other page objects may be corrected
without rewriting the retained source PDF.
The optional `document.metadata.anxRegionCorrections` value conforms to
`schemas/anx.region-corrections.v1.schema.json`.

Each active entry has a stable `correction-*` ID and targets one stable
`region-*` ID. An `upsert` may change the page-object type, page, rectangle,
coordinate origin, and description; it may also create a missing human region.
Note corrections additionally record `footnote` or `endnote` subtype and an
optional stable anchor node.
A `remove` entry is a retained correction tombstone that suppresses the
incorrect region from the current agent-visible region state without deleting
the source bytes or historical revision.

Corrections are human-authored, revision-bound, and transaction-backed. Studio
stages the net correction set in the current unsaved working draft. Moving,
resizing, reclassifying, drawing, or removing several page objects does not
create several package revisions; **Save working version** commits the complete
set as one revision. Discard restores the previously saved state.

The agent region and page-evidence tools apply the saved correction layer and
return the corrected type and geometry with human provenance. A human
correction establishes the organization's chosen page-object boundary and
label for that revision. It does not prove the object's interpretation,
chart-value accuracy, signature identity, legal authenticity, or source
publisher authority.

### Page-object classification guidance

Studio and conforming correction tools use the most specific supported semantic
type:

- **table** — rows and columns whose structure is needed to compare values,
  including tables whose cells contain icons or pictures;
- **text** — a missing or incorrectly bounded paragraph, heading, label,
  or other general text region. A human transcription stored in the
  correction description is verified human evidence; geometry without a
  transcription remains `candidate` and `review-required`. Ordinary canonical
  text does not require a separate Text block region;
- **note** — one Studio category for supplemental note text, with ANX semantic
  subtype `footnote` or `endnote`. A note with visible text and a valid stable
  anchor is verified human evidence. Missing text, missing anchors, and
  uncertain marker-to-note relationships remain `candidate` and
  `review-required`;
- **caption** — text that labels or explains a nearby table, chart, figure,
  screenshot, map, or other page object; its box covers the caption text only,
  while canonical caption text remains owned by the parent object;
- **chart** — quantitative data plotted with axes, scales, legends, bars,
  lines, points, slices, or comparable data marks;
- **figure** — a photo, illustration, diagram, or composed visual that is not
  primarily a chart, table, logo, map, QR code, or software capture;
- **logo** — a brand, organization, program, or product mark, emblem, seal, or
  wordmark;
- **screenshot** — a captured software, website, application, desktop,
  instrument, or device interface;
- **visualization** — a data or relationship visual without a conventional
  chart form, such as a network, process, or system visualization;
- **infographic** — one designed panel combining graphics, labels, and
  narrative;
- **roster** — a structured group of people, headshots, names, or roles;
- **qrCode**, **map**, **equation**, **handwriting**, and **signature** —
  their literal specialized object classes; and
- **other** — a meaningful object that cannot safely use another supported
  type.

Numbered sections and subsections are canonical heading blocks, not page-object
regions. For example, `13. Goal-Question-Metric` remains exact visible text
while ANX records heading level `1` and `sectionNumber: "13"`. A heading that
the importer cannot distinguish conservatively remains ordinary text rather
than being probabilistically promoted.

When two boxes represent the same semantic object, the more specific type
supersedes a redundant `figure` box. Parent and child boxes may both remain
when they carry distinct meaning—for example, a composed figure containing a
separately useful chart or QR code. A linked caption is also intentionally
separate from the visual it describes. A visual overlap alone is therefore not
enough to delete an object. Corrections record the human's revision-bound
classification choice; they do not retrain the importer.

### Table representation and data readiness

`table` is the semantic page-object type. It does not, by itself, assert that
the source table contains machine-addressable cells. Every agent-visible Table
region therefore carries `structuredData.tableEvidence` conforming to
`anx.table-evidence.v1`, with two independent axes:

- `sourceRepresentation`: `text-and-vector`, `image-based`,
  `image-based-with-structured-extraction`, `vector-rules`, `mixed`, or
  `unknown`; and
- `dataState`: `structured-verified`, `structured-unverified`, `visual-only`,
  `candidate-only`, or `unstructured`.

The record also discloses whether cell structure is available and verified,
the allowed agent-use state, and deterministic guidance. A screenshot or
scanned image that visibly contains rows and columns may therefore be
semantically classified as a Table while remaining `image-based` and
`visual-only`. Agents must not quote, compare, or calculate its cell values
until extraction and verification establish structured cells.

When canonical table cells and coincident picture evidence both exist, ANX
retains one semantic Table region and reports
`image-based-with-structured-extraction`; it does not draw or return two
duplicate Table objects. Source modality is evidence, not a second editable
document and not a claim that the extracted cells are correct. Human
reclassification and geometry correction change the semantic region layer but
do not silently promote visual pixels into canonical table data.

Text recovery does not silently insert a new canonical paragraph. The saved
region gives agents stable source geometry, human provenance, and either the
entered transcription or an explicit review-required state. Promotion into
the canonical reading order is a separate revision-checked content operation.

An extension block carries `extensionId`, `version`, an opaque JSON-object `payload`, and at least one fallback text run. Its exact `extensionId@version` must appear in `profiles/declaration.json`; an unknown extension may be declared optional so core readers can render and preserve the fallback without claiming to understand the payload. Repack and generic block transactions preserve the full envelope. Unknown required capabilities remain a validation failure.

## Synchronization contract

The product does not maintain editable structured and unstructured copies.

```text
human editor ─┐
              ├─> andoc.transaction.v1 ─> document.json revision N+1
agent tool ───┘                                │
                                              ├─> HTML/editor view
                                              ├─> search/JSONL projection
                                              └─> PDF/Office export
```

Transactions include a `baseRevision`. Agent MCP mutation tools require the revision returned by the preceding open, locate, query, or preview call. A stale edit fails with structured `REVISION_CONFLICT` data and must be reloaded, reviewed, and explicitly retried or revised. In-place human and agent writes acquire the same short-lived cross-process document lock, re-read the package inside that lock, and then validate the expected revision; this prevents two atomic renames from becoming a lost update. One transaction may contain multiple operations, but the batch advances exactly one revision and history record or writes nothing. Version 0.1 implements document metadata, block insertion/replacement/removal/reordering, rich text, table-cell updates, table row/column insertion/removal, image asset registration, media metadata, and evidence-bearing chart data. A targeted cell edit names both `tableId` and `cellId`; a media metadata edit names an image or chart block and patches alternative text and/or caption without replacing its binary asset. A chart-data edit names one chart block and supplies a rectangular scalar table plus `ChartDataEvidence`. Duplicate columns and mismatched row widths fail validation. Verified and unverified values remain explicitly distinguishable in canonical, HTML, and PDF projections. The transaction engine preserves imported provenance under `attrs.sourceProvenance` and stamps the active human or agent authorship on the edited node. Package sources and unmodified assets are byte-preserved while canonical document, derived HTML, manifest, and history advance atomically. The editor reloads the latest canonical revision after a conflict and never silently rebases a stale same-node edit. A later collaboration layer may encode the same operations through Yjs while preserving the transaction audit log.

## Working versions and release revisions

ANX separates three version axes that conventional document systems often collapse:

1. `document.revision` is an internal, monotonically increasing transaction counter used for optimistic concurrency and audit ordering.
2. A working version is a saved draft checkpoint within one release cycle. Working versions may advance without changing the release revision.
3. A release revision is an organization-controlled identifier for approved or issued content, such as `Rev 0`, `Rev 1`, `A`, `B`, or a semantic version. A released revision is immutable; continued work derives a working descendant through the lineage contract.

Unsaved Studio edits are not package revisions. They remain a browser-local draft bound to the exact document ID and internal base revision. Studio coalesces those edits by stable target and submits the net operation set as one `andoc.transaction.v1` only when the user selects **Save working version**. A stale base revision fails closed instead of being silently rebased. The saved transaction may update `document.metadata.anxReleaseControl` with:

- `schema: anx.release-control.v1`;
- the selected `policyId` and a policy snapshot;
- the current release revision and lifecycle state;
- the base release revision, working-version counter, and internal revision;
- actor and timestamp fields; and
- a release log.

New packages retain `versions/baseline.document.json` at import revision zero.
Together with the ordered forward transactions, that one baseline is sufficient
to reconstruct each saved internal revision without storing a duplicate full
document for every working version. The baseline is manifest-declared with the
`history` role, hash-checked like every other entry, and protected by
finalization. The baseline document ID must match the current document,
its revision cannot exceed the current revision, exactly one transaction
must connect every retained revision, no transaction may begin at or beyond
the current revision, and replay must reproduce `document.json` byte-for-byte
under canonical JSON serialization. A legacy package without a baseline
remains readable; its next repack or transaction establishes the current
document as the first provable baseline and must not claim that earlier
versions can be reconstructed.

Studio exposes the resulting checkpoints through a deterministic version list
and read-only historical views. Selecting a historical version never changes
the current document, transaction log, release state, or package bytes. Editing
and the Document Agent remain bound to the current version until a separate
historical-agent evidence contract is implemented.

Revision behavior is governed by a document-control policy profile, not by a content template. A policy defines the release-identifier scheme, lifecycle states and permitted transitions, approval gates, locking and derivation behavior, change-log requirements, retention rules, and human/agent authority. The default controlled-document policy uses zero-based integer releases, unbounded integer working versions, explicit human release approval, and advisory-only agent authority. Organizations may embed a different deterministic policy while preserving the same stable transaction, lineage, and evidence contracts.

Agents may summarize changes, recommend classifications, detect policy gaps, and prepare release candidates. They may not invent release identifiers, waive required approvals, alter the governing policy, or issue a final release unless the selected policy explicitly authorizes that action and all deterministic gates pass.

The reference release lifecycle is deterministic:

1. a human submits the current content for review after all required annotations and proposals are resolved;
2. Studio binds that review to a canonical semantic-content SHA-256 rather than only the internal transaction number;
3. authorized human approvals bind to the same content hash;
4. content operations are refused while the document is in `review` or `approved`; requesting changes returns it to `working`;
5. signing a release candidate requires the policy approval count, an explicit human action, a non-empty change summary when required, and a server-held signing identity;
6. a policy-complete candidate remains staged so its finalization root, signatures, and optional receipts can be inspected;
7. a second explicit human action publishes the exact staged bytes as the immutable controlled record and records its identifier, internal revision, content hash, actor, time, and change summary; and
8. further editing derives a new working descendant through ANX lineage, retains the released identifier as its base, computes the next deterministic release identifier, and resets the working-version counter.

`anx.revision-policy.v1` supports integer, alphabetic, lookup, semantic, date-pattern, and explicitly supplied release identifiers. Studio ships one controlled-document policy and may load validated organization policies from a server-side registry. Policy changes are allowed only before the first controlled release. Private signing material is never accepted from the browser or stored inside the `.anx`.

Retention, backup-before-prune, and legal-hold capability remain repository concerns rather than bytes inside a single `.anx`. The reference Studio repository implements these hooks for local controlled records: it creates immutable released snapshots, records custody events, blocks pruning under legal hold, enforces the configured minimum number of verified backups before pruning, and restores only exact hash-and-size-matching bytes. The repository index is not part of the portable `.anx`; it is environmental custody metadata.

Release signing may be staged across multiple required roles. A staged candidate is not the canonical released document. The current approved package remains unchanged even after the candidate becomes policy-complete; publication is a distinct confirmed operation. Each signature uses the existing protected-root contract, so adding a signer does not rewrite protected content. Studio obtains signer identities from server administration and never accepts private signing material from the browser.

Finalization receipts may be attached to a staged signed candidate without changing the protected-content root. Once published, the controlled record is immutable and later evidence cannot be inserted in place. Receipt presence is evidence only, never proof by itself. A receipt may affect verification only through an explicitly configured provider verifier. The reference signed-time attestation verifier binds the document ID, revision, finalization ID, protected root, witnessed time, provider, key ID, and Ed25519 signature to a verifier-trusted key with the `timestamp-authority` role. The agent-attestation receipt binds a hash-only retained execution record, its reviewed source-content hash, fixed tool manifest, provider/model assertion, exact finalization, and protected root to a locally pinned Ed25519 attester key. It never counts as a human approval. These are local provider hooks, not implementations of RFC 3161, transparency-log inclusion, blockchain consensus, legal identity, remote runtime attestation, enterprise authorization, or non-repudiation.

## Human projections

`views/document.html` is a derived cache, never an independent editable source. It renders the canonical document title exactly once as H1 and labels the main region with that title. Each rendered block carries `data-andoc-id`, table cells carry `data-andoc-cell-id`, and list items carry `data-andoc-list-item-id`, so UI selections map back to canonical nodes. Lists preserve nesting and numbering; footnotes render as notes; unsupported extensions render their required fallback. Charts show their retained fallback plus any structured values and evidence label. A derived view suppresses an imported heading that duplicates the document title and suppresses a table-classified raster picture when a semantic table from the same source region exists; the original assets remain integrity-preserved in the package.

## PDF projection

`export-pdf` and `/imports/:id/export.pdf` render the current canonical revision directly. Version 0.3 uses standard PDF fonts, letter pages, deterministic metadata dates, stable object ordering, semantic text/tables/lists/footnotes, extension fallbacks, PNG/JPEG media, chart fallbacks, chart-data tables, page breaks, and revision/page footers. A compact table moves intact when it cannot fit the current page; longer tables split by row and repeat the semantic header on every continuation page. Identical `.anx` bytes produce byte-identical PDF bytes. PDF remains an export projection: editing it does not mutate `document.json` without explicit re-import and reconciliation.

## Versioning

The format version and schema identifiers are separate:

- container: `formatVersion: 1.0` for the core package and `1.1` when profiles, lineage, finalization records, version baselines, or source-baseline evidence are present;
- canonical model: `andoc.document.v1`;
- manifest: `andoc.manifest.v1`;
- edit contract: `andoc.transaction.v1`.

The `andoc.*` schema tokens are the stable legacy 0.1 namespace. They remain unchanged during the extension migration so existing transactions, profiles, signatures, lineage, and sealed evidence continue to validate. A neutral public-v1 namespace may only be introduced through the open governance process with explicit migration rules and conformance fixtures.

Readers must reject unknown major schema versions unless a migration is available. Writers must preserve unmodified assets and provenance across revisions.

## Profiles, finalization, and lineage

Profiles declare a document's domain contract and required extension capabilities; templates remain separate presentation or starter-content references. The core-document profile is always required. Built-in domain profiles cover research reports, financial reports, and controlled documents. A reader must reject an unsupported required capability and may preserve an unsupported optional extension.

Finalization protects deterministic hashes of the canonical document, transaction history, human view, assets, sources, profile declaration, extensions, and lineage record. Ed25519 signatures bind that protected root to signer metadata and a role-aware approval policy. A valid signature proves possession of the corresponding private key; trusted identity and role require a verifier-owned trust store. A local signing time is not a trusted timestamp.

A finalized package is sealed against ordinary transactions. Continued work uses `derive-draft`, which creates revision N+1, removes active finalization state, records `andoc.lineage.v1`, and defaults to embedding the exact finalized parent at `sources/lineage/<sha256>.anx`. Historical `.anxd`, `.agn`, and `.andoc` embedded-parent paths remain readable. A reference mode instead records the parent URI, package SHA-256, finalization ID, and protected-entry root without copying the parent bytes. Reference verification returns `PARENT_REFERENCE_UNRESOLVED` until exact parent bytes are supplied explicitly; it never fetches or treats a URI as proof. When the child is later finalized, its signed record includes an explicit `supersedes` reference. Embedding maximizes self-containment; reference mode bounds multi-generation package growth and requires durable external parent storage.

External RFC 3161 timestamps, transparency-log receipts, and blockchain anchors are extension points. Version 0.1 validates no such external system by default. A configured receipt verifier may validate provider-specific evidence, including the reference signed-time attestation contract, but must never infer trust from receipt presence. Transparency inclusion, blockchain consensus, and external timestamp-authority semantics remain provider-owned. See `docs/profiles-and-finalization.md` for the operational contract.

## Security

Readers reject absolute paths, parent traversal, empty path segments, missing required entries, duplicate manifest or ZIP paths, size/hash mismatches, undeclared entries, invalid schemas, duplicate block/cell/list-item IDs, dangling asset references, undeclared extension envelopes, encrypted entries, multi-disk archives, ZIP64, malformed offsets, and unsupported expansion declarations. The 0.1 preflight limits are 96 MB compressed package bytes, 256 MB total expanded bytes, 64 MB per entry, and 2,048 entries, enforced before decompression.

Finalization does not by itself establish a person's legal identity, authority, or non-repudiation. Verifiers must apply their own trusted-key and role policy. Private signing keys are accepted only by explicit local CLI/library operations; the MCP agent surface exposes read-only capability, finalization, and lineage verification and never accepts private keys.
