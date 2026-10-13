# ANX developer-preview conformance

This directory carries the executable adoption surface for [ANX Developer Preview 0.4](../spec/ANX-DEV-PREVIEW-0.4.md).

## Reference commands

```bash
npm run anx -- pack conformance/fixtures/read-core.document.json output/read-core.anx
npm run anx -- conformance output/read-core.anx ANX-C3
npm run anx -- view output/read-core.anx 8787
```

The conformance report is deterministic for identical package bytes except for process-level presentation. It reports every check, the achieved class, the requested class, the package SHA-256, and the claim boundary. The viewer is read-only and serves canonical JSON, the deterministic human view, integrity-declared assets, and the retained original source where one exists. It has no mutation endpoint and does not require Studio.

## Fixture contract

- `read-core.document.json` exercises canonical headings, marked text, a semantic table, and stable cell IDs.
- `read-core.expected.json` fixes the required C1-C3 check IDs and public claims.
- Package security and hostile-container fixtures remain in the core test suite because malformed ZIP inputs are binary-specific.
- C4 and C5 fixtures are intentionally deferred to platform adapters; a reader MUST NOT infer them from C3 success.

Third-party implementations should build their own `.anx` from the document fixture, preserve the resulting bytes for C1 storage tests, render it for C2, and expose all expected stable IDs for C3. Equivalent canonical serialization is required for deterministic writer claims; byte identity is required only when storing an already-created package unchanged.
