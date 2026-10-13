// Stable-ID semantic diff between two canonical ANX documents.
// Because every block and cell carries a stable ID, an ANX diff is a typed,
// node-level change list — not a line diff. This is the projection GitHub/
// GitLab CI and review surfaces consume (interoperability Level 3).
import type { AndocBlock, AndocDocument } from './types.js'

export interface SemanticDiffEntry {
  kind: 'added' | 'removed' | 'moved' | 'type-changed' | 'text-changed' | 'level-changed' | 'table-changed' | 'media-changed' | 'chart-changed'
  id: string
  blockType: string
  detail?: string
}

export interface SemanticDiffResult {
  schema: 'agn.semantic-diff.v1'
  from: { documentId: string; revision: number; title: string }
  to: { documentId: string; revision: number; title: string }
  sameDocumentLineage: boolean
  changeCount: number
  entries: SemanticDiffEntry[]
}

function blockText(block: AndocBlock): string | null {
  if (block.type === 'paragraph' || block.type === 'heading') return block.content.map(run => run.text).join('')
  return null
}

function clip(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function tableCells(block: Extract<AndocBlock, { type: 'table' }>): Map<string, string> {
  const cells = new Map<string, string>()
  for (const row of block.rows) for (const cell of row) cells.set(cell.id, cell.content.map(run => run.text).join(''))
  return cells
}

function longestIncreasingSubsequence(values: number[]): Set<number> {
  const tails: number[] = []
  const tailIndexes: number[] = []
  const previous = new Array<number>(values.length).fill(-1)
  for (let i = 0; i < values.length; i += 1) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (tails[middle]! < values[i]!) low = middle + 1
      else high = middle
    }
    tails[low] = values[i]!
    tailIndexes[low] = i
    previous[i] = low > 0 ? tailIndexes[low - 1]! : -1
  }
  const stable = new Set<number>()
  let cursor = tailIndexes[tails.length - 1] ?? -1
  while (cursor >= 0) {
    stable.add(cursor)
    cursor = previous[cursor]!
  }
  return stable
}

export function semanticDiff(from: AndocDocument, to: AndocDocument): SemanticDiffResult {
  const fromById = new Map(from.blocks.map(block => [block.id, block]))
  const toById = new Map(to.blocks.map(block => [block.id, block]))
  const entries: SemanticDiffEntry[] = []

  for (const block of from.blocks) {
    if (!toById.has(block.id)) entries.push({ kind: 'removed', id: block.id, blockType: block.type, ...(blockText(block) !== null ? { detail: clip(blockText(block)!) } : {}) })
  }
  for (const block of to.blocks) {
    if (!fromById.has(block.id)) entries.push({ kind: 'added', id: block.id, blockType: block.type, ...(blockText(block) !== null ? { detail: clip(blockText(block)!) } : {}) })
  }

  // Moves: common blocks whose relative order is not part of the longest
  // stable subsequence of the target ordering.
  const commonInFromOrder = from.blocks.filter(block => toById.has(block.id)).map(block => block.id)
  const toPositions = new Map(to.blocks.map((block, index) => [block.id, index]))
  const sequence = commonInFromOrder.map(id => toPositions.get(id)!)
  const stableIndexes = longestIncreasingSubsequence(sequence)
  commonInFromOrder.forEach((id, index) => {
    if (!stableIndexes.has(index)) entries.push({ kind: 'moved', id, blockType: fromById.get(id)!.type })
  })

  for (const id of commonInFromOrder) {
    const before = fromById.get(id)!
    const after = toById.get(id)!
    if (before.type !== after.type) {
      entries.push({ kind: 'type-changed', id, blockType: after.type, detail: `${before.type} → ${after.type}` })
      continue
    }
    if (before.type === 'heading' && after.type === 'heading' && before.level !== after.level) {
      entries.push({ kind: 'level-changed', id, blockType: 'heading', detail: `h${before.level} → h${after.level}` })
    }
    const beforeText = blockText(before)
    const afterText = blockText(after)
    if (beforeText !== null && afterText !== null && beforeText !== afterText) {
      entries.push({ kind: 'text-changed', id, blockType: after.type, detail: `"${clip(beforeText)}" → "${clip(afterText)}"` })
    }
    if (before.type === 'table' && after.type === 'table') {
      const beforeCells = tableCells(before)
      const afterCells = tableCells(after)
      const changed = [...afterCells.entries()].filter(([cellId, text]) => beforeCells.has(cellId) && beforeCells.get(cellId) !== text)
      const addedCells = [...afterCells.keys()].filter(cellId => !beforeCells.has(cellId))
      const removedCells = [...beforeCells.keys()].filter(cellId => !afterCells.has(cellId))
      if (changed.length || addedCells.length || removedCells.length || before.rows.length !== after.rows.length) {
        entries.push({
          kind: 'table-changed', id, blockType: 'table',
          detail: `${changed.length} cell(s) changed, ${addedCells.length} added, ${removedCells.length} removed, rows ${before.rows.length} → ${after.rows.length}`,
        })
      }
    }
    if (before.type === 'image' && after.type === 'image' && (before.assetId !== after.assetId || before.alt !== after.alt)) {
      entries.push({ kind: 'media-changed', id, blockType: 'image', detail: before.assetId !== after.assetId ? 'asset replaced' : 'alt text changed' })
    }
    if (before.type === 'chart' && after.type === 'chart' && JSON.stringify(before.spec) !== JSON.stringify(after.spec)) {
      entries.push({ kind: 'chart-changed', id, blockType: 'chart', detail: 'chart specification changed' })
    }
  }

  const order: Record<SemanticDiffEntry['kind'], number> = { removed: 0, added: 1, moved: 2, 'type-changed': 3, 'level-changed': 4, 'text-changed': 5, 'table-changed': 6, 'media-changed': 7, 'chart-changed': 8 }
  entries.sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id))
  return {
    schema: 'agn.semantic-diff.v1',
    from: { documentId: from.documentId, revision: from.revision, title: from.title },
    to: { documentId: to.documentId, revision: to.revision, title: to.title },
    sameDocumentLineage: from.documentId === to.documentId,
    changeCount: entries.length,
    entries,
  }
}

const MARKS: Record<SemanticDiffEntry['kind'], string> = {
  added: '+', removed: '-', moved: '↕', 'type-changed': '±', 'level-changed': '№', 'text-changed': '~', 'table-changed': '▦', 'media-changed': '▣', 'chart-changed': '▤',
}

export function renderSemanticDiffMarkdown(diff: SemanticDiffResult): string {
  const lines = [
    `## ANX semantic diff — ${diff.to.title}`,
    '',
    `\`${diff.from.documentId}\` r${diff.from.revision} → r${diff.to.revision} · ${diff.changeCount} change(s)${diff.sameDocumentLineage ? '' : ' · **different document lineages**'}`,
    '',
  ]
  if (!diff.entries.length) lines.push('_No semantic changes._')
  for (const entry of diff.entries) {
    lines.push(`- \`${MARKS[entry.kind]}\` **${entry.kind}** ${entry.blockType} \`${entry.id}\`${entry.detail ? ` — ${entry.detail}` : ''}`)
  }
  return lines.join('\n') + '\n'
}
