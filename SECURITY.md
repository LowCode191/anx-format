# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). Please do not open a public issue for a suspected vulnerability. Include the package or input that triggers the problem, the command or API used, and the observed behavior. You should receive an acknowledgement within seven days.

## Supported versions

Only the current Developer Preview line (0.4.x) receives fixes. There is no long-term support commitment before 1.0.

## What the reference implementation defends

- Package preflight runs before decompression and rejects traversal, absolute paths, empty segments, duplicate or undeclared entries, hash and size mismatches, encrypted entries, multi-disk archives, ZIP64, malformed offsets and declared expansion beyond the 0.4 safety profile (96 MiB compressed, 256 MiB expanded, 64 MiB per entry, 2,048 entries).
- Manifest hashes and sizes are validated before canonical content is used.
- The viewer serves canonical JSON, the derived view and declared assets read-only on the loopback interface. It has no mutation endpoint and strips unsafe link schemes.
- The MCP servers confine paths to `ANX_ALLOWED_ROOT`, require the expected revision for mutations and never accept private signing keys.
- Imported source bytes are immutable; OCR candidates are never promoted automatically.

## What it does not claim

- Docling and RapidOCR run as local subprocesses on untrusted input. Convert untrusted documents inside a sandbox or container; the importer is not a security boundary for those programs.
- Finalization signatures prove possession of a key, not legal identity. Trust decisions belong to the verifier's trust store.
- Dependency audits are time-sensitive registry evidence, not a permanent clearance. Run `npm audit` against the lockfile you deploy.
- No independent security audit or fuzzing campaign has been completed. Hostile-package fuzzing is on the roadmap and contributions are welcome.
