# ANX interoperability and conformance classes

Status: v1 draft, 2026-07-18. Platform-specific adapters are intentionally deferred until the beachhead decision (roadmap Track A2); this document defines the contract they will all share.

## Conformance classes

Compatibility is a depth contract, not a binary. A platform integration declares exactly one class, and each class has (or will have) conformance fixtures:

| Class | Name | Requirement |
| --- | --- | --- |
| ANX-C1 | Store | Preserve `.anx` bytes and `application/anx+zip` unchanged; never re-compress or unwrap |
| ANX-C2 | Preview | Render the package's derived human view read-only after full security preflight; display title, revision, finalization state |
| ANX-C3 | Index | Extract text, properties, stable node IDs, legibility states, and provenance for search; `anx diff` semantic diffs qualify here |
| ANX-C4 | Map | Project nodes into the platform's native model with a mapping manifest (below); read-only or deep-link edit |
| ANX-C5 | Edit | Translate platform actions into revision-checked `andoc.transaction.v1` transactions with preview/conflict/inverse semantics |

**ANX-C5 is offered only where the platform provides stable object identifiers, change notifications, and revision-checked writes.** Everywhere else, the honest ceiling is C4 with a deep link to a real editor. A markdown-vault projection edited by users is NOT C5 — external markdown edits re-enter as reconciliation-required imports, never as transactions.

## Mapping manifest (C4/C5)

Stored platform-side as a generated artifact — canonical packages never accumulate per-platform sync state:

```json
{
  "schema": "anx.projection-map.v1",
  "anxDocumentId": "…", "anxRevision": 7, "packageSha256": "…",
  "projectionType": "…",
  "nodes": { "<anx-node-id>": { "external": "<platform-object-id>", "contentSha256": "<node projection hash>", "externalVersion": "<etag/version>" } },
  "finalized": false
}
```

Per-node content hashes detect external drift without full diffs; `externalVersion` detects platform-side races; `finalized: true` must render read-only in every adapter (conformance fixture, not a convention).

## Editing rule (C5)

External edit → adapter resolves external object → ANX stable node → package hash + base revision check → preview → `andoc.transaction.v1` apply → regenerate projection. An adapter never overwrites a canonical `.anx` from an exported document; unsupported structural changes produce a reconciliation request. The shipped `applyTextCandidate` operation is the reference pattern: expected-state match, typed operation, evidence binding, complete inverse.

## Relationship interoperability

An `.anx` carries its own outbound `anx.relationships.v1` assertions.
ANX-C3 indexers should index active relationship type, target identifier, title,
revision, publisher, resolution, and authority while preserving the
revision-pinned `anx://…/relationships/<id>` citation. They must not fetch
metadata-only or restricted targets implicitly.

Organization-wide inbound links and graph traversal are derived indexes, not
canonical fields replicated into every target file. A C4/C5 adapter may map a
resolved internal relationship to a native platform link. Metadata-only
external standards remain labeled references and must not be presented as
locally available evidence, verified requirements, or established compliance.

## Security requirements for every adapter

Preview handlers, thumbnailers, indexers, and unfurlers parse hostile files. Every adapter MUST run the full package preflight (traversal, undeclared entries, hash/size, expansion limits, ZIP64 rejection) before touching content, MUST declare its supported `formatVersion` and profiles, MUST render extension-block fallbacks for unknown payloads, and SHOULD be fuzzed before shipping on any OS or SaaS preview surface.

## What already exists vs. what to build

Existing today: the core SDK (this workspace), HTML/PDF/DOCX/Markdown/JSONL projections, the full local MCP surface plus a bounded five-tool read-only evidence server (the C3+ surface for agents — the primary adoption channel), `anx diff` with markdown rendering for CI review surfaces, executable ANX-C1 through C3 conformance fixtures, and a local read-only standalone viewer.

Universal assets still to build are the C4 mapping-manifest reference implementation, hostile-package fuzzing, and one independent reader implementation. Platform adapters (M365 File Handler, Drive Open-with, Notion/Confluence, Obsidian, VS Code) wait for the beachhead decision; note M365 File Handlers require tenant admin consent and are an enterprise deployment feature, not a distribution channel.

## Google Open Knowledge Format boundary

Google Open Knowledge Format (OKF) and ANX solve adjacent problems, not the
same primary problem. OKF is a lightweight, Git-friendly directory of Markdown
and YAML for publishing and linking organizational knowledge. ANX is an
authoritative document artifact and controlled-record layer: it preserves the
exact source, stable semantic identities, page geometry, evidence citations,
transaction history, working and release revisions, finalization, signatures,
and deterministic human projections.

ANX must not position itself as a universal wiki, knowledge catalog, or general
organizational knowledge-bundle replacement. Where OKF or another knowledge
graph is present, the intended boundary is:

- **OKF or graph layer:** discovery, concepts, corpus navigation, summaries,
  and links across organizational knowledge;
- **ANX:** the authoritative document, source evidence, exact revisions,
  transactions, review, signatures, release state, and machine-verifiable
  citations; and
- **Studio:** the reference human application for viewing, editing, reviewing,
  signing, releasing, and interrogating ANX documents.

The recommended interoperability direction is a generated **ANX-to-OKF
projection**, not a second canonical copy. A projection may publish one concept
record per ANX release with a summary, outline, status, relationships, and a
resource link back to the authoritative ANX or Studio view. It must never
flatten away ANX evidence hashes, source geometry, signature state, transaction
history, or revision authority and then claim the OKF projection is the
controlled record.

This is a strategy and compatibility boundary, not an implemented adapter or a
claim of Google endorsement. The reference design should track OKF's evolving
provenance, freshness, verification, and attestation fields without coupling
the ANX core schema to an external preview specification.

Primary references, accessed 2026-08-02:

- [Google Cloud introduction to Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
- [Open Knowledge Format v0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
- [Google Cloud overview of OKF v0.2 trust signals](https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals)
