# ANDoc to AGN Migration

Status: active pre-1.0 compatibility policy.

## Canonical identity

- Format name: Agent-Native Document Format (AGN)
- File extension: `.agn`
- Media type: `application/agn+zip`
- Revision citation scheme: `agn://`
- Reference human application: Studio

The internal product ID, implementation function names, historical artifact paths, and `andoc.*` schema tokens remain stable compatibility identifiers. They are not the public format brand.

## Compatibility rules

New writers emit `.agn`, `application/agn+zip`, and `agn://` citations. Readers accept both canonical AGN packages and legacy `.andoc` packages carrying `application/vnd.andoc+zip`.

Legacy input can be converted with:

```bash
npm run agn -- migrate legacy.andoc migrated.agn
```

Renaming a file in Finder does not change its internal identity. The migration command validates the input, regenerates a canonical package, and validates the result.

Automatic migration refuses finalized or lineaged packages. Those packages may be named and read as `.andoc` indefinitely; changing exact package bytes can invalidate a descendant's recorded parent-package hash. A future lineage-aware migration specification must define how a complete chain is reissued without implying that the original signatures covered the new package bytes.

## Historical evidence

Sealed benchmark releases, checksum files, raw model results, and reports retain their original names and ANDoc treatment labels. They describe the same implementation before the naming migration and must not be rewritten merely for presentation consistency.

## Schema namespace

The `andoc.document.v1`, `andoc.manifest.v1`, `andoc.transaction.v1`, profile, finalization, trust-store, and lineage tokens remain the stable 0.1 schema namespace. Renaming those identifiers would be a semantic migration rather than a filename migration. A public-v1 namespace decision requires an open proposal, compatibility fixtures, independent implementation review, and an explicit migration contract.
