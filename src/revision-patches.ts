import type { AndocBlock, AndocDocument, AndocOperation, AndocTransaction, Provenance } from './types.js'

export interface SourceRevisionPatch {
  targetId: string
  page: number
  revision: number
  operationKinds: string[]
  box: { leftPercent: number; topPercent: number; widthPercent: number; heightPercent: number }
}

export interface SourceRevisionPatchPlan {
  schema: 'agn.source-revision-patch-plan.v1'
  revision: number
  supported: boolean
  patches: SourceRevisionPatch[]
  unsupported: Array<{ transactionId: string; operationIndex: number; operation: string; reason: string }>
  claimBoundary: string
}

const patchableOperations = new Set<AndocOperation['op']>(['updateTextBlock', 'applyTextCandidate', 'updateTableCell'])

export function sourceRevisionPatchPlan(document: AndocDocument, transactions: AndocTransaction[]): SourceRevisionPatchPlan {
  const operationsByTarget = new Map<string, Set<string>>()
  const unsupported: SourceRevisionPatchPlan['unsupported'] = []
  for (const transaction of transactions) {
    transaction.operations.forEach((operation, operationIndex) => {
      if (operation.op === 'addAsset') return
      if (operation.op === 'replaceDocumentMetadata') return
      if (operation.op === 'setDocument' && operation.patch.title === undefined) return
      if (!patchableOperations.has(operation.op)) {
        unsupported.push({ transactionId: transaction.id, operationIndex, operation: operation.op, reason: 'Operation can change layout or source regions beyond one retained bounding box.' })
        return
      }
      const targetId = operation.op === 'updateTableCell'
        ? operation.tableId
        : operation.op === 'updateTextBlock' || operation.op === 'applyTextCandidate'
          ? operation.targetId
          : ''
      if (!targetId) return
      const kinds = operationsByTarget.get(targetId) || new Set<string>()
      kinds.add(operation.op)
      operationsByTarget.set(targetId, kinds)
    })
  }

  const patches: SourceRevisionPatch[] = []
  for (const [targetId, operationKinds] of operationsByTarget) {
    const block = document.blocks.find(candidate => candidate.id === targetId)
    const provenance = sourceProvenance(block)
    if (!block || !provenance?.bbox || !provenance.page) {
      unsupported.push({ transactionId: 'document-state', operationIndex: -1, operation: [...operationKinds].join(','), reason: `Target ${targetId} has no retained source page and bounding box.` })
      continue
    }
    const pageSize = sourcePageSize(document, provenance.page)
    const box = normalizedBox(provenance.bbox, String(block.attrs?.coordinateOrigin || 'BOTTOMLEFT'), pageSize)
    if (!box) {
      unsupported.push({ transactionId: 'document-state', operationIndex: -1, operation: [...operationKinds].join(','), reason: `Target ${targetId} has invalid source geometry.` })
      continue
    }
    patches.push({ targetId, page: provenance.page, revision: document.revision, operationKinds: [...operationKinds].sort(), box })
  }

  return {
    schema: 'agn.source-revision-patch-plan.v1',
    revision: document.revision,
    supported: unsupported.length === 0,
    patches: patches.sort((left, right) => left.page - right.page || left.targetId.localeCompare(right.targetId)),
    unsupported,
    claimBoundary: 'Patches cover retained-source text and table-cell updates with source geometry. Non-visual metadata and locale changes do not invalidate the source canvas. Structural, title, removed, moved, inserted, or unplaced content requires the structured/reflow projection.',
  }
}

function sourceProvenance(block: AndocBlock | undefined): Provenance | null {
  if (!block) return null
  const retained = block.attrs?.sourceProvenance
  if (retained && typeof retained === 'object' && !Array.isArray(retained)) return retained as Provenance
  return block.provenance || null
}

function sourcePageSize(document: AndocDocument, page: number): { width: number; height: number } {
  const layout = document.metadata.layout
  const sizes = layout && typeof layout === 'object' && !Array.isArray(layout) ? (layout as Record<string, unknown>).sourcePageSizes : null
  const raw = sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? (sizes as Record<string, unknown>)[String(page)] : null
  const width = raw && typeof raw === 'object' && !Array.isArray(raw) ? Number((raw as Record<string, unknown>).width) : 612
  const height = raw && typeof raw === 'object' && !Array.isArray(raw) ? Number((raw as Record<string, unknown>).height) : 792
  return { width: Number.isFinite(width) && width > 0 ? width : 612, height: Number.isFinite(height) && height > 0 ? height : 792 }
}

function normalizedBox(
  bbox: [number, number, number, number],
  coordinateOrigin: string,
  pageSize: { width: number; height: number },
): SourceRevisionPatch['box'] | null {
  if (!bbox.every(Number.isFinite)) return null
  const left = Math.max(0, Math.min(bbox[0], bbox[2]))
  const right = Math.min(pageSize.width, Math.max(bbox[0], bbox[2]))
  const lower = Math.max(0, Math.min(bbox[1], bbox[3]))
  const upper = Math.min(pageSize.height, Math.max(bbox[1], bbox[3]))
  const top = coordinateOrigin.toUpperCase() === 'TOPLEFT' ? lower : pageSize.height - upper
  if (right <= left || upper <= lower) return null
  return {
    leftPercent: rounded(left / pageSize.width * 100),
    topPercent: rounded(top / pageSize.height * 100),
    widthPercent: rounded((right - left) / pageSize.width * 100),
    heightPercent: rounded((upper - lower) / pageSize.height * 100),
  }
}

function rounded(value: number): number {
  return Number(value.toFixed(5))
}
