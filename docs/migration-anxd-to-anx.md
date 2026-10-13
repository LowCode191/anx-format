# Migrating `.anxd` to `.anx`

Status: active pre-1.0 extension migration, 2026-07-21.

## Decision

New ANX files use the `.anx` extension. The format name remains **ANX — Agent Native eXtensible**, the internal media type remains `application/anx+zip`, canonical citations remain `anx://`, and the stable `andoc.*` schema identifiers remain unchanged.

`.anxd` was used by Developer Preview 0.3 to avoid known filename-extension collisions. The product owner has chosen the shorter `.anx` identity for open-format adoption. Because filename extensions are routing hints rather than proof, compliant readers inspect the ZIP container, exact `mimetype`, manifest, hashes, and schemas. Operating systems may still require users to choose ANX Studio or another ANX reader when a different application already owns `.anx`.

## Compatibility contract

| Surface | Canonical new value | Accepted legacy values |
| --- | --- | --- |
| Extension | `.anx` | `.anxd`, `.agn`, `.andoc` |
| Internal media type | `application/anx+zip` | `.anxd` carries the same media type; `.agn` uses `application/agn+zip`; `.andoc` uses `application/vnd.andoc+zip` |
| CLI | `anx` | `agn` and `andoc` command aliases |
| Citation URI | `anx://` | historical `agn://` citations remain records |
| Schemas | stable `andoc.*` identifiers | unchanged by this filename migration |

New writers MUST emit `.anx`. Readers MUST accept `.anx` and `.anxd`; the reference reader also accepts `.agn` and `.andoc`. The same valid `application/anx+zip` bytes may be renamed from `.anxd` to `.anx` because the internal identity does not change. Repacking is optional for that one transition. Migrating `.agn` or `.andoc` still requires deterministic repacking so the internal media type becomes `application/anx+zip`.

```bash
# Same internal identity: filename migration is sufficient.
mv document.anxd document.anx
npm run anx -- validate document.anx

# Older internal identities: repack through the migration command.
npm run anx -- migrate legacy.agn current.anx
npm run anx -- validate current.anx
```

Finalized and lineaged `.anxd` packages may be renamed without changing their bytes or hashes. Do not repack or mutate them. New embedded lineage entries use `sources/lineage/<sha256>.anx`; readers continue to recognize `.anxd`, `.agn`, and `.andoc` lineage entries.

## Historical evidence policy

Developer Preview 0.3, sealed benchmark corpora, release manifests, checksums, and reports retain `.anxd`, `.agn`, or `.andoc` exactly where those names are part of the recorded evidence. Active implementation, current documentation, Studio downloads, desktop associations, examples, and new releases use `.anx`. This preserves both an honest history and one current public extension.

## Registration and collision policy

`application/anx+zip` remains a developer-preview media type and is not an IANA registration. Before ANX 1.0, governance must complete media-type registration analysis, public security review, independent-reader testing, collision review, and file-signature guidance. Applications must validate internal identity and never trust `.anx` alone.
