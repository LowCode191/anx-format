import { sha256 } from './hash.js'
import type { AndocBlock, AndocDocument } from './types.js'

export const ANX_SHARED_CONTENT_SCHEMA = 'anx.shared-content.v1' as const
export const ANX_SHARED_CONTENT_MATCH_POLICY = 'whitespace-normalized-exact' as const
export const ANX_SHARED_CONTENT_MINIMUM_CHARACTERS = 40
export const ANX_SHARED_CONTENT_MINIMUM_DISTINCT_PAGES = 3

export interface ImportedSharedContentOccurrenceInput {
  text: string
  sourceRef: string
  sourceUri: string
  page?: number
  bbox?: [number, number, number, number]
  coordinateOrigin?: string
  contentLayer?: string
  nodeId?: string
}

export interface AnxSharedContentOccurrence {
  page: number
  sourceRef?: string
  sourceUri?: string
  bbox?: [number, number, number, number]
  coordinateOrigin?: string
  nodeId?: string
  blockId?: string
  citation?: string
  rawTextSha256?: string
}

export interface AnxSharedContentGroup {
  id: string
  kind: 'recurring-furniture' | 'recurring-boilerplate'
  text: string
  contentSha256: string
  matchPolicy: typeof ANX_SHARED_CONTENT_MATCH_POLICY
  occurrenceCount: number
  distinctPageCount: number
  pageRanges: string[]
  canonicalOccurrenceCount: number
  sourceOccurrenceCount: number
  sourceOnly: boolean
  firstNodeId?: string
  firstCitation?: string
  occurrenceNodeIdsSha256?: string
  occurrences?: AnxSharedContentOccurrence[]
}

export interface AnxSharedContentIndex {
  schema: typeof ANX_SHARED_CONTENT_SCHEMA
  policy: {
    matching: typeof ANX_SHARED_CONTENT_MATCH_POLICY
    minimumCharacters: number
    minimumDistinctPages: number
    nearMatchesMerged: false
    canonicalContentChanged: false
  }
  groups: AnxSharedContentGroup[]
}

export interface AnxAgentContentProjection {
  schema: typeof ANX_SHARED_CONTENT_SCHEMA
  policy: AnxSharedContentIndex['policy'] & {
    defaultAgentView: 'shared-content-references'
    exactExpansionAvailable: true
  }
  canonicalBlockCount: number
  projectedNodeCount: number
  sharedContentGroupCount: number
  compactedOccurrenceCount: number
  nodes: Array<{ nodeId: string; citation: string; block: AndocBlock }>
  sharedContent: AnxSharedContentGroup[]
}

export interface AnxSharedContentCitation {
  uri: string
  documentId: string
  revision: number
  sharedContentId: string
  evidenceType: 'shared-content'
  contentSha256: string
  occurrenceCount: number
  pageRanges: string[]
  page?: number
  matchPolicy: typeof ANX_SHARED_CONTENT_MATCH_POLICY
}

interface CanonicalOccurrence {
  block: AndocBlock
  page: number
  normalizedText: string
  rawText: string
}

const encoder = new TextEncoder()

export function normalizeSharedContentText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function sharedContentId(value: string): string {
  return `shared-${contentHash(normalizeSharedContentText(value)).slice(0, 20)}`
}

export function importedSharedContentIndex(
  occurrences: ImportedSharedContentOccurrenceInput[],
): AnxSharedContentIndex {
  const grouped = new Map<string, ImportedSharedContentOccurrenceInput[]>()
  for (const occurrence of occurrences) {
    const normalized = normalizeSharedContentText(occurrence.text)
    if (normalized.length < ANX_SHARED_CONTENT_MINIMUM_CHARACTERS) continue
    const hash = contentHash(normalized)
    grouped.set(hash, [...(grouped.get(hash) || []), occurrence])
  }

  const groups = [...grouped.entries()].flatMap(([hash, items]): AnxSharedContentGroup[] => {
    const pages = distinctPages(items.map(item => item.page))
    if (pages.length < ANX_SHARED_CONTENT_MINIMUM_DISTINCT_PAGES) return []
    const ordered = [...items].sort(compareSourceOccurrences)
    const canonical = ordered.filter(item => item.nodeId)
    const furniture = ordered.some(item => item.contentLayer === 'furniture')
    return [{
      id: `shared-${hash.slice(0, 20)}`,
      kind: furniture ? 'recurring-furniture' : 'recurring-boilerplate',
      text: normalizeSharedContentText(ordered[0]!.text),
      contentSha256: hash,
      matchPolicy: ANX_SHARED_CONTENT_MATCH_POLICY,
      occurrenceCount: ordered.length,
      distinctPageCount: pages.length,
      pageRanges: compactPageRanges(pages),
      canonicalOccurrenceCount: canonical.length,
      sourceOccurrenceCount: ordered.length,
      sourceOnly: canonical.length === 0,
      ...(canonical[0]?.nodeId ? { firstNodeId: canonical[0].nodeId } : {}),
      ...(canonical.length ? { occurrenceNodeIdsSha256: nodeIdsHash(canonical.map(item => item.nodeId!)) } : {}),
      occurrences: ordered.map(item => ({
        page: item.page!,
        sourceRef: item.sourceRef,
        sourceUri: item.sourceUri,
        ...(item.bbox ? { bbox: [...item.bbox] as [number, number, number, number] } : {}),
        ...(item.coordinateOrigin ? { coordinateOrigin: item.coordinateOrigin } : {}),
        ...(item.nodeId ? { nodeId: item.nodeId, blockId: item.nodeId } : {}),
        rawTextSha256: contentHash(item.text),
      })),
    }]
  }).sort(compareGroups)

  return { schema: ANX_SHARED_CONTENT_SCHEMA, policy: basePolicy(), groups }
}

export function agentSharedContentIndex(
  document: AndocDocument,
  options: { expandOccurrences?: boolean } = {},
): AnxSharedContentIndex {
  const imported = importedIndexFromMetadata(document)
  const canonicalGroups = canonicalSharedContentGroups(document, options.expandOccurrences === true)
  const canonicalHashes = new Set(canonicalGroups.map(group => group.contentSha256))
  const sourceOnlyGroups = imported.groups
    .filter(group => !canonicalHashes.has(group.contentSha256))
    .map(group => options.expandOccurrences ? structuredClone(group) : withoutOccurrences(group))
  return {
    schema: ANX_SHARED_CONTENT_SCHEMA,
    policy: basePolicy(),
    groups: [...canonicalGroups, ...sourceOnlyGroups].sort(compareGroups),
  }
}

export function agentContentProjection(document: AndocDocument): AnxAgentContentProjection {
  const index = agentSharedContentIndex(document)
  const compactedNodeIds = new Set(
    canonicalSharedContentGroups(document, true)
      .flatMap(group => group.occurrences || [])
      .map(occurrence => occurrence.nodeId)
      .filter((value): value is string => Boolean(value)),
  )
  const nodes = document.blocks
    .filter(block => !compactedNodeIds.has(block.id))
    .map(block => ({
      nodeId: block.id,
      citation: blockCitation(document, block.id),
      block,
    }))
  return {
    schema: ANX_SHARED_CONTENT_SCHEMA,
    policy: {
      ...basePolicy(),
      defaultAgentView: 'shared-content-references',
      exactExpansionAvailable: true,
    },
    canonicalBlockCount: document.blocks.length,
    projectedNodeCount: nodes.length + index.groups.length,
    sharedContentGroupCount: index.groups.length,
    compactedOccurrenceCount: compactedNodeIds.size + index.groups.filter(group => group.sourceOnly).reduce((sum, group) => sum + group.occurrenceCount, 0),
    nodes,
    sharedContent: index.groups,
  }
}

export function sharedContentGroupForNode(document: AndocDocument, nodeId: string): AnxSharedContentGroup | null {
  return canonicalSharedContentGroups(document, false).find(group =>
    group.firstNodeId === nodeId || expandedCanonicalNodeIds(document, group.contentSha256).includes(nodeId)
  ) || null
}

export function sharedContentCitation(document: AndocDocument, group: AnxSharedContentGroup): AnxSharedContentCitation {
  return {
    uri: `anx://${document.documentId}/revisions/${document.revision}/shared-content/${encodeURIComponent(group.id)}`,
    documentId: document.documentId,
    revision: document.revision,
    sharedContentId: group.id,
    evidenceType: 'shared-content',
    contentSha256: group.contentSha256,
    occurrenceCount: group.occurrenceCount,
    pageRanges: group.pageRanges,
    matchPolicy: group.matchPolicy,
  }
}

function canonicalSharedContentGroups(document: AndocDocument, expandOccurrences: boolean): AnxSharedContentGroup[] {
  const grouped = new Map<string, CanonicalOccurrence[]>()
  for (const block of document.blocks) {
    const page = block.provenance?.page
    const rawText = sharedBlockText(block)
    const normalizedText = normalizeSharedContentText(rawText)
    if (!page || normalizedText.length < ANX_SHARED_CONTENT_MINIMUM_CHARACTERS || block.type === 'pageBreak') continue
    const hash = contentHash(normalizedText)
    grouped.set(hash, [...(grouped.get(hash) || []), { block, page, normalizedText, rawText }])
  }

  const imported = importedIndexFromMetadata(document)
  const importedByHash = new Map(imported.groups.map(group => [group.contentSha256, group]))
  return [...grouped.entries()].flatMap(([hash, occurrences]): AnxSharedContentGroup[] => {
    const pages = distinctPages(occurrences.map(item => item.page))
    if (pages.length < ANX_SHARED_CONTENT_MINIMUM_DISTINCT_PAGES) return []
    const ordered = [...occurrences].sort((left, right) => left.page - right.page || left.block.id.localeCompare(right.block.id))
    const importedGroup = importedByHash.get(hash)
    const occurrenceNodeIds = ordered.map(item => item.block.id)
    const group: AnxSharedContentGroup = {
      id: `shared-${hash.slice(0, 20)}`,
      kind: importedGroup?.kind || 'recurring-boilerplate',
      text: ordered[0]!.normalizedText,
      contentSha256: hash,
      matchPolicy: ANX_SHARED_CONTENT_MATCH_POLICY,
      occurrenceCount: ordered.length,
      distinctPageCount: pages.length,
      pageRanges: compactPageRanges(pages),
      canonicalOccurrenceCount: ordered.length,
      sourceOccurrenceCount: importedGroup?.sourceOccurrenceCount || ordered.length,
      sourceOnly: false,
      firstNodeId: ordered[0]!.block.id,
      firstCitation: blockCitation(document, ordered[0]!.block.id),
      occurrenceNodeIdsSha256: nodeIdsHash(occurrenceNodeIds),
    }
    if (expandOccurrences) {
      group.occurrences = ordered.map(item => ({
        page: item.page,
        nodeId: item.block.id,
        blockId: item.block.id,
        citation: blockCitation(document, item.block.id),
        ...(item.block.provenance?.sourceUri ? { sourceUri: item.block.provenance.sourceUri } : {}),
        ...(item.block.provenance?.bbox ? { bbox: [...item.block.provenance.bbox] as [number, number, number, number] } : {}),
        rawTextSha256: contentHash(item.rawText),
      }))
    }
    return [group]
  }).sort(compareGroups)
}

function importedIndexFromMetadata(document: AndocDocument): AnxSharedContentIndex {
  const candidate = document.metadata.anxSharedContent
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return emptyIndex()
  const index = candidate as Partial<AnxSharedContentIndex>
  if (index.schema !== ANX_SHARED_CONTENT_SCHEMA || !Array.isArray(index.groups)) return emptyIndex()
  return {
    schema: ANX_SHARED_CONTENT_SCHEMA,
    policy: basePolicy(),
    groups: index.groups.filter(isStoredGroup).map(group => structuredClone(group)),
  }
}

function isStoredGroup(value: unknown): value is AnxSharedContentGroup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const group = value as Partial<AnxSharedContentGroup>
  return typeof group.id === 'string'
    && typeof group.text === 'string'
    && typeof group.contentSha256 === 'string'
    && typeof group.occurrenceCount === 'number'
    && Array.isArray(group.pageRanges)
}

function withoutOccurrences(group: AnxSharedContentGroup): AnxSharedContentGroup {
  const { occurrences: _occurrences, ...rest } = group
  return structuredClone(rest)
}

function expandedCanonicalNodeIds(document: AndocDocument, hash: string): string[] {
  return document.blocks.flatMap(block =>
    contentHash(normalizeSharedContentText(sharedBlockText(block))) === hash ? [block.id] : []
  )
}

function sharedBlockText(block: AndocBlock): string {
  if (block.type === 'heading' || block.type === 'paragraph') return runsText(block.content)
  if (block.type === 'list') return listText(block.items)
  if (block.type === 'footnote') return `${block.label} ${runsText(block.content)}`
  if (block.type === 'extension') return runsText(block.fallback)
  return ''
}

function listText(items: Extract<AndocBlock, { type: 'list' }>['items']): string {
  return items.map(item => [runsText(item.content), ...(item.children ? [listText(item.children)] : [])].filter(Boolean).join(' ')).join(' ')
}

function runsText(runs: Array<{ text: string }>): string {
  return runs.map(run => run.text).join('')
}

function blockCitation(document: AndocDocument, blockId: string): string {
  return `anx://${document.documentId}/revisions/${document.revision}/blocks/${encodeURIComponent(blockId)}`
}

function basePolicy(): AnxSharedContentIndex['policy'] {
  return {
    matching: ANX_SHARED_CONTENT_MATCH_POLICY,
    minimumCharacters: ANX_SHARED_CONTENT_MINIMUM_CHARACTERS,
    minimumDistinctPages: ANX_SHARED_CONTENT_MINIMUM_DISTINCT_PAGES,
    nearMatchesMerged: false,
    canonicalContentChanged: false,
  }
}

function emptyIndex(): AnxSharedContentIndex {
  return { schema: ANX_SHARED_CONTENT_SCHEMA, policy: basePolicy(), groups: [] }
}

function contentHash(value: string): string {
  return sha256(encoder.encode(value))
}

function nodeIdsHash(nodeIds: string[]): string {
  return contentHash(nodeIds.join('\n'))
}

function distinctPages(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => Number.isInteger(value) && value! > 0))].sort((left, right) => left - right)
}

function compactPageRanges(pages: number[]): string[] {
  if (!pages.length) return []
  const ranges: string[] = []
  let start = pages[0]!
  let end = start
  for (const page of pages.slice(1)) {
    if (page === end + 1) {
      end = page
      continue
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`)
    start = page
    end = page
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`)
  return ranges
}

function compareSourceOccurrences(left: ImportedSharedContentOccurrenceInput, right: ImportedSharedContentOccurrenceInput): number {
  return (left.page || 0) - (right.page || 0) || left.sourceRef.localeCompare(right.sourceRef, undefined, { numeric: true })
}

function compareGroups(left: AnxSharedContentGroup, right: AnxSharedContentGroup): number {
  const leftPage = Number.parseInt(left.pageRanges[0] || '0', 10)
  const rightPage = Number.parseInt(right.pageRanges[0] || '0', 10)
  return leftPage - rightPage || left.id.localeCompare(right.id)
}
