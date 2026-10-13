import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  ANX_SOURCE_BASELINES_PATH,
  ANX_SOURCE_BASELINE_ROLE,
  andocOpen,
  deriveAndocDraft,
  finalizeAndoc,
  packAndoc,
  readAndoc,
  registerSourceBaseline,
  repackAndocPackage,
  sha256,
  submitReleaseReviewTransaction,
  transactAndocPackage,
  validateAndoc,
  verifySourceBaseline,
  type AndocDocument,
  type AndocTransaction,
  type AndocTrustStore,
} from '../src/index.js'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures')
const registeredAt = '2026-07-25T14:00:00.000Z'
const sourceBytes = new TextEncoder().encode('%PDF-1.7\nANX source-baseline fixture\n%%EOF\n')
const sourcePath = 'sources/original/controlled-standard.pdf'

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8')) as T
}

function signingKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
}

async function sourcePackage(documentPatch: Partial<AndocDocument> = {}) {
  const document = await fixture<AndocDocument>('sample.document.json')
  Object.assign(document, documentPatch)
  document.metadata.source = {
    fileName: 'controlled-standard.pdf',
    mediaType: 'application/pdf',
    sha256: sha256(sourceBytes),
    size: sourceBytes.length,
  }
  return packAndoc({ document, sources: { [sourcePath]: sourceBytes } })
}

test('an imported source remains explicitly unverified until a human registers a signed organizational baseline', async () => {
  const bytes = await sourcePackage()
  const verification = await verifySourceBaseline(bytes)
  assert.equal(verification.status, 'UNVERIFIED_SOURCE')
  assert.equal(verification.evidencePresent, false)
  assert.equal(verification.registered, false)
  assert.equal(verification.issuerVerified, false)
  assert.match(verification.agentGuidance, /unverified imported source/i)
  assert.match(verification.agentGuidance, /Do not call it authentic, original, authoritative, or issuer-verified/i)

  const opened = await andocOpen(bytes) as { sourceBaseline: { status: string; issuerVerified: boolean } }
  assert.equal(opened.sourceBaseline.status, 'UNVERIFIED_SOURCE')
  assert.equal(opened.sourceBaseline.issuerVerified, false)
})

test('registration signs the exact retained bytes without changing canonical revision or history', async () => {
  const baseBytes = await sourcePackage()
  const base = await readAndoc(baseBytes)
  const key = signingKey()
  const registered = await registerSourceBaseline(base, {
    actor: { type: 'human', id: 'records.owner@example.com' },
    privateKeyPem: key,
    keyId: 'source-baseline-key-1',
    role: ANX_SOURCE_BASELINE_ROLE,
    registeredAt,
    organization: 'Example Organization',
    title: 'Controlled Standard',
    publisher: 'Example Publisher',
    edition: '2026 edition',
    acquisitionMethod: 'purchase',
    acquiredAt: '2026-07-20T12:00:00.000Z',
    supplier: 'Authorized distributor',
    orderReference: 'ORDER-1234',
  })
  const pkg = await readAndoc(registered.packageBytes)
  assert.deepEqual(pkg.document, base.document)
  assert.deepEqual(pkg.transactions, base.transactions)
  assert.deepEqual(pkg.files[sourcePath], base.files[sourcePath])
  assert.equal(pkg.manifest.entries.find(entry => entry.path === ANX_SOURCE_BASELINES_PATH)?.role, 'source')
  assert.equal((await validateAndoc(registered.packageBytes)).ok, true)
  assert.equal(registered.verification.status, 'REGISTERED_UNTRUSTED_SIGNER')
  assert.equal(registered.verification.issuerVerified, false)

  const publicKeySha256 = registered.verification.publicKeySha256!
  const trustStore: AndocTrustStore = {
    schema: 'andoc.trust-store.v1',
    keys: [{
      keyId: 'source-baseline-key-1',
      publicKeySha256,
      roles: [ANX_SOURCE_BASELINE_ROLE],
    }],
  }
  const trusted = await verifySourceBaseline(registered.packageBytes, trustStore)
  assert.equal(trusted.status, 'REGISTERED_TRUSTED')
  assert.equal(trusted.trusted, true)
  assert.equal(trusted.issuerVerified, false, 'trust in the organizational registrar does not establish publisher authenticity')
})

test('registered source evidence survives edits, formal finalization, and derivation into the next working copy', async () => {
  const baseBytes = await sourcePackage()
  const baselineKey = signingKey()
  const registered = await registerSourceBaseline(baseBytes, {
    actor: { type: 'human', id: 'document-controller' },
    privateKeyPem: baselineKey,
    keyId: 'baseline-key',
    role: ANX_SOURCE_BASELINE_ROLE,
    registeredAt,
    title: 'Controlled Standard',
    acquisitionMethod: 'download',
  })
  const transaction = await fixture<AndocTransaction>('sample.transaction.json')
  const edited = await transactAndocPackage(await readAndoc(registered.packageBytes), transaction)
  const editedPackage = await readAndoc(edited.packageBytes)
  assert.deepEqual(
    editedPackage.files[ANX_SOURCE_BASELINES_PATH],
    (await readAndoc(registered.packageBytes)).files[ANX_SOURCE_BASELINES_PATH],
  )
  assert.equal((await verifySourceBaseline(edited.packageBytes)).valid, true)

  const finalized = await finalizeAndoc(edited.packageBytes, {
    actor: { type: 'human', id: 'approver' },
    privateKeyPem: signingKey(),
    keyId: 'release-key',
    role: 'approver',
    createdAt: '2026-07-25T15:00:00.000Z',
  })
  assert.equal((await verifySourceBaseline(finalized.packageBytes)).valid, true)
  await assert.rejects(() => registerSourceBaseline(finalized.packageBytes, {
    actor: { type: 'human', id: 'document-controller' },
    privateKeyPem: baselineKey,
    keyId: 'baseline-key',
    role: ANX_SOURCE_BASELINE_ROLE,
    registeredAt,
    title: 'Controlled Standard',
    acquisitionMethod: 'download',
  }), /DOCUMENT_FINALIZED/)

  const derived = await deriveAndocDraft(finalized.packageBytes, {
    actor: { type: 'human', id: 'editor' },
    derivedAt: '2026-07-25T16:00:00.000Z',
  })
  const derivedVerification = await verifySourceBaseline(derived.packageBytes)
  assert.equal(derivedVerification.valid, true)
  assert.equal(derivedVerification.source?.sha256, sha256(sourceBytes))
})

test('tampering, duplicate designation, and cross-document replay fail closed', async () => {
  const key = signingKey()
  const registered = await registerSourceBaseline(await sourcePackage(), {
    actor: { type: 'human', id: 'document-controller' },
    privateKeyPem: key,
    keyId: 'baseline-key',
    role: ANX_SOURCE_BASELINE_ROLE,
    registeredAt,
    title: 'Controlled Standard',
    acquisitionMethod: 'received',
  })
  await assert.rejects(() => registerSourceBaseline(registered.packageBytes, {
    actor: { type: 'human', id: 'second-controller' },
    privateKeyPem: key,
    keyId: 'baseline-key',
    role: ANX_SOURCE_BASELINE_ROLE,
    registeredAt: '2026-07-25T14:05:00.000Z',
    title: 'Replacement claim',
    acquisitionMethod: 'received',
  }), /SOURCE_BASELINE_ALREADY_REGISTERED/)

  const pkg = await readAndoc(registered.packageBytes)
  const changedRegistry = structuredClone(pkg.sourceBaselines!)
  changedRegistry.records[0]!.description.title = 'Unsigned replacement title'
  const tamperedBytes = await repackAndocPackage(pkg, { sourceBaselines: changedRegistry })
  const tampered = await verifySourceBaseline(tamperedBytes)
  assert.equal(tampered.status, 'TAMPERED')
  assert.equal(tampered.evidencePresent, true)
  assert.equal(tampered.registered, false)
  assert.match(tampered.agentGuidance, /unverified source/i)

  const replayDocument = await fixture<AndocDocument>('sample.document.json')
  replayDocument.documentId = 'pdf-111111111111111111111111'
  replayDocument.metadata.source = { fileName: 'controlled-standard.pdf' }
  const replayBytes = await packAndoc({
    document: replayDocument,
    sources: { [sourcePath]: sourceBytes },
    sourceBaselines: pkg.sourceBaselines,
  })
  const replayValidation = await validateAndoc(replayBytes)
  assert.equal(replayValidation.ok, false)
  assert(replayValidation.issues.some(issue => issue.code === 'source_baseline_document_mismatch'))
  await assert.rejects(() => readAndoc(replayBytes), /source_baseline_document_mismatch/)
})

test('registration is blocked after a working document enters release review', async () => {
  const base = await readAndoc(await sourcePackage())
  const reviewTransaction = submitReleaseReviewTransaction(base.document, {
    actor: { type: 'human', id: 'review-owner' },
    timestamp: '2026-07-25T13:55:00.000Z',
  })
  const review = await transactAndocPackage(base, reviewTransaction)
  await assert.rejects(() => registerSourceBaseline(review.packageBytes, {
    actor: { type: 'human', id: 'document-controller' },
    privateKeyPem: signingKey(),
    keyId: 'baseline-key',
    role: ANX_SOURCE_BASELINE_ROLE,
    registeredAt,
    title: 'Controlled Standard',
    acquisitionMethod: 'received',
  }), /SOURCE_BASELINE_LIFECYCLE_BLOCKED/)
})
