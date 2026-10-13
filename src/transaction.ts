import type { AndocBlock, AndocDocument, AndocTransaction, Provenance, TableBlock, TableCell } from './types.js'
import { chartDataIssues } from './chart-data.js'
import { sha256 } from './hash.js'
import { validateDocument, validateTransaction } from './validate.js'

export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT'

  constructor(
    public readonly currentRevision: number,
    public readonly baseRevision: number,
  ) {
    super(`Transaction base revision ${baseRevision} does not match document revision ${currentRevision}`)
    this.name = 'RevisionConflictError'
  }
}

export class TextCandidateContentMismatchError extends Error {
  readonly code = 'CANDIDATE_CONTENT_MISMATCH'

  constructor(
    public readonly targetId: string,
    public readonly page: number,
    public readonly candidateSha256: string,
    public readonly proposedContentSha256: string,
  ) {
    super(
      `Text candidate content hash mismatch for ${targetId} on page ${page}: `
      + `candidate evidence requires ${candidateSha256}, but the proposed content hashes to ${proposedContentSha256}`,
    )
    this.name = 'TextCandidateContentMismatchError'
  }
}

export function applyTransaction(document: AndocDocument, transaction: AndocTransaction): AndocDocument {
  const transactionValidation = validateTransaction(transaction)
  if (!transactionValidation.ok) {
    throw new Error(`Invalid transaction: ${transactionValidation.issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
  }
  if (transaction.baseRevision !== document.revision) {
    throw new RevisionConflictError(document.revision, transaction.baseRevision)
  }

  const next: AndocDocument = structuredClone(document)

  for (const operation of transaction.operations) {
    if (operation.op === 'addAsset') {
      const existing = next.assets[operation.asset.id]
      if (existing) {
        if (!sameAssetMetadata(existing, operation.asset)) throw new Error(`Asset id already exists with different metadata: ${operation.asset.id}`)
        continue
      }
      const duplicatePath = Object.values(next.assets).find(asset => asset.packagePath === operation.asset.packagePath)
      if (duplicatePath) throw new Error(`Asset package path already exists: ${operation.asset.packagePath}`)
      next.assets[operation.asset.id] = structuredClone(operation.asset)
      continue
    }

    if (operation.op === 'insertBlocks') {
      assertNewBlockIds(next.blocks, operation.blocks)
      if (operation.afterId === null) {
        next.blocks.unshift(...structuredClone(operation.blocks))
      } else {
        const index = blockIndex(next.blocks, operation.afterId)
        next.blocks.splice(index + 1, 0, ...structuredClone(operation.blocks))
      }
      continue
    }

    if (operation.op === 'moveBlock') {
      if (operation.afterId === operation.targetId) throw new Error('A block cannot be moved after itself')
      const fromIndex = blockIndex(next.blocks, operation.targetId)
      if (operation.afterId !== null) blockIndex(next.blocks, operation.afterId)
      const [block] = next.blocks.splice(fromIndex, 1)
      if (!block) throw new Error(`Block not found: ${operation.targetId}`)
      if (operation.afterId === null) next.blocks.unshift(block)
      else next.blocks.splice(blockIndex(next.blocks, operation.afterId) + 1, 0, block)
      continue
    }

    if (operation.op === 'replaceBlock') {
      const index = blockIndex(next.blocks, operation.targetId)
      const duplicate = next.blocks.find((block, candidate) => block.id === operation.block.id && candidate !== index)
      if (duplicate) throw new Error(`Replacement block id already exists: ${operation.block.id}`)
      next.blocks[index] = structuredClone(operation.block)
      continue
    }

    if (operation.op === 'removeBlock') {
      next.blocks.splice(blockIndex(next.blocks, operation.targetId), 1)
      continue
    }

    if (operation.op === 'updateTextBlock') {
      const block = next.blocks[blockIndex(next.blocks, operation.targetId)]
      if (block?.type !== 'heading' && block?.type !== 'paragraph') throw new Error(`Block is not editable text: ${operation.targetId}`)
      if (operation.level !== undefined && block.type !== 'heading') throw new Error('Heading level can only be set on a heading block')
      block.content = structuredClone(operation.content)
      if (block.type === 'heading' && operation.level !== undefined) block.level = operation.level
      stampBlockEdit(block, transaction)
      continue
    }

    if (operation.op === 'applyTextCandidate') {
      const block = next.blocks[blockIndex(next.blocks, operation.targetId)]
      if (block?.type !== 'heading' && block?.type !== 'paragraph') throw new Error(`Block is not editable text: ${operation.targetId}`)
      const currentText = block.content.map(run => run.text).join('')
      if (currentText !== operation.expectedCurrentText) {
        throw new Error(`Text candidate mismatch for ${operation.targetId}: the block's current text does not match expectedCurrentText; reload the block and re-review the candidate`)
      }
      const encoder = new TextEncoder()
      const proposedContentSha256 = sha256(encoder.encode(operation.content.map(run => run.text).join('')))
      if (proposedContentSha256 !== operation.candidate.candidateSha256) {
        throw new TextCandidateContentMismatchError(
          operation.targetId,
          operation.candidate.page,
          operation.candidate.candidateSha256,
          proposedContentSha256,
        )
      }
      block.attrs = {
        ...(block.attrs || {}),
        textQuality: 'ocr',
        nativeCandidate: {
          text: currentText,
          sha256: sha256(encoder.encode(currentText)),
          ...(block.attrs?.textQuality ? { priorTextQuality: block.attrs.textQuality } : {}),
        },
        promotion: {
          ...structuredClone(operation.candidate),
          acceptedSha256: proposedContentSha256,
          reason: operation.reason,
        },
      }
      block.content = structuredClone(operation.content)
      stampBlockEdit(block, transaction)
      continue
    }

    if (operation.op === 'updateTableCell') {
      const table = next.blocks[blockIndex(next.blocks, operation.tableId)]
      if (table?.type !== 'table') throw new Error(`Block is not a table: ${operation.tableId}`)
      const cell = table.rows.flat().find(candidate => candidate.id === operation.cellId)
      if (!cell) throw new Error(`Table cell not found in ${operation.tableId}: ${operation.cellId}`)
      const sourceProvenance = cell.attrs?.sourceProvenance || cell.provenance
      cell.content = structuredClone(operation.content)
      cell.attrs = {
        ...(cell.attrs || {}),
        ...(sourceProvenance ? { sourceProvenance: structuredClone(sourceProvenance) } : {}),
        lastEditedBy: transaction.actor.id,
        lastEditedAt: transaction.timestamp,
      }
      cell.provenance = transactionProvenance(transaction)
      continue
    }

    if (operation.op === 'insertTableRow') {
      const table = editableTable(next, operation.tableId)
      const columns = simpleTableColumnCount(table)
      if (columns > 0 && operation.cells.length !== columns) throw new Error(`Inserted row has ${operation.cells.length} cells; expected ${columns}`)
      if (operation.afterRowIndex !== null && (operation.afterRowIndex < 0 || operation.afterRowIndex >= table.rows.length)) throw new Error(`Table row index is out of range: ${operation.afterRowIndex}`)
      assertNewCellIds(next, operation.cells)
      const cells = structuredClone(operation.cells)
      cells.forEach(cell => stampCellEdit(cell, transaction))
      table.rows.splice(operation.afterRowIndex === null ? 0 : operation.afterRowIndex + 1, 0, cells)
      stampBlockEdit(table, transaction)
      continue
    }

    if (operation.op === 'removeTableRow') {
      const table = editableTable(next, operation.tableId)
      simpleTableColumnCount(table)
      if (table.rows.length <= 1) throw new Error('A table must retain at least one row')
      if (operation.rowIndex < 0 || operation.rowIndex >= table.rows.length) throw new Error(`Table row index is out of range: ${operation.rowIndex}`)
      table.rows.splice(operation.rowIndex, 1)
      stampBlockEdit(table, transaction)
      continue
    }

    if (operation.op === 'insertTableColumn') {
      const table = editableTable(next, operation.tableId)
      const columns = simpleTableColumnCount(table)
      if (!table.rows.length) throw new Error('Cannot insert a column into a table without rows')
      if (operation.cells.length !== table.rows.length) throw new Error(`Inserted column has ${operation.cells.length} cells; expected ${table.rows.length}`)
      if (operation.afterColumnIndex !== null && (operation.afterColumnIndex < 0 || operation.afterColumnIndex >= columns)) throw new Error(`Table column index is out of range: ${operation.afterColumnIndex}`)
      assertNewCellIds(next, operation.cells)
      const cells = structuredClone(operation.cells)
      const columnIndex = operation.afterColumnIndex === null ? 0 : operation.afterColumnIndex + 1
      table.rows.forEach((row, rowIndex) => {
        const cell = cells[rowIndex]!
        stampCellEdit(cell, transaction)
        row.splice(columnIndex, 0, cell)
      })
      stampBlockEdit(table, transaction)
      continue
    }

    if (operation.op === 'removeTableColumn') {
      const table = editableTable(next, operation.tableId)
      const columns = simpleTableColumnCount(table)
      if (columns <= 1) throw new Error('A table must retain at least one column')
      if (operation.columnIndex < 0 || operation.columnIndex >= columns) throw new Error(`Table column index is out of range: ${operation.columnIndex}`)
      table.rows.forEach(row => row.splice(operation.columnIndex, 1))
      stampBlockEdit(table, transaction)
      continue
    }

    if (operation.op === 'updateMediaMetadata') {
      const media = next.blocks[blockIndex(next.blocks, operation.targetId)]
      if (media?.type !== 'image' && media?.type !== 'chart') throw new Error(`Block is not image or chart media: ${operation.targetId}`)
      const sourceProvenance = media.attrs?.sourceProvenance || media.provenance
      if (operation.patch.alt !== undefined) media.alt = operation.patch.alt
      if (operation.patch.caption !== undefined) media.caption = structuredClone(operation.patch.caption)
      media.attrs = {
        ...(media.attrs || {}),
        ...(sourceProvenance ? { sourceProvenance: structuredClone(sourceProvenance) } : {}),
        lastEditedBy: transaction.actor.id,
        lastEditedAt: transaction.timestamp,
      }
      media.provenance = transactionProvenance(transaction)
      continue
    }

    if (operation.op === 'updateChartData') {
      const chart = next.blocks[blockIndex(next.blocks, operation.targetId)]
      if (chart?.type !== 'chart') throw new Error(`Block is not a chart: ${operation.targetId}`)
      const dataIssues = chartDataIssues(operation.data)
      if (dataIssues.length) throw new Error(dataIssues.join('; '))
      const sourceProvenance = chart.attrs?.sourceProvenance || chart.provenance
      const currentExtraction = chart.spec.extraction && typeof chart.spec.extraction === 'object' && !Array.isArray(chart.spec.extraction)
        ? chart.spec.extraction as Record<string, unknown>
        : {}
      chart.spec = {
        ...chart.spec,
        schema: 'andoc.chart.v1',
        data: structuredClone(operation.data),
        extraction: {
          ...currentExtraction,
          status: operation.evidence.verified ? 'verified-structured-data' : 'unverified-structured-data',
          method: operation.evidence.method,
          source: operation.evidence.source,
          verified: operation.evidence.verified,
          confidence: operation.evidence.confidence ?? null,
          ...(operation.evidence.notes !== undefined ? { notes: operation.evidence.notes } : {}),
        },
      }
      chart.attrs = {
        ...(chart.attrs || {}),
        ...(sourceProvenance ? { sourceProvenance: structuredClone(sourceProvenance) } : {}),
        chartDataEvidence: structuredClone(operation.evidence),
        lastEditedBy: transaction.actor.id,
        lastEditedAt: transaction.timestamp,
      }
      chart.provenance = transactionProvenance(transaction, operation.evidence.confidence)
      continue
    }

    if (operation.op === 'setDocument') {
      if (operation.patch.title !== undefined) next.title = operation.patch.title
      if (operation.patch.locale !== undefined) next.locale = operation.patch.locale
      if (operation.patch.metadata !== undefined) {
        next.metadata = { ...next.metadata, ...structuredClone(operation.patch.metadata) }
      }
    }

    if (operation.op === 'replaceDocumentMetadata') {
      next.metadata = structuredClone(operation.metadata)
    }
  }

  next.revision += 1
  next.updatedAt = transaction.timestamp
  const validation = validateDocument(next)
  if (!validation.ok) {
    throw new Error(`Transaction produced an invalid document: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
  }
  return next
}

function sameAssetMetadata(left: AndocDocument['assets'][string], right: AndocDocument['assets'][string]): boolean {
  return left.id === right.id
    && left.packagePath === right.packagePath
    && left.mediaType === right.mediaType
    && left.sha256 === right.sha256
    && left.size === right.size
    && left.originalName === right.originalName
    && left.description === right.description
}

function transactionProvenance(transaction: AndocTransaction, confidence?: number): Provenance {
  const kind: Provenance['kind'] = transaction.actor.type === 'agent'
    ? 'agent'
    : transaction.actor.type === 'human'
      ? 'human'
      : transaction.actor.type === 'import'
        ? 'imported'
        : 'generated'
  return { kind, sourceId: transaction.actor.id, capturedAt: transaction.timestamp, ...(confidence !== undefined ? { confidence } : {}) }
}

function stampBlockEdit(block: AndocBlock, transaction: AndocTransaction): void {
  const sourceProvenance = block.attrs?.sourceProvenance || block.provenance
  block.attrs = {
    ...(block.attrs || {}),
    ...(sourceProvenance ? { sourceProvenance: structuredClone(sourceProvenance) } : {}),
    lastEditedBy: transaction.actor.id,
    lastEditedAt: transaction.timestamp,
  }
  block.provenance = transactionProvenance(transaction)
}

function stampCellEdit(cell: TableCell, transaction: AndocTransaction): void {
  const sourceProvenance = cell.attrs?.sourceProvenance || cell.provenance
  cell.attrs = {
    ...(cell.attrs || {}),
    ...(sourceProvenance ? { sourceProvenance: structuredClone(sourceProvenance) } : {}),
    lastEditedBy: transaction.actor.id,
    lastEditedAt: transaction.timestamp,
  }
  cell.provenance = transactionProvenance(transaction)
}

function editableTable(document: AndocDocument, tableId: string): TableBlock {
  const table = document.blocks[blockIndex(document.blocks, tableId)]
  if (table?.type !== 'table') throw new Error(`Block is not a table: ${tableId}`)
  return table
}

function simpleTableColumnCount(table: TableBlock): number {
  if (table.rows.some(row => row.some(cell => (cell.colspan || 1) !== 1 || (cell.rowspan || 1) !== 1))) {
    throw new Error('Structural row and column operations do not yet support spanned table cells')
  }
  const columns = table.rows[0]?.length || 0
  if (table.rows.some(row => row.length !== columns)) throw new Error('Structural row and column operations require a rectangular table')
  return columns
}

function assertNewCellIds(document: AndocDocument, cells: TableCell[]): void {
  const ids = new Set(document.blocks.flatMap(block => [block.id, ...(block.type === 'table' ? block.rows.flat().map(cell => cell.id) : [])]))
  for (const cell of cells) {
    if (ids.has(cell.id)) throw new Error(`Node id already exists: ${cell.id}`)
    ids.add(cell.id)
  }
}

function blockIndex(blocks: AndocBlock[], id: string): number {
  const index = blocks.findIndex(block => block.id === id)
  if (index < 0) throw new Error(`Block not found: ${id}`)
  return index
}

function assertNewBlockIds(existing: AndocBlock[], incoming: AndocBlock[]): void {
  const ids = new Set(existing.flatMap(block => [block.id, ...(block.type === 'table' ? block.rows.flat().map(cell => cell.id) : [])]))
  for (const block of incoming) {
    if (ids.has(block.id)) throw new Error(`Block id already exists: ${block.id}`)
    ids.add(block.id)
    if (block.type === 'table') {
      for (const cell of block.rows.flat()) {
        if (ids.has(cell.id)) throw new Error(`Node id already exists: ${cell.id}`)
        ids.add(cell.id)
      }
    }
  }
}
