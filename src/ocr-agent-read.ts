import type { PdfOcrPageCandidate } from './pdf-ocr.js'

export interface PdfOcrAgentReadDecision {
  preferredSource: 'ocr' | 'native' | null
  preferredSha256: string | null
  evidenceState: 'ocr-preferred' | 'native-preferred' | 'compare-required'
  unattendedUse: 'allowed' | 'review-required'
  reviewReasons: string[]
  canonicalChange: false
  guidance: string
}

export function pdfOcrAgentReadDecision(page: PdfOcrPageCandidate): PdfOcrAgentReadDecision {
  const preferredSource = page.comparison.recommendation === 'prefer-ocr-candidate'
    ? 'ocr'
    : page.comparison.recommendation === 'retain-native'
      ? 'native'
      : null
  const reviewReasons = [
    ...(preferredSource === null ? ['Native and OCR evidence disagree without a safe preferred source.'] : []),
    ...(page.comparison.numericReviewRequired
      ? [`Numeric tokens disagree: native-only ${page.comparison.numericAgreement.nativeOnly.join(', ') || 'none'}; OCR-only ${page.comparison.numericAgreement.ocrOnly.join(', ') || 'none'}.`]
      : []),
  ]
  return {
    preferredSource,
    preferredSha256: preferredSource === 'ocr'
      ? page.ocrCandidate.sha256
      : preferredSource === 'native'
        ? page.nativeCandidate.sha256
        : null,
    evidenceState: preferredSource === 'ocr'
      ? 'ocr-preferred'
      : preferredSource === 'native'
        ? 'native-preferred'
        : 'compare-required',
    unattendedUse: reviewReasons.length ? 'review-required' : 'allowed',
    reviewReasons,
    canonicalChange: false,
    guidance: preferredSource === null
      ? 'Do not answer from either page-wide text candidate as settled fact; inspect the source canvas or request human review.'
      : reviewReasons.length
        ? `Use ${preferredSource} text as the leading evidence for non-disputed content, but verify flagged numeric content against the source canvas before answering.`
        : `Use ${preferredSource} text as the leading page evidence; cite the retained source and candidate hash.`,
  }
}
