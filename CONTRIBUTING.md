# Contributing

Thank you for looking at ANX. The format is early and the most valuable contributions are ones that test it from the outside.

## Development loop

```bash
npm ci
npm run check            # build dist/ and run the test suite
npm run conformance -- examples/sample.anx ANX-C3
```

Tests use `node:test` and self-made fixtures under `test/fixtures`. Historical fixtures and example packages are immutable: add new fixtures rather than editing existing bytes, because checksums and sealed evidence depend on them.

Import and OCR tests use a stub bridge and do not require Docling. Running the real importer needs `pip install "docling[rapidocr]"`.

## Sign-off

Commits must carry a Developer Certificate of Origin sign-off (`git commit -s`). By signing off you certify that you wrote the change or have the right to submit it under the project licenses: Apache-2.0 for code, schemas, fixtures and scripts, CC BY 4.0 for specification and documentation prose.

## Scope

In scope for this repository: the package format, canonical schemas, transactions, integrity and safety, profiles, finalization and lineage, conformance fixtures, the reference importer boundary, the CLI, the viewer and the MCP servers.

Out of scope here: the Studio desktop application (separate package), hosted services, platform-specific adapters beyond the C1 to C5 contract, and benchmark corpora.

## Changing the format

A change to required package entries, transaction semantics, stable-ID behavior or integrity processing needs a numbered proposal (open an issue titled `Proposal NNN: ...`) with:

1. the motivation and the alternatives considered;
2. a compatibility impact statement for existing packages, histories and signatures;
3. the schema or fixture changes;
4. a migration rule if existing packages are affected.

Proposals stay open for review for at least two weeks before they are frozen into a new Developer Preview revision. Vendor extensions use a namespaced identifier and cannot redefine core semantics.

## Good first contributions

- An independent reader in another language (Python is a natural first choice) that validates the conformance fixtures and opens `examples/sample.anx`. This is the first 1.0 gate and the best possible test of the specification.
- Additional conformance fixtures, especially malformed and hostile packages.
- A hostile-package fuzzing harness for the preflight.
- Documentation fixes where the spec and the implementation disagree. When they do, the implementation is a bug report against the spec, not the other way round.
