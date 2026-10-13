# Migrating AGN to ANX

Status: frozen Developer Preview 0.3 migration record, 2026-07-19. Superseded for current writes by [Migrating `.anxd` to `.anx`](migration-anxd-to-anx.md).

## Decision

The open format is now **ANX — Agent Native eXtensible**. New files use `.anxd`; the reference media type is `application/anx+zip`; canonical citations use `anx://`; and the conformance ladder is `ANX-C1` through `ANX-C5`.

The four-character extension is intentional. [`.anx` is already used](https://fileinfo.com/extension/anx) by unrelated HotDocs Answer and Annodex media files, while [`.ax` is used](https://fileinfo.com/extension/ax) by Microsoft DirectShow filters. `.anxd` keeps the short ANX identity without claiming an ambiguous existing extension. File extensions are routing hints, not proof: readers validate the internal `mimetype`, manifest, hashes, and schemas.

## Compatibility contract

| Surface | Canonical new value | Accepted legacy values |
| --- | --- | --- |
| Extension | `.anxd` | `.agn`, `.andoc` |
| Internal media type | `application/anx+zip` | `application/agn+zip`, `application/vnd.andoc+zip` |
| CLI | `anx` | `agn`, `andoc` aliases |
| Citation URI | `anx://` | historical `agn://` citations remain records, not rewritten pointers |
| Conformance | `ANX-C1` to `ANX-C5` | `AGN-C1` to `AGN-C3` accepted as request aliases |
| Environment | `ANX_*` | `AGN_*`, `ANDOC_*` fallbacks |
| SDK | `Anx*`, `packAnx`, `readAnx`, `anx*` | `Agn*` and `Andoc*` aliases |

The internal `andoc.*` JSON Schema identifiers are deliberately unchanged in Developer Preview 0.3. Renaming those tokens would break signed roots, transaction histories, extension references, and sealed benchmark evidence without improving interoperability. Existing `agn.*` review metadata and implementation DOM hooks are also compatibility identifiers during this transition; they are not the public file identity and can be versioned separately after the package contract stabilizes.

## Migration behavior

For an editable, non-finalized legacy package:

```bash
npm run anx -- migrate legacy.agn current.anxd
npm run anx -- validate current.anxd
```

Migration reads and validates the old package, then deterministically repacks it with the canonical ANX media type and derived human view. Merely changing a filename extension does not migrate internal metadata.

Finalized or lineaged packages are not repacked in place because their exact bytes and hashes are evidence. Keep the legacy parent byte-identical and use `derive-draft` to create a new editable `.anxd` child with explicit lineage.

## History policy

Sealed releases, benchmark corpora, reports, citations, and commit history retain the identity under which they were created. Current implementation, specifications, examples, Studio surfaces, and new releases use ANX. This distinction prevents a branding migration from falsifying historical evidence.

## Registration path

`application/anx+zip` is a developer-preview media type, not yet present in the [IANA media-type registry](https://www.iana.org/assignments/media-types/media-types.xhtml). Before ANX 1.0, governance must complete media-type registration analysis, public security review, independent-reader testing, collision review, and file-signature guidance. Applications must continue to inspect internal identity rather than trust `.anxd` alone.
