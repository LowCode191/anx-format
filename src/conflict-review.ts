import type { AndocBlock, AndocDocument, AndocOperation, AndocTransaction, TableCell } from './types.js'

export interface ConflictProposal {
  operationIndex: number
  operation: AndocOperation['op']
  targetIds: string[]
  overlappingTargetIds: string[]
  overlapsInterveningChange: boolean
  currentValue: unknown
  proposedValue: unknown
}

export interface ConflictReview {
  schema: 'andoc.conflict-review.v1'
  documentId: string
  baseRevision: number
  currentRevision: number
  attemptedTransactionId: string
  interveningTransactions: Array<{
    id: string
    actor: AndocTransaction['actor']
    resultingRevision: number
    targetIds: string[]
  }>
  proposals: ConflictProposal[]
  resolutionRequired: true
  allowedResolutions: ['keep-latest', 'apply-proposal', 'revise-manually']
}

export function buildConflictReview(
  document: AndocDocument,
  history: AndocTransaction[],
  attempted: AndocTransaction,
): ConflictReview {
  const interveningTransactions = history
    .filter(transaction => transaction.baseRevision >= attempted.baseRevision)
    .map(transaction => ({
      id: transaction.id,
      actor: transaction.actor,
      resultingRevision: transaction.baseRevision + 1,
      targetIds: unique(transaction.operations.flatMap(operationTargetIds)),
    }))
  const interveningTargets = new Set(interveningTransactions.flatMap(transaction => transaction.targetIds))
  const proposals = attempted.operations.map((operation, operationIndex) => {
    const targetIds = operationTargetIds(operation)
    const overlappingTargetIds = targetIds.filter(targetId => interveningTargets.has(targetId))
    return {
      operationIndex,
      operation: operation.op,
      targetIds,
      overlappingTargetIds,
      overlapsInterveningChange: overlappingTargetIds.length > 0,
      currentValue: currentOperationValue(document, operation),
      proposedValue: proposedOperationValue(operation),
    }
  })
  return {
    schema: 'andoc.conflict-review.v1',
    documentId: document.documentId,
    baseRevision: attempted.baseRevision,
    currentRevision: document.revision,
    attemptedTransactionId: attempted.id,
    interveningTransactions,
    proposals,
    resolutionRequired: true,
    allowedResolutions: ['keep-latest', 'apply-proposal', 'revise-manually'],
  }
}

export function operationTargetIds(operation: AndocOperation): string[] {
  if (operation.op === 'addAsset') return [`asset:${operation.asset.id}`]
  if (operation.op === 'insertBlocks') return unique([
    ...(operation.afterId ? [operation.afterId] : ['document:blocks']),
    ...operation.blocks.map(block => block.id),
  ])
  if (operation.op === 'updateTableCell') return [operation.tableId, operation.cellId]
  if (operation.op === 'insertTableRow' || operation.op === 'removeTableRow' || operation.op === 'insertTableColumn' || operation.op === 'removeTableColumn') return [operation.tableId]
  if (operation.op === 'setDocument' || operation.op === 'replaceDocumentMetadata') return ['document']
  return [operation.targetId]
}

function currentOperationValue(document: AndocDocument, operation: AndocOperation): unknown {
  if (operation.op === 'addAsset') return document.assets[operation.asset.id] || null
  if (operation.op === 'insertBlocks') return {
    afterId: operation.afterId,
    anchor: operation.afterId ? blockSnapshot(document.blocks.find(block => block.id === operation.afterId)) : null,
  }
  if (operation.op === 'setDocument') return {
    ...(operation.patch.title !== undefined ? { title: document.title } : {}),
    ...(operation.patch.locale !== undefined ? { locale: document.locale } : {}),
    ...(operation.patch.metadata !== undefined ? { metadata: document.metadata } : {}),
  }
  if (operation.op === 'replaceDocumentMetadata') return document.metadata
  if (operation.op === 'updateTableCell') {
    const table = document.blocks.find(block => block.id === operation.tableId)
    const cell = table?.type === 'table' ? table.rows.flat().find(candidate => candidate.id === operation.cellId) : undefined
    return cellSnapshot(cell)
  }
  const targetId = operation.op === 'insertTableRow' || operation.op === 'removeTableRow' || operation.op === 'insertTableColumn' || operation.op === 'removeTableColumn'
    ? operation.tableId
    : operation.targetId
  return blockSnapshot(document.blocks.find(block => block.id === targetId))
}

function proposedOperationValue(operation: AndocOperation): unknown {
  if (operation.op === 'addAsset') return operation.asset
  if (operation.op === 'insertBlocks') return { afterId: operation.afterId, blocks: operation.blocks.map(blockSnapshot) }
  if (operation.op === 'moveBlock') return { targetId: operation.targetId, afterId: operation.afterId }
  if (operation.op === 'replaceBlock') return blockSnapshot(operation.block)
  if (operation.op === 'removeBlock') return null
  if (operation.op === 'updateTextBlock') return { text: runsText(operation.content), ...(operation.level ? { level: operation.level } : {}) }
  if (operation.op === 'updateTableCell') return { text: runsText(operation.content) }
  if (operation.op === 'insertTableRow') return { afterRowIndex: operation.afterRowIndex, cells: operation.cells.map(cellSnapshot) }
  if (operation.op === 'removeTableRow') return { removeRowIndex: operation.rowIndex }
  if (operation.op === 'insertTableColumn') return { afterColumnIndex: operation.afterColumnIndex, cells: operation.cells.map(cellSnapshot) }
  if (operation.op === 'removeTableColumn') return { removeColumnIndex: operation.columnIndex }
  if (operation.op === 'updateMediaMetadata') return operation.patch
  if (operation.op === 'updateChartData') return { data: operation.data, evidence: operation.evidence }
  if (operation.op === 'applyTextCandidate') return { text: runsText(operation.content), candidateSha256: operation.candidate.candidateSha256, reason: operation.reason }
  if (operation.op === 'setDocument') return operation.patch
  return operation.metadata
}

function blockSnapshot(block: AndocBlock | undefined): unknown {
  if (!block) return null
  if (block.type === 'heading') return { id: block.id, type: block.type, level: block.level, text: runsText(block.content) }
  if (block.type === 'paragraph') return { id: block.id, type: block.type, text: runsText(block.content) }
  if (block.type === 'table') return { id: block.id, type: block.type, rows: block.rows.length, columns: block.rows[0]?.length || 0 }
  if (block.type === 'image') return { id: block.id, type: block.type, alt: block.alt, caption: runsText(block.caption), assetId: block.assetId }
  if (block.type === 'chart') return { id: block.id, type: block.type, alt: block.alt, caption: runsText(block.caption), data: block.spec.data || null }
  return { id: block.id, type: block.type }
}

function cellSnapshot(cell: TableCell | undefined): unknown {
  return cell ? { id: cell.id, text: runsText(cell.content), header: Boolean(cell.header) } : null
}

function runsText(runs?: Array<{ text: string }>): string {
  return (runs || []).map(run => run.text).join('')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
