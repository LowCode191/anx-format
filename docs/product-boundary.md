# ANX Product Boundary and Provider Strategy

Status: active product decision, 2026-07-25.

This document is the authority for deciding whether proposed work belongs in
the ANX format, Studio, an import provider, a platform adapter, or outside the
product. It supplements the [format
specification](format-spec.md), [interoperability contract](interoperability.md),
and [open-format governance roadmap](open-format-governance.md).

## Product decision

**ANX is an open, portable, versioned document format in which humans and
agents can safely read, cite, review, and transact against the same canonical
document.**

Studio is the reference human application for ANX. Import engines translate
source formats into ANX. Platform adapters store, preview, index, map, or edit
ANX according to the published conformance classes.

ANX is not primarily an OCR company, a hosted document-processing API, a RAG
pipeline, or a PDF/DOCX form-filling service. Those capabilities can feed or
consume ANX, but they do not define the format's durable value.

## Ownership map

| Layer | Owns | Does not own |
| --- | --- | --- |
| **ANX format and core SDK** | Single-file package; canonical semantic document; stable IDs; assets and retained sources; revision-checked transactions; integrity; provenance; profiles; finalization; lineage; conformance; migrations | Vendor-specific OCR behavior; a hosted processing queue; a particular human UI; platform-specific sync state |
| **Studio** | Source-faithful Page view; accessible Reflow view; direct human editing; evidence inspection; proposals and approvals; semantic history/diff; conflicts; finalization; agent interaction | Private format semantics; a second editable authority; opaque automatic edits; universal recreation of every PDF drawing primitive |
| **Import providers** | PDF/Office/image parsing; OCR; layout, table, figure, form, and field detection; provider confidence and geometry | Canonical ANX semantics; silent promotion of uncertain content; provider-specific identifiers as durable ANX IDs |
| **Platform adapters** | ANX-C1 through C5 storage, preview, index, mapping, and revision-checked editing contracts | Replacing the canonical package with a lossy projection; claiming C5 where the host lacks stable identity or conflict-safe writes |
| **External applications** | Workflow orchestration, RAG, records management, collaboration, signing services, model execution, and domain automation | Redefining ANX core behavior without a compatible extension, profile, or versioned proposal |

## Non-goals

ANX and Studio will not:

1. Compete to be the highest-scoring universal OCR or document-layout model.
2. Require a paid conversion API, Adobe, Studio, or a hosted ANX service.
3. Become a general-purpose cloud ETL, extraction, classification, or RAG
   platform.
4. Treat PDF, DOCX, HTML, Markdown, JSONL, or a platform projection as a
   second editable source of truth.
5. Automatically promote ambiguous OCR, visual interpretation, or extracted
   values into canonical content without the declared evidence and review
   policy.
6. Promise pixel-identical reconstruction for arbitrary imported formats.
   Retained source bytes provide exact visual evidence; canonical Page and
   Reflow projections provide explainable current-document views.
7. Rebuild mature commodity capabilities solely to avoid supporting a
   replaceable provider interface.

These non-goals do not prohibit a capable local reference importer. ANX must
retain a usable, testable, non-metered local path so the open format is not
dependent on a commercial service.

## Provider policy

ANX uses a provider-neutral import boundary:

```text
PDF / DOCX / PPTX / XLSX / image
                 |
       local or commercial importer
                 |
        normalized ANX evidence
                 |
    canonical .anx package and Studio
```

The current local reference path is Docling plus selective RapidOCR. Other
providers may be added when they improve quality, latency, cost, language
coverage, or enterprise deployment.

Every importer must:

- preserve or reference the original source according to an explicit package
  policy;
- normalize content into the public ANX schema and generate document-scoped
  stable IDs;
- record engine, version, model, configuration, source hash, confidence, and
  relevant geometry as provenance;
- keep native, OCR, and visual candidates distinguishable;
- abstain or request comparison when evidence is insufficient;
- avoid an automatic canonical change unless the active profile and promotion
  policy explicitly permit it; and
- pass the same security preflight, conformance, and regression gates as the
  reference importer.

Provider-specific payloads may be retained as evidence or namespaced
extensions. They must not become required core semantics or make a conforming
reader contact that provider.

## Reducto boundary case

Reducto is a close comparison at the processing layer. Its public documentation
describes a production document platform that parses more than 30 file types,
returns structured text, tables, figures, coordinates and confidence, performs
schema-driven extraction with source citations, exposes agent access through
MCP/CLI/SDKs, and fills PDF forms or modifies structured DOCX templates.
Reducto also offers SaaS, hybrid VPC, full VPC, and air-gapped deployment.

That creates high overlap with ANX import, extraction, citation, and form
workflows. It raises the quality and usability bar for those surfaces.

The products remain distinct only while ANX holds this boundary:

| Reducto public product contract | ANX product contract |
| --- | --- |
| Document in; processing job or pipeline; structured result or edited PDF/DOCX out | One durable `.anx` artifact containing canonical structure, retained sources, evidence, assets, revisions, and integrity |
| Pipeline configuration versions and execution logs | Document-content revisions, semantic transactions, conflict checks, inverse operations, finalization, and lineage |
| Processing Studio for configuring, testing, and deploying document workflows | Human document Studio for reading, editing, reviewing, citing, and finalizing the same state agents use |
| Commercial processing implementation, including private deployment options | Open format and conformance contract that independent readers and writers can implement |

Public Reducto documentation reviewed on 2026-07-25:

- [Platform overview](https://docs.reducto.ai/overview)
- [Parse](https://docs.reducto.ai/parse/overview)
- [Extract and source citations](https://docs.reducto.ai/extract/overview)
- [PDF and DOCX Edit](https://docs.reducto.ai/editing/edit-overview)
- [Pipeline deployment and configuration history](https://docs.reducto.ai/studio-deploy-pipeline)
- [Cloud, VPC, and on-premises deployment](https://docs.reducto.ai/onprem/enterprise_deployment_options)
- [Job chaining and retention](https://docs.reducto.ai/workflows/chaining-endpoints)

This is a product-boundary assessment, not a measured Reducto benchmark.
Reducto may expand its public contract. Re-verify the comparison before using
it in external positioning.

## Build, integrate, or decline

Use this decision sequence for proposed work:

1. **Does it define portable document meaning, state, trust, or safe mutation?**
   Build it in the ANX specification and core SDK.
2. **Does it help a person read, edit, review, compare, cite, or finalize that
   canonical state?** Build it in Studio using ANX transactions.
3. **Does it translate a source format or improve OCR/layout recognition?**
   Put it behind the provider-neutral importer contract. Build only the local
   baseline and ANX-specific normalization; integrate specialized engines.
4. **Does it project ANX into another platform?** Build an ANX-C1 through C5
   adapter and declare the honest conformance ceiling.
5. **Is its primary value generic document ETL, hosted extraction, model
   orchestration, or records management?** Keep it outside ANX core and
   integrate through public APIs where justified.

When a feature spans layers, the canonical rule wins: provider and UI behavior
must reduce to public ANX evidence and revision-checked transactions rather
than private hidden state.

## Product priority implied by this boundary

Prioritize:

1. Direct, low-friction human editing in Studio over the canonical document.
2. Semantic history, diff, preview, conflict handling, approval, finalization,
   signatures, and lineage.
3. Compact agent reads, stable machine citations, evidence disclosure, and
   safe transactional writes.
4. Independent-reader/writer conformance, migrations, SDK quality, and open
   governance.
5. Provider-neutral import benchmarking and adapters, while maintaining the
   local reference path.

Do not prioritize becoming a broad document-processing SaaS or winning a
general OCR leaderboard unless independent evidence shows that an
ANX-specific normalization defect cannot be solved at the adapter boundary.

## Success test

The boundary is working when:

- the same `.anx` file can be moved between independent tools without losing
  canonical state or evidence;
- a human and an agent can safely update that file without duplicate edits;
- every accepted change has stable targets, provenance, revision history, and
  conflict behavior;
- Studio can switch import providers without changing format semantics; and
- customers can use ANX without purchasing a particular conversion service.

Parsing accuracy, token efficiency, latency, human usability, interoperability,
and demand remain separate measured claims. Success in one does not establish
the others.
