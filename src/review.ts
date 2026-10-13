import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson, sha256 } from './hash.js'
import { previewTransaction } from './revision-review.js'
import type { AndocActor, AndocDocument, AndocOperation, AndocTransaction } from './types.js'

export const AGN_REVIEW_METADATA_KEY = 'agnReview'
export const AGN_REVIEW_SCHEMA = 'agn.review.v1' as const

export type ReviewAnnotationKind = 'comment' | 'highlight'
export type ReviewDecision = 'approved' | 'changes-requested'

export interface ReviewAnchor {
  targetId: string
  page?: number
  bbox?: [number, number, number, number]
}

export interface ReviewAnnotation {
  id: string
  kind: ReviewAnnotationKind
  anchor: ReviewAnchor
  body?: string
  author: AndocActor
  createdAt: string
  status: 'open' | 'resolved'
  resolvedAt?: string
  resolvedBy?: AndocActor
}

export interface ReviewProposal {
  id: string
  author: AndocActor
  createdAt: string
  baseRevision: number
  message: string
  operations: AndocOperation[]
  targetFingerprints: Record<string, string>
  status: 'open' | 'accepted' | 'rejected'
  decidedAt?: string
  decidedBy?: AndocActor
  decisionNote?: string
  appliedRevision?: number
}

export interface ReviewApproval {
  id: string
  reviewer: AndocActor
  createdAt: string
  reviewedRevision: number
  decision: ReviewDecision
  contentSha256?: string
  note?: string
}

export interface AgnReviewState {
  schema: typeof AGN_REVIEW_SCHEMA
  annotations: ReviewAnnotation[]
  proposals: ReviewProposal[]
  approvals: ReviewApproval[]
}

export interface ReviewMutationOptions {
  actor: AndocActor
  timestamp?: string
  id?: string
  message?: string
  documentMetadataPatch?: Record<string, unknown>
}

export function reviewState(document: AndocDocument): AgnReviewState {
  const candidate = document.metadata[AGN_REVIEW_METADATA_KEY]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return emptyReviewState()
  const value = candidate as Partial<AgnReviewState>
  if (value.schema !== AGN_REVIEW_SCHEMA) return emptyReviewState()
  return {
    schema: AGN_REVIEW_SCHEMA,
    annotations: Array.isArray(value.annotations) ? structuredClone(value.annotations) : [],
    proposals: Array.isArray(value.proposals) ? structuredClone(value.proposals) : [],
    approvals: Array.isArray(value.approvals) ? structuredClone(value.approvals) : [],
  }
}

export function addReviewAnnotationTransaction(
  document: AndocDocument,
  input: { kind: ReviewAnnotationKind; targetId: string; body?: string },
  options: ReviewMutationOptions,
): AndocTransaction {
  if (input.kind !== 'comment' && input.kind !== 'highlight') throw new Error(`Unsupported review annotation kind: ${String(input.kind)}`)
  const timestamp = options.timestamp || new Date().toISOString()
  const anchor = reviewAnchor(document, input.targetId)
  if (input.kind === 'comment' && !input.body?.trim()) throw new Error('A review comment requires a body')
  const state = reviewState(document)
  const annotation: ReviewAnnotation = {
    id: options.id || `annotation-${randomUUID()}`,
    kind: input.kind,
    anchor,
    ...(input.body?.trim() ? { body: input.body.trim() } : {}),
    author: structuredClone(options.actor),
    createdAt: timestamp,
    status: 'open',
  }
  if (state.annotations.some(item => item.id === annotation.id)) throw new Error(`Review annotation already exists: ${annotation.id}`)
  state.annotations.push(annotation)
  return reviewMetadataTransaction(document, state, options, options.message || `Add ${input.kind} on ${input.targetId}`, timestamp)
}

export function resolveReviewAnnotationTransaction(
  document: AndocDocument,
  annotationId: string,
  options: ReviewMutationOptions,
): AndocTransaction {
  const timestamp = options.timestamp || new Date().toISOString()
  const state = reviewState(document)
  const annotation = state.annotations.find(item => item.id === annotationId)
  if (!annotation) throw new Error(`Review annotation not found: ${annotationId}`)
  if (annotation.status === 'resolved') throw new Error(`Review annotation is already resolved: ${annotationId}`)
  annotation.status = 'resolved'
  annotation.resolvedAt = timestamp
  annotation.resolvedBy = structuredClone(options.actor)
  return reviewMetadataTransaction(document, state, options, options.message || `Resolve review annotation ${annotationId}`, timestamp)
}

export function addReviewProposalTransaction(
  document: AndocDocument,
  input: { operations: AndocOperation[]; message: string },
  options: ReviewMutationOptions,
): AndocTransaction {
  if (!input.operations.length) throw new Error('A review proposal requires at least one operation')
  if (!input.message.trim()) throw new Error('A review proposal requires a concise message')
  const timestamp = options.timestamp || new Date().toISOString()
  const preview = previewTransaction(document, {
    schema: 'andoc.transaction.v1',
    id: `proposal-preview-${randomUUID()}`,
    baseRevision: document.revision,
    actor: options.actor,
    timestamp,
    operations: input.operations,
  })
  if (preview.document.revision !== document.revision + 1) throw new Error('Review proposal preview did not produce exactly one revision')
  const state = reviewState(document)
  const proposal: ReviewProposal = {
    id: options.id || `proposal-${randomUUID()}`,
    author: structuredClone(options.actor),
    createdAt: timestamp,
    baseRevision: document.revision,
    message: input.message.trim(),
    operations: structuredClone(input.operations),
    targetFingerprints: proposalTargetFingerprints(document, input.operations),
    status: 'open',
  }
  if (state.proposals.some(item => item.id === proposal.id)) throw new Error(`Review proposal already exists: ${proposal.id}`)
  state.proposals.push(proposal)
  return reviewMetadataTransaction(document, state, options, options.message || `Propose: ${proposal.message}`, timestamp)
}

export function decideReviewProposalTransaction(
  document: AndocDocument,
  input: { proposalId: string; decision: 'accept' | 'reject'; note?: string },
  options: ReviewMutationOptions,
): AndocTransaction {
  if (input.decision !== 'accept' && input.decision !== 'reject') throw new Error(`Unsupported review proposal decision: ${String(input.decision)}`)
  const timestamp = options.timestamp || new Date().toISOString()
  const state = reviewState(document)
  const proposal = state.proposals.find(item => item.id === input.proposalId)
  if (!proposal) throw new Error(`Review proposal not found: ${input.proposalId}`)
  if (proposal.status !== 'open') throw new Error(`Review proposal is already ${proposal.status}: ${input.proposalId}`)
  if (input.decision === 'accept') assertProposalTargetsUnchanged(document, proposal)
  proposal.status = input.decision === 'accept' ? 'accepted' : 'rejected'
  proposal.decidedAt = timestamp
  proposal.decidedBy = structuredClone(options.actor)
  if (input.note?.trim()) proposal.decisionNote = input.note.trim()
  if (input.decision === 'accept') proposal.appliedRevision = document.revision + 1
  const operations = input.decision === 'accept' ? structuredClone(proposal.operations) : []
  operations.push(reviewMetadataOperation(document, state, options.documentMetadataPatch))
  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: options.id || `review-${randomUUID()}`,
    baseRevision: document.revision,
    actor: structuredClone(options.actor),
    timestamp,
    message: options.message || `${input.decision === 'accept' ? 'Accept' : 'Reject'} review proposal ${proposal.id}`,
    operations,
  }
  previewTransaction(document, transaction)
  return transaction
}

export function recordReviewApprovalTransaction(
  document: AndocDocument,
  input: { decision: ReviewDecision; note?: string; reviewedRevision?: number },
  options: ReviewMutationOptions,
): AndocTransaction {
  if (input.decision !== 'approved' && input.decision !== 'changes-requested') throw new Error(`Unsupported review approval decision: ${String(input.decision)}`)
  const timestamp = options.timestamp || new Date().toISOString()
  const reviewedRevision = input.reviewedRevision ?? document.revision
  if (reviewedRevision !== document.revision) throw new Error(`Approval must review the current revision ${document.revision}; received ${reviewedRevision}`)
  const state = reviewState(document)
  state.approvals.push({
    id: options.id || `approval-${randomUUID()}`,
    reviewer: structuredClone(options.actor),
    createdAt: timestamp,
    reviewedRevision,
    decision: input.decision,
    contentSha256: reviewableContentSha256(document),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  })
  return reviewMetadataTransaction(document, state, options, options.message || `${input.decision} revision ${reviewedRevision}`, timestamp)
}

export function reviewSummary(document: AndocDocument): Record<string, unknown> {
  const state = reviewState(document)
  const latestApproval = [...state.approvals].reverse().find(item => item.reviewedRevision <= document.revision)
  return {
    schema: state.schema,
    documentId: document.documentId,
    revision: document.revision,
    counts: {
      openAnnotations: state.annotations.filter(item => item.status === 'open').length,
      resolvedAnnotations: state.annotations.filter(item => item.status === 'resolved').length,
      openProposals: state.proposals.filter(item => item.status === 'open').length,
      acceptedProposals: state.proposals.filter(item => item.status === 'accepted').length,
      rejectedProposals: state.proposals.filter(item => item.status === 'rejected').length,
      approvals: state.approvals.length,
    },
    latestApproval: latestApproval || null,
    approvedCurrentRevision: latestApproval?.decision === 'approved' && latestApproval.reviewedRevision === document.revision,
    approvedCurrentContent: latestApproval?.decision === 'approved' && latestApproval.contentSha256 === reviewableContentSha256(document),
    state,
  }
}

function emptyReviewState(): AgnReviewState {
  return { schema: AGN_REVIEW_SCHEMA, annotations: [], proposals: [], approvals: [] }
}

function reviewMetadataTransaction(
  document: AndocDocument,
  state: AgnReviewState,
  options: ReviewMutationOptions,
  message: string,
  timestamp: string,
): AndocTransaction {
  return {
    schema: 'andoc.transaction.v1',
    id: options.id || `review-${randomUUID()}`,
    baseRevision: document.revision,
    actor: structuredClone(options.actor),
    timestamp,
    message,
    operations: [reviewMetadataOperation(document, state, options.documentMetadataPatch)],
  }
}

function reviewMetadataOperation(
  document: AndocDocument,
  state: AgnReviewState,
  documentMetadataPatch?: Record<string, unknown>,
): AndocOperation {
  return {
    op: 'setDocument',
    patch: {
      metadata: {
        ...structuredClone(document.metadata),
        ...(documentMetadataPatch ? structuredClone(documentMetadataPatch) : {}),
        [AGN_REVIEW_METADATA_KEY]: state,
      },
    },
  }
}

function reviewAnchor(document: AndocDocument, targetId: string): ReviewAnchor {
  for (const block of document.blocks) {
    if (block.id === targetId) return { targetId, ...sourceAnchor(block) }
    if (block.type === 'table') {
      const cell = block.rows.flat().find(candidate => candidate.id === targetId)
      if (cell) return { targetId, ...sourceAnchor(cell), ...(!cell.provenance?.page ? sourceAnchor(block) : {}) }
    }
    if (block.type === 'list') {
      const item = findListItem(block.items, targetId)
      if (item) return { targetId, ...sourceAnchor(item), ...(!item.provenance?.page ? sourceAnchor(block) : {}) }
    }
  }
  throw new Error(`Review target not found: ${targetId}`)
}

function findListItem(items: Array<{ id: string; children?: unknown[]; provenance?: unknown; attrs?: unknown }>, targetId: string): any | null {
  for (const item of items) {
    if (item.id === targetId) return item
    const nested = findListItem((item.children || []) as typeof items, targetId)
    if (nested) return nested
  }
  return null
}

function sourceAnchor(value: { provenance?: { page?: number; bbox?: [number, number, number, number] }; attrs?: Record<string, unknown> }): Omit<ReviewAnchor, 'targetId'> {
  const source = value.attrs?.sourceProvenance && typeof value.attrs.sourceProvenance === 'object'
    ? value.attrs.sourceProvenance as { page?: number; bbox?: [number, number, number, number] }
    : value.provenance
  return {
    ...(source?.page ? { page: source.page } : {}),
    ...(source?.bbox ? { bbox: source.bbox } : {}),
  }
}

function proposalTargetFingerprints(document: AndocDocument, operations: AndocOperation[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const operation of operations) {
    for (const targetId of operationTargetIds(operation)) {
      if (result[targetId]) continue
      result[targetId] = fingerprint(reviewTargetValue(document, targetId))
    }
  }
  return result
}

function assertProposalTargetsUnchanged(document: AndocDocument, proposal: ReviewProposal): void {
  for (const [targetId, expected] of Object.entries(proposal.targetFingerprints)) {
    const actual = fingerprint(reviewTargetValue(document, targetId))
    if (actual !== expected) throw new Error(`Review proposal target changed after proposal: ${targetId}; rebase and resubmit instead of applying stale operations`)
  }
}

function operationTargetIds(operation: AndocOperation): string[] {
  if (operation.op === 'updateTableCell') return [operation.tableId, operation.cellId]
  if (operation.op === 'insertTableRow' || operation.op === 'removeTableRow' || operation.op === 'insertTableColumn' || operation.op === 'removeTableColumn') return [operation.tableId]
  if (operation.op === 'moveBlock') return operation.afterId ? [operation.targetId, operation.afterId] : [operation.targetId]
  if (operation.op === 'insertBlocks' && operation.afterId) return [operation.afterId]
  if ('targetId' in operation) return [operation.targetId]
  if (operation.op === 'setDocument' || operation.op === 'replaceDocumentMetadata') return ['document']
  return []
}

function reviewTargetValue(document: AndocDocument, targetId: string): unknown {
  if (targetId === 'document') return { title: document.title, locale: document.locale, metadata: metadataWithoutReview(document.metadata) }
  for (const block of document.blocks) {
    if (block.id === targetId) return block
    if (block.type === 'table') {
      const cell = block.rows.flat().find(candidate => candidate.id === targetId)
      if (cell) return cell
    }
    if (block.type === 'list') {
      const item = findListItem(block.items, targetId)
      if (item) return item
    }
  }
  return { missing: targetId }
}

function metadataWithoutReview(metadata: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(metadata)
  delete result[AGN_REVIEW_METADATA_KEY]
  return result
}

export function reviewableContentSha256(document: AndocDocument): string {
  const metadata = metadataWithoutReview(document.metadata)
  delete metadata.anxReleaseControl
  return sha256(Buffer.from(canonicalJson({
    schema: document.schema,
    documentId: document.documentId,
    title: document.title,
    locale: document.locale,
    createdAt: document.createdAt,
    metadata,
    assets: document.assets,
    blocks: document.blocks,
  })))
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
