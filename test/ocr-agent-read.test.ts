import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pdfOcrAgentReadDecision } from '../src/ocr-agent-read.js'
import type { PdfOcrPageCandidate } from '../src/pdf-ocr.js'

function candidate(
  recommendation: PdfOcrPageCandidate['comparison']['recommendation'],
  numericReviewRequired = false,
): PdfOcrPageCandidate {
  return {
    page: 1,
    route: 'ocr-compare',
    nativeCandidate: { text: 'Native 42', sha256: 'a'.repeat(64), metrics: {} as PdfOcrPageCandidate['nativeCandidate']['metrics'] },
    ocrCandidate: {
      text: 'OCR 47',
      sha256: 'b'.repeat(64),
      meanConfidence: 0.97,
      minimumConfidence: 0.95,
      lineCount: 1,
      lines: [],
    },
    comparison: {
      normalizedSimilarity: 0.5,
      tokenOverlap: 0.5,
      numericAgreement: {
        status: numericReviewRequired ? 'disagree' : 'agree',
        nativeTokens: ['42'],
        ocrTokens: numericReviewRequired ? ['47'] : ['42'],
        sharedTokens: numericReviewRequired ? 0 : 1,
        nativeOnly: numericReviewRequired ? ['42'] : [],
        ocrOnly: numericReviewRequired ? ['47'] : [],
      },
      numericReviewRequired,
      recommendation,
      reasons: [],
    },
    render: { widthPixels: 100, heightPixels: 100, dpi: 200 },
    timing: { engineElapsedMs: 1, wallElapsedMs: 1 },
  }
}

test('agent-read decision allows a clean OCR-preferred candidate and binds its hash', () => {
  const decision = pdfOcrAgentReadDecision(candidate('prefer-ocr-candidate'))
  assert.equal(decision.evidenceState, 'ocr-preferred')
  assert.equal(decision.preferredSource, 'ocr')
  assert.equal(decision.preferredSha256, 'b'.repeat(64))
  assert.equal(decision.unattendedUse, 'allowed')
  assert.equal(decision.canonicalChange, false)
})

test('agent-read decision keeps numeric disagreements review-gated', () => {
  const decision = pdfOcrAgentReadDecision(candidate('retain-native', true))
  assert.equal(decision.evidenceState, 'native-preferred')
  assert.equal(decision.preferredSha256, 'a'.repeat(64))
  assert.equal(decision.unattendedUse, 'review-required')
  assert.match(decision.reviewReasons.join(' '), /42/)
  assert.match(decision.guidance, /verify flagged numeric content/)
})

test('agent-read decision abstains when neither candidate is safely preferred', () => {
  const decision = pdfOcrAgentReadDecision(candidate('human-review'))
  assert.equal(decision.evidenceState, 'compare-required')
  assert.equal(decision.preferredSource, null)
  assert.equal(decision.preferredSha256, null)
  assert.equal(decision.unattendedUse, 'review-required')
  assert.match(decision.guidance, /Do not answer/)
})
