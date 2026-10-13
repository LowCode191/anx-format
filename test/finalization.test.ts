import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  ANDOC_PROFILES_SCHEMA,
  ANDOC_LINEAGE_SCHEMA,
  ANDOC_SIGNATURE_EXTENSION_ID,
  FinalizedDocumentError,
  cosignAndoc,
  createProfiles,
  deriveAndocDraft,
  finalizeAndoc,
  inspectAndocCapabilities,
  packAndoc,
  readAndoc,
  repackAndocPackage,
  setAndocProfiles,
  sha256,
  transactAndocPackage,
  validateProfiles,
  verifyAndocFinalization,
  verifyAndocLineage,
  type AndocDocument,
  type AndocProfiles,
  type AndocTransaction,
  type AndocTrustStore,
} from '../src/index.js'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures')
const fixedTime = '2026-07-17T15:00:00.000Z'

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8')) as T
}

function signingKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
}

test('domain profiles compose required extensions without turning templates into profiles', () => {
  const profiles = createProfiles({
    profiles: ['andoc.profile.research-report', 'andoc.profile.financial-report'],
    extensions: ['andoc.extension.review'],
    template: { id: 'equity-research-quarterly', version: '2.1' },
  })
  assert.equal(profiles.core.id, 'andoc.profile.core-document')
  assert.deepEqual(profiles.extensions.map(extension => extension.id), [
    'andoc.extension.citations-evidence',
    'andoc.extension.review',
    'andoc.extension.typed-values',
  ])
  assert.equal(profiles.template?.id, 'equity-research-quarterly')
  assert.equal(validateProfiles(profiles).ok, true)

  const unsupported: AndocProfiles = {
    schema: ANDOC_PROFILES_SCHEMA,
    core: profiles.core,
    profiles: [],
    extensions: [{ id: 'andoc.extension.future-capability', version: '1.0', required: true }],
  }
  const validation = validateProfiles(unsupported)
  assert.equal(validation.ok, false)
  assert(validation.issues.some(issue => issue.code === 'unsupported_required_capability'))
})

test('profile declarations round-trip as an integrity-checked package role and survive transactions', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const transaction = await fixture<AndocTransaction>('sample.transaction.json')
  const base = await packAndoc({ document })
  const profiles = createProfiles({ profiles: ['andoc.profile.research-report'] })
  const profiled = await setAndocProfiles(base, profiles)
  const pkg = await readAndoc(profiled.packageBytes)
  assert.equal(pkg.manifest.formatVersion, '1.1')
  assert.equal(pkg.profiles?.profiles[0]?.id, 'andoc.profile.research-report')
  assert.equal(pkg.manifest.entries.find(entry => entry.path === 'profiles/declaration.json')?.role, 'profile')

  const next = await transactAndocPackage(pkg, transaction)
  const nextPackage = await readAndoc(next.packageBytes)
  assert.deepEqual(nextPackage.profiles, profiles)
  const capabilities = await inspectAndocCapabilities(next.packageBytes)
  assert.equal(capabilities.finalized, false)
  assert.equal(capabilities.supported, true)
})

test('finalization is deterministic, cryptographically verifiable, trust-aware, and seals transactions', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const transaction = await fixture<AndocTransaction>('sample.transaction.json')
  const base = await packAndoc({ document })
  const privateKeyPem = signingKey()
  const options = {
    privateKeyPem,
    keyId: 'research-author-key-1',
    role: 'author',
    actor: { type: 'human' as const, id: 'research-author' },
    createdAt: fixedTime,
  }
  const first = await finalizeAndoc(base, options)
  const second = await finalizeAndoc(base, options)
  assert.equal(sha256(first.packageBytes), sha256(second.packageBytes))
  assert.equal(first.verification.status, 'VALID_UNTRUSTED_SIGNER')
  assert.equal(first.verification.valid, true)
  assert.equal(first.verification.trusted, false)

  const pkg = await readAndoc(first.packageBytes)
  assert.equal(pkg.finalizations.length, 1)
  assert(pkg.profiles?.extensions.some(extension => extension.id === ANDOC_SIGNATURE_EXTENSION_ID))
  assert.equal(pkg.manifest.entries.find(entry => entry.path === 'finalizations/records.json')?.role, 'finalization')

  const signature = first.finalization.signatures[0]!
  const trustStore: AndocTrustStore = {
    schema: 'andoc.trust-store.v1',
    keys: [{ keyId: signature.keyId, publicKeySha256: signature.publicKeySha256, roles: ['author'] }],
  }
  const trusted = await verifyAndocFinalization(first.packageBytes, trustStore)
  assert.equal(trusted.status, 'VALID_TRUSTED')
  assert.equal(trusted.trusted, true)
  assert.equal(trusted.trustedTime, false, 'a local signing time is not a trusted timestamp')

  const withUnverifiedReceipt = structuredClone(first.finalization)
  withUnverifiedReceipt.receipts = [{ type: 'rfc3161', provider: 'unverified-test-provider', payload: 'opaque-unverified-token', receivedAt: fixedTime }]
  const receiptPackage = await repackAndocPackage(pkg, { finalizations: [withUnverifiedReceipt] })
  const receiptVerification = await verifyAndocFinalization(receiptPackage, trustStore)
  assert.equal(receiptVerification.receipts, 1)
  assert.equal(receiptVerification.trustedTime, false, 'receipt presence without provider verification must not establish trusted time')

  await assert.rejects(() => transactAndocPackage(pkg, transaction), error => {
    assert(error instanceof FinalizedDocumentError)
    assert.equal(error.code, 'DOCUMENT_FINALIZED')
    return true
  })
})

test('multi-role approval remains incomplete until a second authorized signature is added', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const base = await packAndoc({ document })
  const authorKey = signingKey()
  const reviewerKey = signingKey()
  const pending = await finalizeAndoc(base, {
    privateKeyPem: authorKey,
    keyId: 'author-key',
    role: 'author',
    actor: { type: 'human', id: 'author-1' },
    createdAt: fixedTime,
    policy: { id: 'andoc.policy.author-reviewer.v1', requiredSignatures: 2, requiredRoles: ['author', 'reviewer'] },
  })
  assert.equal(pending.verification.status, 'POLICY_INCOMPLETE')
  assert.deepEqual(pending.verification.policy.missingRoles, ['reviewer'])

  const completed = await cosignAndoc(pending.packageBytes, {
    privateKeyPem: reviewerKey,
    keyId: 'reviewer-key',
    role: 'reviewer',
    signedAt: '2026-07-17T15:05:00.000Z',
  })
  assert.equal(completed.verification.status, 'VALID_UNTRUSTED_SIGNER')
  assert.equal(completed.verification.policy.validSignatures, 2)
  assert.deepEqual(completed.verification.policy.missingRoles, [])
})

test('verification rejects replay-divergent content and detects signature tampering', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const finalized = await finalizeAndoc(await packAndoc({ document }), {
    privateKeyPem: signingKey(),
    keyId: 'tamper-test-key',
    role: 'approver',
    actor: { type: 'human', id: 'approver-1' },
    createdAt: fixedTime,
  })
  const pkg = await readAndoc(finalized.packageBytes)
  const changedDocument = structuredClone(pkg.document)
  changedDocument.title = 'Unauthorized replacement title'
  const contentTampered = await repackAndocPackage(pkg, { document: changedDocument })
  await assert.rejects(() => verifyAndocFinalization(contentTampered), /version_history_document_mismatch/)

  const changedRecord = structuredClone(finalized.finalization)
  const signature = changedRecord.signatures[0]!
  signature.value = `${signature.value[0] === 'A' ? 'B' : 'A'}${signature.value.slice(1)}`
  const signatureTampered = await repackAndocPackage(pkg, { finalizations: [changedRecord] })
  assert.equal((await verifyAndocFinalization(signatureTampered)).status, 'TAMPERED')
})

test('an ordinary package reports an explicit unfinalized state', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const verification = await verifyAndocFinalization(await packAndoc({ document }))
  assert.equal(verification.status, 'UNFINALIZED')
  assert.equal(verification.sealed, false)
})

test('a finalized version derives into an editable draft with an embedded, verifiable parent and explicit supersession', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const parent = await finalizeAndoc(await packAndoc({ document }), {
    privateKeyPem: signingKey(),
    keyId: 'version-one-key',
    role: 'approver',
    actor: { type: 'human', id: 'approver-1' },
    createdAt: fixedTime,
  })
  const derivedAt = '2026-07-17T16:00:00.000Z'
  const derived = await deriveAndocDraft(parent.packageBytes, {
    actor: { type: 'human', id: 'editor-1' },
    derivedAt,
  })
  const pkg = await readAndoc(derived.packageBytes)
  assert.equal(pkg.document.documentId, document.documentId)
  assert.equal(pkg.document.revision, document.revision + 1)
  assert.equal(pkg.finalizations.length, 0)
  assert.equal(pkg.lineage?.schema, ANDOC_LINEAGE_SCHEMA)
  assert.equal(pkg.lineage?.parent.finalizationId, parent.finalization.id)
  assert.equal(pkg.manifest.entries.find(entry => entry.path === 'lineage/record.json')?.role, 'lineage')
  assert.equal(sha256(pkg.files[pkg.lineage!.parent.packagePath]!), sha256(parent.packageBytes))

  const lineageVerification = await verifyAndocLineage(derived.packageBytes)
  assert.equal(lineageVerification.status, 'VALID_UNTRUSTED')
  assert.equal(lineageVerification.valid, true)

  const edit = await fixture<AndocTransaction>('sample.transaction.json')
  edit.id = 'tx-edit-derived-draft'
  edit.baseRevision = pkg.document.revision
  edit.timestamp = '2026-07-17T16:05:00.000Z'
  const edited = await transactAndocPackage(pkg, edit)
  const editedPackage = await readAndoc(edited.packageBytes)
  assert.equal(editedPackage.lineage?.parent.finalizationId, parent.finalization.id)
  assert.equal((await verifyAndocLineage(editedPackage)).valid, true)

  const successor = await finalizeAndoc(edited.packageBytes, {
    privateKeyPem: signingKey(),
    keyId: 'version-two-key',
    role: 'approver',
    actor: { type: 'human', id: 'approver-2' },
    createdAt: '2026-07-17T16:10:00.000Z',
  })
  assert.equal(successor.finalization.supersedes?.finalizationId, parent.finalization.id)
  assert.equal(successor.finalization.supersedes?.packageSha256, sha256(parent.packageBytes))
  assert.equal(successor.verification.valid, true)
  assert.equal((await verifyAndocLineage(successor.packageBytes)).valid, true)
})

test('reference lineage avoids embedding the parent and verifies only when exact parent bytes are supplied', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const parent = await finalizeAndoc(await packAndoc({ document }), {
    privateKeyPem: signingKey(),
    keyId: 'reference-parent-key',
    role: 'approver',
    actor: { type: 'human', id: 'approver-reference' },
    createdAt: fixedTime,
  })
  const options = {
    actor: { type: 'agent' as const, id: 'reference-drafting-agent' },
    derivedAt: '2026-07-17T16:30:00.000Z',
  }
  const embedded = await deriveAndocDraft(parent.packageBytes, options)
  const referenced = await deriveAndocDraft(parent.packageBytes, {
    ...options,
    parentMode: 'reference',
    parentUri: 'urn:sha256:parent-package',
  })
  const pkg = await readAndoc(referenced.packageBytes)
  assert.equal(pkg.lineage?.parent.mode, 'reference')
  assert.equal(pkg.lineage?.parent.mode === 'reference' ? pkg.lineage.parent.uri : null, 'urn:sha256:parent-package')
  assert.equal(Object.keys(pkg.files).some(entry => entry.startsWith('sources/lineage/')), false)
  assert(referenced.packageBytes.byteLength < embedded.packageBytes.byteLength)

  const unresolved = await verifyAndocLineage(referenced.packageBytes)
  assert.equal(unresolved.status, 'PARENT_REFERENCE_UNRESOLVED')
  assert.equal(unresolved.valid, false)

  const resolved = await verifyAndocLineage(referenced.packageBytes, undefined, parent.packageBytes)
  assert.equal(resolved.status, 'VALID_UNTRUSTED')
  assert.equal(resolved.valid, true)

  const wrongParent = new Uint8Array(parent.packageBytes)
  wrongParent[wrongParent.length - 1] ^= 1
  const mismatch = await verifyAndocLineage(referenced.packageBytes, undefined, wrongParent)
  assert.equal(mismatch.status, 'PARENT_MISMATCH')
  assert.equal(mismatch.valid, false)
})

test('lineage verification rejects a parent reference that does not match the embedded finalized package', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const parent = await finalizeAndoc(await packAndoc({ document }), {
    privateKeyPem: signingKey(),
    keyId: 'lineage-tamper-key',
    role: 'approver',
    actor: { type: 'human', id: 'approver-1' },
    createdAt: fixedTime,
  })
  const derived = await deriveAndocDraft(parent.packageBytes, {
    actor: { type: 'agent', id: 'drafting-agent' },
    derivedAt: '2026-07-17T17:00:00.000Z',
  })
  const pkg = await readAndoc(derived.packageBytes)
  const changed = structuredClone(pkg.lineage!)
  changed.parent.finalizationId = 'final-unrelated-record'
  const mismatched = await repackAndocPackage(pkg, { lineage: changed })
  const verification = await verifyAndocLineage(mismatched)
  assert.equal(verification.status, 'PARENT_MISMATCH')
  assert.equal(verification.valid, false)
})
