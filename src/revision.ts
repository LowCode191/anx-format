import { ANX_SOURCE_BASELINES_PATH, packAndoc, type AndocPackage } from './package.js'
import { packagePdfOcrCandidates } from './pdf-ocr.js'
import { applyTransaction } from './transaction.js'
import { reviewableContentSha256 } from './review.js'
import type { AndocDocument, AndocTransaction } from './types.js'

export interface PackageTransactionResult {
  document: AndocDocument
  packageBytes: Uint8Array
}

export class FinalizedDocumentError extends Error {
  readonly code = 'DOCUMENT_FINALIZED'
  constructor(readonly finalizationId: string, readonly revision: number) {
    super(`Document revision ${revision} is finalized by ${finalizationId}; derive a new draft instead of mutating the finalized package`)
    this.name = 'FinalizedDocumentError'
  }
}

export class CandidateEvidenceError extends Error {
  readonly code = 'CANDIDATE_EVIDENCE_UNRESOLVED'
  constructor(message: string) {
    super(message)
    this.name = 'CandidateEvidenceError'
  }
}

function assertCandidateEvidence(pkg: AndocPackage, transaction: AndocTransaction): void {
  const promotions = transaction.operations.filter(operation => operation.op === 'applyTextCandidate')
  if (!promotions.length) return
  const evidence = packagePdfOcrCandidates(pkg)
  if (!evidence) {
    throw new CandidateEvidenceError(
      'applyTextCandidate requires retained candidate evidence at sources/ocr/candidates.json; generate and attach it first (agn ocr-candidates <pkg> <pages> --attach)',
    )
  }
  const retainedPdf = pkg.manifest.entries.find(
    entry => entry.path.startsWith('sources/original/') && entry.mediaType === 'application/pdf',
  )
  if (!retainedPdf || evidence.sourceSha256 !== retainedPdf.sha256) {
    throw new CandidateEvidenceError(
      `applyTextCandidate evidence source hash does not match the retained PDF: expected ${retainedPdf?.sha256 || 'missing'}, received ${evidence.sourceSha256}`,
    )
  }
  for (const operation of promotions) {
    if (operation.op !== 'applyTextCandidate') continue
    const page = evidence.pages.find(candidate => candidate.page === operation.candidate.page)
    if (!page) {
      throw new CandidateEvidenceError(`applyTextCandidate references page ${operation.candidate.page}, but the retained candidates report has no candidate for that page`)
    }
    if (page.ocrCandidate.sha256 !== operation.candidate.candidateSha256) {
      throw new CandidateEvidenceError(
        `applyTextCandidate candidate hash does not match retained evidence for page ${operation.candidate.page}: expected ${page.ocrCandidate.sha256}, received ${operation.candidate.candidateSha256}`,
      )
    }
    if (evidence.engine.name !== operation.candidate.engine || evidence.engine.version !== operation.candidate.engineVersion) {
      throw new CandidateEvidenceError(
        `applyTextCandidate engine ${operation.candidate.engine}@${operation.candidate.engineVersion} does not match the retained evidence engine ${evidence.engine.name}@${evidence.engine.version}`,
      )
    }
  }
}

export async function transactAndocPackage(
  pkg: AndocPackage,
  transaction: AndocTransaction,
  newAssets: Record<string, Uint8Array> = {},
): Promise<PackageTransactionResult> {
  const finalization = pkg.finalizations[0]
  if (finalization) throw new FinalizedDocumentError(finalization.id, finalization.revision)
  assertCandidateEvidence(pkg, transaction)
  const document = applyTransaction(pkg.document, transaction)
  const lifecycleState = typeof pkg.document.metadata?.anxReleaseControl === 'object' && pkg.document.metadata.anxReleaseControl !== null
    ? (pkg.document.metadata.anxReleaseControl as Record<string, unknown>).state
    : null
  if ((lifecycleState === 'review' || lifecycleState === 'approved')
    && reviewableContentSha256(document) !== reviewableContentSha256(pkg.document)) {
    throw new Error(`DOCUMENT_UNDER_RELEASE_REVIEW: content is ${String(lifecycleState).toUpperCase()}; request changes before editing`)
  }
  const assets = Object.fromEntries(Object.values(document.assets).map(asset => {
    const bytes = newAssets[asset.id] || pkg.files[asset.packagePath]
    if (!bytes) throw new Error(`Package transaction cannot preserve missing asset bytes: ${asset.id}`)
    return [asset.id, bytes]
  }))
  for (const assetId of Object.keys(newAssets)) {
    if (!document.assets[assetId]) throw new Error(`Asset bytes were supplied without canonical metadata: ${assetId}`)
  }
  const sources = Object.fromEntries(Object.entries(pkg.files).filter(([entryPath]) => entryPath.startsWith('sources/') && entryPath !== ANX_SOURCE_BASELINES_PATH))
  const packageBytes = await packAndoc({
    document,
    versionBaseline: pkg.versionBaseline || pkg.document,
    assets,
    sources,
    transactions: [...pkg.transactions, transaction],
    ...(pkg.profiles ? { profiles: pkg.profiles } : {}),
    ...(pkg.lineage ? { lineage: pkg.lineage } : {}),
    ...(pkg.sourceBaselines ? { sourceBaselines: pkg.sourceBaselines } : {}),
  })
  return { document, packageBytes }
}
