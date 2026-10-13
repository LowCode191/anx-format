import { applyTransaction } from './transaction.js'
import type { AndocBlock, AndocDocument, AndocOperation, AndocTransaction } from './types.js'

export interface TransactionChange {
  index: number
  op: AndocOperation['op']
  targetId?: string
  description: string
}

export interface TransactionPreview {
  document: AndocDocument
  changes: TransactionChange[]
  inverseOperations: AndocOperation[]
}

export function previewTransaction(document: AndocDocument, transaction: AndocTransaction): TransactionPreview {
  const next = applyTransaction(document, transaction)
  const inverseOperations = inverseTransactionOperations(document, transaction)
  return { document: next, changes: describeTransaction(transaction), inverseOperations }
}

export function describeTransaction(transaction: AndocTransaction): TransactionChange[] {
  return transaction.operations.map((operation, index) => ({
    index,
    op: operation.op,
    ...operationDescription(operation),
  }))
}

export function inverseTransactionOperations(document: AndocDocument, transaction: AndocTransaction): AndocOperation[] {
  let draft = structuredClone(document)
  let inverse: AndocOperation[] = []
  transaction.operations.forEach((operation, index) => {
    inverse = [...inverseForOperation(draft, operation), ...inverse]
    draft = applyTransaction(draft, {
      ...transaction,
      id: `${transaction.id}:inverse-preview:${index}`,
      baseRevision: draft.revision,
      operations: [structuredClone(operation)],
    })
  })
  return inverse
}

function inverseForOperation(document: AndocDocument, operation: AndocOperation): AndocOperation[] {
  if (operation.op === 'addAsset') {
    // Assets are immutable and retained when they become unreferenced so an
    // undo/redo cycle never loses the bytes needed to restore a media block.
    return []
  }
  if (operation.op === 'insertBlocks') {
    return [...operation.blocks].reverse().map(block => ({ op: 'removeBlock', targetId: block.id }))
  }
  if (operation.op === 'moveBlock') {
    return [{ op: 'moveBlock', targetId: operation.targetId, afterId: previousBlockId(document, operation.targetId) }]
  }
  if (operation.op === 'replaceBlock') {
    return [{ op: 'replaceBlock', targetId: operation.block.id, block: structuredClone(blockById(document, operation.targetId)) }]
  }
  if (operation.op === 'removeBlock') {
    return [{ op: 'insertBlocks', afterId: previousBlockId(document, operation.targetId), blocks: [structuredClone(blockById(document, operation.targetId))] }]
  }
  if (operation.op === 'setDocument') {
    const result: AndocOperation[] = []
    const patch: Extract<AndocOperation, { op: 'setDocument' }>['patch'] = {}
    if (operation.patch.title !== undefined) patch.title = document.title
    if (operation.patch.locale !== undefined) patch.locale = document.locale
    if (Object.keys(patch).length) result.push({ op: 'setDocument', patch })
    if (operation.patch.metadata !== undefined) result.push({ op: 'replaceDocumentMetadata', metadata: structuredClone(document.metadata) })
    return result
  }
  if (operation.op === 'replaceDocumentMetadata') {
    return [{ op: 'replaceDocumentMetadata', metadata: structuredClone(document.metadata) }]
  }
  if (operation.op === 'updateTableCell' || operation.op === 'insertTableRow' || operation.op === 'removeTableRow' || operation.op === 'insertTableColumn' || operation.op === 'removeTableColumn') {
    return [{ op: 'replaceBlock', targetId: operation.tableId, block: structuredClone(blockById(document, operation.tableId)) }]
  }
  return [{ op: 'replaceBlock', targetId: operation.targetId, block: structuredClone(blockById(document, operation.targetId)) }]
}

function operationDescription(operation: AndocOperation): Omit<TransactionChange, 'index' | 'op'> {
  switch (operation.op) {
    case 'addAsset':
      return { targetId: operation.asset.id, description: `Add immutable asset ${operation.asset.id}` }
    case 'insertBlocks':
      return { targetId: operation.afterId || undefined, description: `Insert ${operation.blocks.length} block(s)${operation.afterId ? ` after ${operation.afterId}` : ' at the beginning'}` }
    case 'moveBlock':
      return { targetId: operation.targetId, description: `Move ${operation.targetId}${operation.afterId ? ` after ${operation.afterId}` : ' to the beginning'}` }
    case 'replaceBlock':
      return { targetId: operation.targetId, description: `Replace block ${operation.targetId}` }
    case 'removeBlock':
      return { targetId: operation.targetId, description: `Remove block ${operation.targetId}` }
    case 'updateTextBlock':
      return { targetId: operation.targetId, description: `Update text block ${operation.targetId}` }
    case 'applyTextCandidate':
      return { targetId: operation.targetId, description: `Apply reviewed ${operation.candidate.kind} text candidate (${operation.candidate.candidateSha256.slice(0, 12)}…) to ${operation.targetId}` }
    case 'updateTableCell':
      return { targetId: operation.cellId, description: `Update cell ${operation.cellId} in ${operation.tableId}` }
    case 'insertTableRow':
      return { targetId: operation.tableId, description: `Insert a row in ${operation.tableId}` }
    case 'removeTableRow':
      return { targetId: operation.tableId, description: `Remove row ${operation.rowIndex} from ${operation.tableId}` }
    case 'insertTableColumn':
      return { targetId: operation.tableId, description: `Insert a column in ${operation.tableId}` }
    case 'removeTableColumn':
      return { targetId: operation.tableId, description: `Remove column ${operation.columnIndex} from ${operation.tableId}` }
    case 'updateMediaMetadata':
      return { targetId: operation.targetId, description: `Update media metadata for ${operation.targetId}` }
    case 'updateChartData':
      return { targetId: operation.targetId, description: `Update structured chart data for ${operation.targetId}` }
    case 'setDocument':
      return { description: `Update document ${Object.keys(operation.patch).join(', ')}` }
    case 'replaceDocumentMetadata':
      return { description: 'Replace document metadata' }
  }
}

function blockById(document: AndocDocument, id: string): AndocBlock {
  const block = document.blocks.find(candidate => candidate.id === id)
  if (!block) throw new Error(`Block not found: ${id}`)
  return block
}

function previousBlockId(document: AndocDocument, id: string): string | null {
  const index = document.blocks.findIndex(block => block.id === id)
  if (index < 0) throw new Error(`Block not found: ${id}`)
  return index > 0 ? document.blocks[index - 1]!.id : null
}
