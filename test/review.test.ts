import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addReviewAnnotationTransaction,
  addReviewProposalTransaction,
  applyTransaction,
  decideReviewProposalTransaction,
  recordReviewApprovalTransaction,
  reviewState,
  reviewSummary,
  sourceRevisionPatchPlan,
  type AndocDocument,
  type AndocTransaction,
} from '../src/index.js'

const baseDocument: AndocDocument = {
  schema: 'andoc.document.v1',
  documentId: 'review-fixture',
  revision: 0,
  title: 'Review Fixture',
  locale: 'en-US',
  createdAt: '2026-07-19T20:00:00.000Z',
  updatedAt: '2026-07-19T20:00:00.000Z',
  metadata: { layout: { sourcePageSizes: { '1': { width: 612, height: 792 } } } },
  assets: {},
  blocks: [{
    id: 'paragraph-1',
    type: 'paragraph',
    content: [{ text: 'Original statement.' }],
    provenance: { kind: 'imported', page: 1, bbox: [72, 600, 300, 620] },
    attrs: { coordinateOrigin: 'BOTTOMLEFT' },
  }],
}

const agent = { type: 'agent' as const, id: 'research-agent' }
const reviewer = { type: 'human' as const, id: 'reviewer@example.com' }

test('comments and highlights are stable-ID metadata transactions with source anchors', () => {
  const transaction = addReviewAnnotationTransaction(baseDocument, {
    kind: 'comment',
    targetId: 'paragraph-1',
    body: 'Confirm this statement against the retained source.',
  }, { actor: reviewer, id: 'tx-comment', timestamp: '2026-07-19T20:01:00.000Z' })
  const reviewed = applyTransaction(baseDocument, transaction)
  const annotation = reviewState(reviewed).annotations[0]!

  assert.equal(annotation.anchor.targetId, 'paragraph-1')
  assert.equal(annotation.anchor.page, 1)
  assert.deepEqual(annotation.anchor.bbox, [72, 600, 300, 620])
  assert.equal(annotation.status, 'open')
  assert.equal(sourceRevisionPatchPlan(reviewed, [transaction]).supported, true, 'metadata-only revision keeps the exact source canvas without inventing a patch')
  assert.equal(sourceRevisionPatchPlan(reviewed, [transaction]).unsupported.length, 0)
})

test('agent proposals are non-destructive until a human accepts the revision-checked operation', () => {
  const proposedTransaction = addReviewProposalTransaction(baseDocument, {
    message: 'Clarify the source statement',
    operations: [{ op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Reviewed statement.' }] }],
  }, { actor: agent, id: 'tx-propose', timestamp: '2026-07-19T20:02:00.000Z' })
  const proposedDocument = applyTransaction(baseDocument, proposedTransaction)
  assert.equal(proposedDocument.blocks[0]?.type === 'paragraph' ? proposedDocument.blocks[0].content[0]?.text : '', 'Original statement.')
  assert.equal(reviewState(proposedDocument).proposals[0]?.status, 'open')

  const acceptedTransaction = decideReviewProposalTransaction(proposedDocument, {
    proposalId: reviewState(proposedDocument).proposals[0]!.id,
    decision: 'accept',
    note: 'Source checked.',
  }, { actor: reviewer, id: 'tx-accept', timestamp: '2026-07-19T20:03:00.000Z' })
  const acceptedDocument = applyTransaction(proposedDocument, acceptedTransaction)

  assert.equal(acceptedDocument.blocks[0]?.type === 'paragraph' ? acceptedDocument.blocks[0].content[0]?.text : '', 'Reviewed statement.')
  assert.equal(reviewState(acceptedDocument).proposals[0]?.status, 'accepted')
  assert.equal(reviewState(acceptedDocument).proposals[0]?.appliedRevision, 2)
  const patchPlan = sourceRevisionPatchPlan(acceptedDocument, [proposedTransaction, acceptedTransaction])
  assert.equal(patchPlan.supported, true)
  assert.equal(patchPlan.patches.length, 1)
})

test('proposal acceptance fails closed after the target changes', () => {
  const proposedTransaction = addReviewProposalTransaction(baseDocument, {
    message: 'Change the statement',
    operations: [{ op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Agent proposal.' }] }],
  }, { actor: agent, id: 'tx-propose-stale', timestamp: '2026-07-19T20:02:00.000Z' })
  const proposedDocument = applyTransaction(baseDocument, proposedTransaction)
  const concurrent: AndocTransaction = {
    schema: 'andoc.transaction.v1', id: 'tx-human-change', baseRevision: 1,
    actor: reviewer, timestamp: '2026-07-19T20:03:00.000Z',
    operations: [{ op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Human changed first.' }] }],
  }
  const changed = applyTransaction(proposedDocument, concurrent)

  assert.throws(() => decideReviewProposalTransaction(changed, {
    proposalId: reviewState(changed).proposals[0]!.id,
    decision: 'accept',
  }, { actor: reviewer }), /target changed after proposal/)
})

test('approval is an auditable statement about an explicit current revision', () => {
  const approval = recordReviewApprovalTransaction(baseDocument, {
    decision: 'approved',
    reviewedRevision: 0,
    note: 'Ready for downstream use.',
  }, { actor: reviewer, id: 'tx-approval', timestamp: '2026-07-19T20:04:00.000Z' })
  const approved = applyTransaction(baseDocument, approval)
  const summary = reviewSummary(approved)

  assert.equal((summary.counts as Record<string, number>).approvals, 1)
  assert.equal(summary.approvedCurrentRevision, false, 'recording the approval creates a new auditable metadata revision')
  assert.equal(summary.approvedCurrentContent, true, 'metadata-only approval preserves the reviewed content fingerprint')
  assert.throws(() => recordReviewApprovalTransaction(approved, { decision: 'approved', reviewedRevision: 0 }, { actor: reviewer }), /current revision/)
})
