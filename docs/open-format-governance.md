# ANX Open-Format Governance Roadmap

Status: proposed operating model for public adoption.

## Principle

ANX is the portable standard. Studio is a reference application and may offer the best integrated experience, but a conforming ANX reader, writer, validator, or agent tool must not depend on Studio, a hosted service, Adobe, or a metered conversion API.

The [product boundary and provider strategy](product-boundary.md) governs which capabilities belong in the standard, Studio, an importer, or an external integration. Import quality may vary by provider; core ANX meaning and conformance may not.

## Public deliverables

The independent format repository should publish:

1. the normative package and semantic specification;
2. JSON Schemas and registered profile and extension identifiers;
3. deterministic conformance fixtures, including malformed and hostile packages;
4. a validator and at least one permissively licensed reference SDK;
5. migration rules and compatibility guarantees;
6. security considerations, file signatures, media-type details, and OS integration guidance;
7. a public issue, proposal, and decision record.

The proposed licenses are CC BY 4.0 for prose specifications and Apache-2.0 for schemas, fixtures, validator, SDKs, and reference tools, subject to final legal review. Required format behavior must not depend on a patent-encumbered or proprietary component without a royalty-free interoperable path.

## Governance stages

- Incubation: this project maintains the draft, conformance suite, and reference implementation.
- Public preview: changes use numbered proposals, compatibility impact statements, and two-week public review windows.
- Version 1.0: require two independent readers, two independent writers, cross-implementation round trips, a frozen conformance corpus, and documented security review.
- Standards transition: pursue permanent IANA media-type registration and, if ecosystem demand supports it, transfer change control to a recognized neutral organization.

## Compatibility policy

Readers ignore optional extensions they do not understand but reject unsupported required capabilities. Minor versions add compatible behavior; a major version is required for incompatible canonical semantics. Stable IDs, deterministic canonicalization, integrity validation, and explicit transaction conflicts are never optional core behavior.

Vendor extensions use a namespaced identifier and cannot redefine core semantics. Profiles constrain ANX for document classes such as research reports or controlled documents without creating new file formats.

## Adoption test

ANX is succeeding when an independent developer can implement a reader from the public specification, validate the shared corpus, open and edit a file made by Studio, and return a file that Studio accepts without private coordination.
