# ANX Profiles, Finalization, and Version Lineage

Status: implemented and deterministically qualified for the ANX Developer Preview 0.4 product workspace.

## Product model

ANX separates four concepts that are often conflated:

| Concept | Purpose | Example |
| --- | --- | --- |
| Core profile | Minimum interoperable document behavior | blocks, assets, stable IDs, transactions, provenance, projections |
| Domain profile | Contract for a document class | research report, financial report, controlled document |
| Extension | Composable capability used by one or more profiles | citations, typed values, review, signatures, forms |
| Template | Optional starter structure or visual convention | quarterly equity research layout |

A profile is not a template. A research-report profile states what software may rely on; many templates can implement that profile.

## Built-in capability registry

| ID | Kind | Required dependencies |
| --- | --- | --- |
| `andoc.profile.core-document` | core profile | none |
| `andoc.profile.research-report` | domain profile | `andoc.extension.citations-evidence` |
| `andoc.profile.financial-report` | domain profile | `andoc.extension.typed-values` |
| `andoc.profile.controlled-document` | domain profile | review, edit policies, signatures |
| `andoc.extension.review` | extension | none |
| `andoc.extension.signatures` | extension | none |
| `andoc.extension.forms` | extension | none |
| `andoc.extension.citations-evidence` | extension | none |
| `andoc.extension.typed-values` | extension | none |
| `andoc.extension.edit-policies` | extension | none |
| `andoc.extension.trusted-timestamps` | extension | signatures |
| `andoc.extension.transparency-receipts` | extension | signatures |

The declaration and dependency negotiation are implemented. Some domain payloads remain staged product work: for example, the forms field schema, general comment-thread payload, calculation graph, RFC 3161 verifier, and transparency-log receipt verifier are not yet complete merely because an extension is declared.

## Finalization contract

`finalizations/records.json` contains a signed `andoc.finalization.v1` record. Its protected root covers the canonical document, transaction history, deterministic HTML, assets, sources, profiles, extensions, and lineage. Finalization automatically declares the signatures extension.

The current signing algorithm is Ed25519. This follows the digital-signature family standardized by [NIST FIPS 186-5](https://csrc.nist.gov/pubs/fips/186-5/final). The package stores the public key and its digest so cryptographic verification can run offline. Identity trust remains external: `andoc.trust-store.v1` maps a verifier-approved key ID and public-key digest to authorized roles.

Verification states are explicit:

- `UNFINALIZED`: no finalization record exists.
- `TAMPERED`: protected content or a signature does not match.
- `POLICY_INCOMPLETE`: valid signatures do not yet satisfy the threshold or required roles.
- `VALID_UNTRUSTED_SIGNER`: content and policy verify, but the signer is not established by the supplied trust store.
- `VALID_TRUSTED`: content, policy, signer key, and role all satisfy the supplied trust store.

A signing timestamp is only signer-asserted time. Trusted time requires separately verified evidence such as [RFC 3161](https://www.rfc-editor.org/rfc/rfc3161.html). Receipt records may now be evaluated through an explicitly configured provider verifier; presence alone never changes trusted-time status. The reference signed-time attestation verifier checks an exact finalization binding and an Ed25519 signature from a verifier-trusted key with the `timestamp-authority` role. That local provider contract is not RFC 3161 or an external time authority. Public transparency patterns can later follow systems such as [Sigstore Rekor](https://docs.sigstore.dev/logging/overview/) or the IETF [SCITT](https://datatracker.ietf.org/wg/scitt/about/) architecture. Blockchain anchoring is optional evidence, not the document's source of truth.

## Formal Studio signing ceremony

Studio uses a deliberate two-step ceremony:

1. **Sign candidate.** The approved working content is transformed into a protected release candidate and signed server-side. Multi-party policies may add signatures while the candidate remains staged. The canonical approved working package is unchanged.
2. **Publish record.** After the signature policy is complete, a human must separately confirm publication. Studio then writes the exact signed package to the immutable controlled-record repository and makes it the canonical locked release.

This pause permits a human to inspect the finalization ID, protected root, signature count, and optional receipts before publication. Attaching receipts is a staged-candidate operation only. Published records have no in-place attachment endpoint; later evidence must be detached or included in a newly derived release.

Human signatures and agent attestations are separate:

- a human signature is evaluated against the finalization signature policy and its required roles;
- an agent attestation is an optional receipt about a retained execution;
- an agent attestation never increments the human signature count and never approves or publishes a record.

## Authenticated agent execution attestations

A successful embedded-agent turn may retain `anx.agent-execution.v1` evidence under the Studio repository. It stores hashes and bounded metadata—not prompt or answer text:

- document ID, source revision, and package SHA-256;
- the reviewable-content SHA-256 used by release review;
- provider plus requested and reported model identifiers;
- request, response, citation-evidence, tool-manifest, and complete-record SHA-256 values;
- timestamps, duration, citation counts, and the fixed read-only safety mode.

An `anx.agent-attestation.v1` receipt signs that execution record and binds it to the exact finalization ID, document ID, released revision, protected-entry root, reviewed source revision, and reviewable-content hash. The server verifies the signature against the public-key fingerprint derived from its configured attester key. Matching agent names or key IDs alone are insufficient. Replays to another document, revision, protected root, or execution fail closed. Revoked configured keys remain cryptographically inspectable but are not authenticated.

Configure local attesters with `ANX_STUDIO_AGENT_ATTESTERS_PATH`; an example is at [`examples/finalization/studio-agent-attesters.example.json`](../examples/finalization/studio-agent-attesters.example.json). Private keys remain outside the repository, browser, model context, and `.anx` package.

The claim boundary is narrow: this proves that a configured local Studio attester signed an assertion about retained execution evidence. It does **not** prove the legal identity of a person, remote hardware integrity, model-provider identity, provider-side logs, non-repudiation, or enterprise authorization. RBAC, SSO, KMS/HSM custody, remote attestation, and organization trust distribution remain deferred.

## Organizational source-baseline signatures

Source registration and release finalization answer different questions:

- a source-baseline signature says a named human, using a key authorized for
  `source-baseline-registrar`, designated exact retained import bytes as the
  organization's controlled starting point;
- a release signature says a signer approved the protected canonical ANX
  content and history under the selected release policy.

Registering a source baseline does not approve, release, or edit the document.
It is allowed only on a working, unfinalized package with no staged release
candidate. The record remains byte-protected when the document is later
finalized and follows the document into a lineage-derived next working copy.

Trust is verifier-owned. A valid embedded Ed25519 signature is
cryptographically inspectable without a trust store; `REGISTERED_TRUSTED`
requires a verifier trust-store entry matching the key fingerprint and the
`source-baseline-registrar` role. Neither state establishes publisher identity,
originality, latest-edition status, entitlement, or redistribution rights.
Those require distinct issuer-verification evidence and policy.

## Immutable version workflow

```text
editable revision N
        |
        v
finalize + sign ----> sealed version N
                           |
                           v
                    derive new draft
                           |
       embeds exact parent .anx (default)
          or records a parent reference
             with SHA/root/id/URI
                           |
                           v
                  editable revision N+1
                           |
                           v
               finalize with supersedes
```

The embedded parent makes a child package self-contained. Reference mode avoids recursively embedding ancestor packages and is intended for controlled repositories with durable parent retention. `verify-lineage` checks an embedded parent's SHA-256 directly. For a reference parent it returns `PARENT_REFERENCE_UNRESOLVED` unless the verifier explicitly supplies the exact external `.anx` bytes; historical `.anxd`, `.agn`, and `.andoc` parents remain readable. A URI is location metadata, never verification evidence. Once bytes are present, both modes open the parent, verify the named finalization and protected root, and optionally apply a trust store. Ordinary transactions preserve the lineage record and whichever mode was selected.

This design is closer to an append-only release chain than a mutable file history. It provides tamper evidence and traceability without requiring a blockchain. It does not prevent someone from deleting a file, replacing an entire file outside a controlled repository, or trusting the wrong public key; those concerns belong to storage controls, backups, access policy, and trusted-key distribution.

## CLI workflow

Generate a local signing key:

```bash
openssl genpkey -algorithm ED25519 -out approver-private.pem
```

Declare profiles, finalize, verify, and derive:

```bash
npm run anx -- set-profiles draft.anx examples/profiles/controlled-document.json controlled.anx
npm run anx -- finalize controlled.anx approver-private.pem approver-key-1 approver person-123 final.anx
npm run anx -- verify-final final.anx
npm run anx -- derive-draft final.anx editor-456 next-draft.anx
npm run anx -- verify-lineage next-draft.anx
```

For reference lineage, add a parent URI after the optional derived timestamp, then provide the external parent explicitly during verification (`-` means no trust-store file):

```bash
npm run anx -- derive-draft final.anx editor-456 next-draft.anx 2026-07-18T12:00:00Z urn:example:archive:final-v1
npm run anx -- verify-lineage next-draft.anx - final.anx
```

For multi-party approval, pass a policy JSON to `finalize`, then use `cosign` for each additional role. Keep private keys outside the project repository and outside agent prompts. Agent MCP tools deliberately expose verification but not signing.

## Near-term profile roadmap

The next useful payload contracts are:

1. research claims and evidence links;
2. typed financial values, periods, units, and calculation provenance;
3. stable review threads and resolution state;
4. enforceable edit-policy sections and approval transitions;
5. forms field definitions, validation, and submission state;
6. trusted timestamp and transparency receipt providers.

Each should be independently versioned as an extension schema and tested for both human projection and bounded agent retrieval. Profile breadth should not enlarge default agent responses; agents should discover capabilities first and request only the extension data needed for the task.
