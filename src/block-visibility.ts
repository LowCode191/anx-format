import type { AndocBlock, AndocDocument } from './types.js'

export function blocksForDerivedView(document: AndocDocument): AndocBlock[] {
  const canonicalTitleHeading = document.blocks.findIndex(block => block.type === 'heading' && plainText(block.content).trim() === document.title.trim())
  return document.blocks.filter((block, index) => {
    if (index === canonicalTitleHeading) return false
    if (block.type !== 'image' || pictureClass(block) !== 'table') return true
    return !document.blocks.some(candidate => candidate.type === 'table' && sameSourceRegion(block, candidate))
  })
}

function pictureClass(block: AndocBlock): string | null {
  const classification = block.attrs?.pictureClassification
  if (!classification || typeof classification !== 'object' || Array.isArray(classification)) return null
  const value = (classification as Record<string, unknown>).className
  return typeof value === 'string' ? value : null
}

function sameSourceRegion(left: AndocBlock, right: AndocBlock): boolean {
  if (left.provenance?.page !== right.provenance?.page) return false
  const leftBox = left.provenance?.bbox
  const rightBox = right.provenance?.bbox
  if (!leftBox || !rightBox) return false
  return leftBox.every((value, index) => Math.abs(value - rightBox[index]!) < 0.01)
}

function plainText(content: Array<{ text: string }>): string {
  return content.map(run => run.text).join('')
}
