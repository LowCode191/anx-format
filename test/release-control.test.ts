import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  addReviewAnnotationTransaction,
  applyRevisionPolicyTransaction,
  AnxRevisionPolicyRegistry,
  approveReleaseTransaction,
  defaultControlledDocumentRevisionPolicy,
  deriveNextWorkingCopy,
  packAndoc,
  readAndoc,
  releaseAndocPackage,
  releaseControlState,
  releaseControlSummary,
  requestReleaseChangesTransaction,
  resolveReviewAnnotationTransaction,
  submitReleaseReviewTransaction,
  transactAndocPackage,
  validateRevisionPolicy,
  type AndocActor,
  type AndocDocument,
} from '../src/index.js'

const fixturePath = path.join(import.meta.dirname, 'fixtures/sample.document.json')
const owner: AndocActor = { type: 'human', id: 'document-owner' }
const reviewer: AndocActor = { type: 'human', id: 'release-reviewer' }
const agent: AndocActor = { type: 'agent', id: 'release-assistant' }

async function fixturePackage() {
  const document = JSON.parse(await readFile(fixturePath, 'utf8')) as AndocDocument
  return readAndoc(await packAndoc({ document }))
}

function signingKey(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
}

test('controlled lifecycle reviews, approves, cryptographically releases, and derives the next working copy', async () => {
  const imported = await fixturePackage()
  const initial = releaseControlState(imported.document)
  assert.equal(initial.state, 'working')
  assert.equal(initial.releaseRevision, '0')
  assert.deepEqual((releaseControlSummary(imported.document).allowedActions as string[]), ['apply-policy', 'submit-review'])

  assert.throws(() => submitReleaseReviewTransaction(imported.document, { actor: agent }), /AGENT_RELEASE_AUTHORITY_DENIED/)
  const submittedResult = await transactAndocPackage(imported, submitReleaseReviewTransaction(imported.document, {
    actor: owner,
    id: 'lifecycle-submit',
    timestamp: '2026-07-25T17:00:00.000Z',
  }))
  const submitted = await readAndoc(submittedResult.packageBytes)
  assert.equal(releaseControlState(submitted.document).state, 'review')
  assert.deepEqual((releaseControlSummary(submitted.document).allowedActions as string[]), ['approve', 'request-changes'])
  await assert.rejects(() => transactAndocPackage(submitted, {
    schema: 'andoc.transaction.v1',
    id: 'edit-during-review',
    baseRevision: submitted.document.revision,
    actor: owner,
    timestamp: '2026-07-25T17:00:30.000Z',
    operations: [{ op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Changed after review submission.' }] }],
  }), /DOCUMENT_UNDER_RELEASE_REVIEW/)

  const approvedResult = await transactAndocPackage(submitted, approveReleaseTransaction(submitted.document, {
    actor: reviewer,
    id: 'lifecycle-approve',
    note: 'Content and retained evidence reviewed.',
    timestamp: '2026-07-25T17:01:00.000Z',
  }))
  const approved = await readAndoc(approvedResult.packageBytes)
  assert.equal(releaseControlState(approved.document).state, 'approved')
  assert.equal((releaseControlSummary(approved.document).approvals as string[])[0], reviewer.id)
  assert.deepEqual((releaseControlSummary(approved.document).allowedActions as string[]), ['release', 'request-changes'])

  await assert.rejects(() => releaseAndocPackage(approved, {
    actor: owner,
    privateKeyPem: signingKey(),
    keyId: 'owner-release-key',
    role: 'approver',
    changeSummary: ' ',
    timestamp: '2026-07-25T17:02:00.000Z',
  }), /RELEASE_CHANGE_LOG_REQUIRED/)

  const released = await releaseAndocPackage(approved, {
    actor: owner,
    privateKeyPem: signingKey(),
    keyId: 'owner-release-key',
    role: 'approver',
    changeSummary: 'Initial controlled release.',
    timestamp: '2026-07-25T17:02:00.000Z',
  })
  assert.equal(released.verification.valid, true)
  assert.equal(released.releaseControl.state, 'released')
  assert.equal(released.releaseControl.releaseRevision, '0')
  assert.equal(released.releaseControl.nextReleaseRevision, '1')
  assert.equal(released.releaseControl.releaseLog[0]?.changeSummary, 'Initial controlled release.')
  const releasedPackage = await readAndoc(released.packageBytes)
  assert.throws(() => submitReleaseReviewTransaction(released.document, { actor: owner }), /RELEASED_CONTENT_LOCKED/)
  await assert.rejects(() => transactAndocPackage(releasedPackage, {
    schema: 'andoc.transaction.v1',
    id: 'illegal-final-edit',
    baseRevision: released.document.revision,
    actor: owner,
    timestamp: '2026-07-25T17:02:30.000Z',
    operations: [{ op: 'setDocument', patch: { title: 'Illegal edit' } }],
  }), /finalized/i)

  const derived = await deriveNextWorkingCopy(released.packageBytes, {
    actor: owner,
    timestamp: '2026-07-25T17:03:00.000Z',
  })
  assert.equal(derived.releaseControl.state, 'working')
  assert.equal(derived.releaseControl.releaseRevision, '0')
  assert.equal(derived.releaseControl.nextReleaseRevision, '1')
  assert.equal(derived.releaseControl.workingVersion, 0)
  const derivedPackage = await readAndoc(derived.packageBytes)
  assert.equal(derivedPackage.finalizations.length, 0)
  assert.equal(derivedPackage.lineage?.parent.finalizationId, released.finalization.id)
})

test('review gates fail closed and a changes-requested decision returns to working state', async () => {
  const imported = await fixturePackage()
  const annotated = await transactAndocPackage(imported, addReviewAnnotationTransaction(imported.document, {
    kind: 'comment',
    targetId: 'paragraph-1',
    body: 'Resolve before release review.',
  }, { actor: reviewer, id: 'release-comment', timestamp: '2026-07-25T17:10:00.000Z' }))
  const withOpenComment = await readAndoc(annotated.packageBytes)
  assert.throws(() => submitReleaseReviewTransaction(withOpenComment.document, { actor: owner }), /REVIEW_GATE_OPEN_ANNOTATIONS/)

  const resolved = await transactAndocPackage(withOpenComment, resolveReviewAnnotationTransaction(
    withOpenComment.document,
    'release-comment',
    { actor: reviewer, id: 'resolve-release-comment', timestamp: '2026-07-25T17:11:00.000Z' },
  ))
  const resolvedPackage = await readAndoc(resolved.packageBytes)
  const submitted = await transactAndocPackage(resolvedPackage, submitReleaseReviewTransaction(resolvedPackage.document, {
    actor: owner,
    timestamp: '2026-07-25T17:12:00.000Z',
  }))
  const submittedPackage = await readAndoc(submitted.packageBytes)
  const changes = await transactAndocPackage(submittedPackage, requestReleaseChangesTransaction(submittedPackage.document, {
    actor: reviewer,
    note: 'Update the release note.',
    timestamp: '2026-07-25T17:13:00.000Z',
  }))
  assert.equal(releaseControlState(changes.document).state, 'working')
  assert.equal(releaseControlState(changes.document).review, null)
})

test('revision-policy registry validates deterministic enterprise numbering and retention contracts', () => {
  const registry = new AnxRevisionPolicyRegistry()
  assert.equal(registry.get(defaultControlledDocumentRevisionPolicy.id)?.releaseScheme.first, '0')
  assert.throws(() => registry.register(defaultControlledDocumentRevisionPolicy), /already registered/)

  const alphabetic = validateRevisionPolicy({
    ...structuredClone(defaultControlledDocumentRevisionPolicy),
    id: 'example.engineering.alphabetic.v1',
    label: 'Engineering issue letters',
    releaseScheme: { kind: 'alphabetic', first: 'A', label: 'Issue' },
    retention: {
      retainReleased: true,
      workingVersions: 25,
      legalHoldCapable: true,
      backupRequiredBeforePrune: true,
    },
  })
  registry.register(alphabetic)
  assert.equal(registry.list().length, 2)
  assert.equal(registry.get(alphabetic.id)?.retention.workingVersions, 25)
  const alphabeticDocument = structuredClone({
    schema: 'andoc.document.v1',
    documentId: 'alphabetic-policy-fixture',
    revision: 7,
    title: 'Alphabetic Policy',
    locale: 'en-US',
    createdAt: '2026-07-25T17:20:00.000Z',
    updatedAt: '2026-07-25T17:20:00.000Z',
    metadata: {
      anxReleaseControl: {
        schema: 'anx.release-control.v1',
        policyId: alphabetic.id,
        policySnapshot: alphabetic,
        releaseRevision: 'A',
        baseReleaseRevision: 'A',
        state: 'working',
        workingVersion: 2,
        internalRevision: 7,
        updatedAt: '2026-07-25T17:20:00.000Z',
        updatedBy: owner.id,
        review: null,
        releaseLog: [{
          releaseRevision: 'A',
          priorReleaseRevision: null,
          changeSummary: 'Initial issue.',
          releasedAt: '2026-07-25T17:19:00.000Z',
          releasedBy: owner,
          sourceInternalRevision: 5,
          releasedInternalRevision: 6,
          contentSha256: 'a'.repeat(64),
        }],
      },
    },
    assets: {},
    blocks: [],
  } as AndocDocument)
  assert.equal(releaseControlState(alphabeticDocument).nextReleaseRevision, 'B')

  assert.throws(() => validateRevisionPolicy({
    ...structuredClone(defaultControlledDocumentRevisionPolicy),
    id: 'unsafe-policy',
    releasedContentLocked: false,
  }), /must lock released content/)
})

test('an unreleased working document can adopt a registered policy but released lineage locks it', async () => {
  const imported = await fixturePackage()
  const policy = validateRevisionPolicy({
    ...structuredClone(defaultControlledDocumentRevisionPolicy),
    id: 'example.controlled.issue.v1',
    label: 'Controlled issue',
    releaseScheme: { kind: 'alphabetic', first: 'A', label: 'Issue' },
  })
  const applied = await transactAndocPackage(imported, applyRevisionPolicyTransaction(imported.document, policy, {
    actor: owner,
    timestamp: '2026-07-25T17:30:00.000Z',
  }))
  assert.equal(releaseControlState(applied.document).policyId, policy.id)
  assert.equal(releaseControlState(applied.document).releaseRevision, 'A')

  const lockedDocument = structuredClone(applied.document)
  const control = releaseControlState(lockedDocument)
  control.releaseLog.push({
    releaseRevision: 'A',
    priorReleaseRevision: null,
    changeSummary: 'Prior release.',
    releasedAt: '2026-07-25T17:31:00.000Z',
    releasedBy: owner,
    sourceInternalRevision: 1,
    releasedInternalRevision: 2,
    contentSha256: 'a'.repeat(64),
  })
  lockedDocument.metadata.anxReleaseControl = control
  assert.throws(() => applyRevisionPolicyTransaction(lockedDocument, defaultControlledDocumentRevisionPolicy, { actor: owner }), /REVISION_POLICY_LOCKED/)
})
