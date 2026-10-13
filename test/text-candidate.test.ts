import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../src/hash.js'
import { previewTransaction } from '../src/revision-review.js'
import { applyTransaction, RevisionConflictError } from '../src/transaction.js'
import type { AndocDocument, AndocOperation, AndocTransaction } from '../src/types.js'

const PROMOTED_TEXT = 'UNITED STATES SECURITIES AND EXCHANGE COMMISSION'
const CANDIDATE_SHA = sha256(new TextEncoder().encode(PROMOTED_TEXT))

function baseDocument(): AndocDocument {
  return {
    schema: 'andoc.document.v1',
    documentId: 'doc-candidate-test',
    revision: 0,
    title: 'Candidate promotion test',
    locale: 'en',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    metadata: {},
    assets: {},
    blocks: [
      { id: 'p-1', type: 'paragraph', content: [{ text: '+$ * )* corrupted' }] },
      { id: 'pb-1', type: 'pageBreak' },
    ],
  } as AndocDocument
}

function promotion(overrides: Partial<Extract<AndocOperation, { op: 'applyTextCandidate' }>> = {}): AndocOperation {
  return {
    op: 'applyTextCandidate',
    targetId: 'p-1',
    expectedCurrentText: '+$ * )* corrupted',
    content: [{ text: PROMOTED_TEXT }],
    reason: 'Reviewed OCR candidate for corrupt-text-map page',
    candidate: {
      kind: 'ocr',
      candidateSha256: CANDIDATE_SHA,
      engine: 'RapidOCR',
      engineVersion: '3.6.0',
      page: 3,
      meanConfidence: 0.981,
      normalizedSimilarity: 0.141,
      recommendation: 'prefer-ocr-candidate',
    },
    ...overrides,
  }
}

function transaction(operations: AndocOperation[], baseRevision = 0): AndocTransaction {
  return {
    schema: 'andoc.transaction.v1',
    id: 'txn-candidate-1',
    baseRevision,
    actor: { type: 'human', id: 'reviewer-1' },
    timestamp: '2026-07-18T12:00:00.000Z',
    operations,
  }
}

test('applyTextCandidate replaces content and stamps full promotion provenance', () => {
  const next = applyTransaction(baseDocument(), transaction([promotion()]))
  const block = next.blocks[0]!
  assert.equal(block.type, 'paragraph')
  if (block.type !== 'paragraph') return
  assert.equal(block.content.map(run => run.text).join(''), PROMOTED_TEXT)
  const attrs = block.attrs as Record<string, any>
  assert.equal(attrs.textQuality, 'ocr')
  assert.equal(attrs.nativeCandidate.text, '+$ * )* corrupted')
  assert.equal(attrs.nativeCandidate.sha256, sha256(new TextEncoder().encode('+$ * )* corrupted')))
  assert.equal(attrs.promotion.candidateSha256, CANDIDATE_SHA)
  assert.equal(attrs.promotion.reason, 'Reviewed OCR candidate for corrupt-text-map page')
  assert.equal(
    attrs.promotion.acceptedSha256,
    CANDIDATE_SHA,
  )
  assert.equal(attrs.lastEditedBy, 'reviewer-1')
})

test('applyTextCandidate rejects a mismatched expected current text', () => {
  assert.throws(
    () => applyTransaction(baseDocument(), transaction([promotion({ expectedCurrentText: 'something else' })])),
    /Text candidate mismatch/,
  )
})

test('applyTextCandidate rejects proposed content that does not match the referenced candidate hash', () => {
  assert.throws(
    () => applyTransaction(baseDocument(), transaction([promotion({ content: [{ text: 'UNRELATED SUBSTITUTE TEXT' }] })])),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CANDIDATE_CONTENT_MISMATCH')
      assert.match(String((error as Error).message), /p-1 on page 3/)
      assert.match(String((error as Error).message), new RegExp(CANDIDATE_SHA))
      assert.match(String((error as Error).message), /proposed content hashes to [a-f0-9]{64}/)
      return true
    },
  )
})

test('applyTextCandidate rejects a stale base revision with REVISION_CONFLICT', () => {
  const document = { ...baseDocument(), revision: 3 }
  assert.throws(
    () => applyTransaction(document, transaction([promotion()], 0)),
    (error: unknown) => error instanceof RevisionConflictError && error.code === 'REVISION_CONFLICT',
  )
})

test('applyTextCandidate inverse restores the exact prior block including attributes', () => {
  const original = baseDocument()
  const preview = previewTransaction(original, transaction([promotion()]))
  assert.equal(preview.inverseOperations.length, 1)
  const inverse = preview.inverseOperations[0]!
  assert.equal(inverse.op, 'replaceBlock')
  const undone = applyTransaction(preview.document, {
    ...transaction([inverse], preview.document.revision),
    id: 'txn-candidate-undo',
  })
  assert.deepEqual(undone.blocks[0], original.blocks[0])
})

test('applyTextCandidate requires a candidate id and a non-empty reason at the schema layer', () => {
  const missingSha = promotion()
  if (missingSha.op === 'applyTextCandidate') delete (missingSha.candidate as any).candidateSha256
  assert.throws(() => applyTransaction(baseDocument(), transaction([missingSha])), /Invalid transaction/)
  assert.throws(
    () => applyTransaction(baseDocument(), transaction([promotion({ reason: '' })])),
    /Invalid transaction/,
  )
})

test('applyTextCandidate refuses non-text targets', () => {
  assert.throws(
    () => applyTransaction(baseDocument(), transaction([promotion({ targetId: 'pb-1', expectedCurrentText: '' })])),
    /not editable text/,
  )
})
