export * from './types.js'
export * from './agent-shared-content.js'
export * from './chart-data.js'
export * from './caption-assist.js'
export * from './conflict-review.js'
export * from './conformance.js'
export * from './document-lock.js'
export * from './block-visibility.js'
export * from './pdf-export.js'
export * from './ocr-agent-read.js'
export * from './pdf-text-quality.js'
export * from './portable-exports.js'
export * from './hash.js'
export * from './profiles.js'
export * from './finalization.js'
export * from './import-pdf.js'
export * from './package.js'
export * from './render.js'
export * from './revision.js'
export * from './revision-review.js'
export * from './revision-patches.js'
export * from './review.js'
export * from './relationships.js'
export * from './release-control.js'
export * from './region-evidence.js'
export * from './semantic-diff.js'
export * from './source-baseline.js'
export * from './assets.js'
export * from './agent-evidence-compact.js'
export * from './agent-response.js'
export * from './agent-evidence-trace.js'
export * from './agent-tools.js'
export * from './transaction.js'
export * from './validate.js'
export * from './viewer-server.js'

// Canonical ANX SDK names. Agn* and Andoc* function names remain exported for
// source compatibility throughout the pre-1.0 transition.
export {
  packAndoc as packAnx,
  readAndoc as readAnx,
  repackAndocPackage as repackAnxPackage,
  unpackAndoc as unpackAnx,
  validateAndoc as validateAnx,
} from './package.js'
export { importDocumentToAndoc as importDocumentToAnx, importPdfToAndoc as importPdfToAnx } from './import-pdf.js'
export { exportAndocPdf as exportAnxPdf } from './pdf-export.js'
export { transactAndocPackage as transactAnxPackage } from './revision.js'
export {
  attachAndocFinalizationReceipt as attachAnxFinalizationReceipt,
  cosignAndoc as cosignAnx,
  deriveAndocDraft as deriveAnxDraft,
  finalizeAndoc as finalizeAnx,
  inspectAndocCapabilities as inspectAnxCapabilities,
  setAndocProfiles as setAnxProfiles,
  verifyAndocFinalization as verifyAnxFinalization,
  verifyAndocLineage as verifyAnxLineage,
} from './finalization.js'
export {
  anxPageEvidence,
  anxRelationships,
  andocApply as anxApply,
  andocCite as anxCite,
  andocContext as anxContext,
  andocEditLocate as anxEditLocate,
  andocGet as anxGet,
  andocGetBatch as anxGetBatch,
  andocOpen as anxOpen,
  andocOutline as anxOutline,
  andocPreview as anxPreview,
  andocQuery as anxQuery,
  andocRegions as anxRegions,
  andocReadAdaptive as anxRead,
  andocReviewPropose as anxReviewPropose,
  andocReviewStatus as anxReviewStatus,
  andocSearch as anxSearch,
  andocSharedContent as anxSharedContent,
  andocTextQuality as anxTextQuality,
} from './agent-tools.js'

// Legacy AGN SDK aliases.
export {
  packAndoc as packAgn,
  readAndoc as readAgn,
  repackAndocPackage as repackAgnPackage,
  unpackAndoc as unpackAgn,
  validateAndoc as validateAgn,
} from './package.js'
export {
  anxPageEvidence as agnPageEvidence,
  andocApply as agnApply,
  andocCite as agnCite,
  andocContext as agnContext,
  andocEditLocate as agnEditLocate,
  andocGet as agnGet,
  andocGetBatch as agnGetBatch,
  andocOpen as agnOpen,
  andocOutline as agnOutline,
  andocPreview as agnPreview,
  andocQuery as agnQuery,
  andocRegions as agnRegions,
  andocReadAdaptive as agnRead,
  andocReviewPropose as agnReviewPropose,
  andocReviewStatus as agnReviewStatus,
  andocSearch as agnSearch,
  andocSharedContent as agnSharedContent,
  andocTextQuality as agnTextQuality,
} from './agent-tools.js'
