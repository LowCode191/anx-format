// Corpus engine shared by both arms: builds the ANX and strong-Markdown indexes from the
// same packages, runs the deterministic lexical ranker, and resolves citations.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { strFromU8 } from 'fflate'
import {
  documentRelationshipsState,
  exportAnxMarkdown,
  readAndoc,
  type AndocBlock,
  type AndocPackage,
  type AnxRelationshipType,
  type AnxRelationshipAuthorityStatus,
} from '../../src/index.js'

export type CorpusArm = 'anx-native-corpus' | 'markdown-strong-corpus'

export interface CorpusManifestDocument {
  id: string
  fileName: string
  title: string
  publisher: string
  publicationDate: string
}

export interface CorpusManifest {
  documents: CorpusManifestDocument[]
}

export interface CorpusRelationshipFixture {
  id: string
  type: AnxRelationshipType
  sourceDocumentId: string
  targetDocumentId: string
  authority: AnxRelationshipAuthorityStatus
  note: string
}

export interface CorpusDocumentRecord extends CorpusManifestDocument {
  anxDocumentId: string
  revision: number
  packagePath: string
  markdownPath: string
  current: boolean
}

export interface CorpusEvidenceUnit {
  id: string
  arm: CorpusArm
  corpusDocumentId: string
  anxDocumentId: string
  revision: number
  title: string
  publisher: string
  publicationDate: string
  current: boolean
  kind: 'metadata' | 'heading' | 'text' | 'list' | 'table' | 'figure' | 'chart' | 'note' | 'relationship'
  sectionPath: string[]
  text: string
  page?: number
  citation: string
  lineStart?: number
  lineEnd?: number
  relationship?: CorpusRelationshipFixture
  tokens: string[]
}

export interface CorpusIndex {
  schema: 'anx.corpus-index.v1'
  arm: CorpusArm
  documents: CorpusDocumentRecord[]
  units: CorpusEvidenceUnit[]
  documentFrequency: Map<string, number>
  averageTokenCount: number
  relationships: CorpusRelationshipFixture[]
  markdownFiles: Map<string, string>
  sourcePackageSha256: Record<string, string>
}

export interface SerializedCorpusIndex extends Omit<CorpusIndex, 'documentFrequency' | 'markdownFiles'> {
  documentFrequency: Array<[string, number]>
  markdownFiles: Array<[string, string]>
}

export interface CorpusSearchHit {
  rank: number
  score: number
  corpusDocumentId: string
  anxDocumentId: string
  revision: number
  title: string
  publisher: string
  publicationDate: string
  kind: CorpusEvidenceUnit['kind']
  sectionPath: string[]
  text: string
  page?: number
  citation: string
  relationship?: CorpusRelationshipFixture
}

export interface CorpusSearchResult {
  schema: 'anx.corpus-search.v1'
  arm: CorpusArm
  query: string
  searchedDocuments: number
  searchedEvidenceUnits: number
  currentOnly: boolean
  hits: CorpusSearchHit[]
  elapsedMs: number
}

export async function buildCorpusIndexes(options: {
  manifestPath: string
  packagesDirectory: string
  relationships: CorpusRelationshipFixture[]
}): Promise<{ anx: CorpusIndex; markdown: CorpusIndex; packages: Map<string, AndocPackage> }> {
  const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8')) as CorpusManifest
  const packages = new Map<string, AndocPackage>()
  const records: CorpusDocumentRecord[] = []
  const sourcePackageSha256: Record<string, string> = {}

  for (const document of manifest.documents) {
    const stem = document.fileName.replace(/\.(pdf|docx)$/iu, '')
    const packagePath = path.join(options.packagesDirectory, `${stem}.anx`)
    const bytes = await readFile(packagePath)
    const pkg = await readAndoc(new Uint8Array(bytes))
    packages.set(document.id, pkg)
    sourcePackageSha256[document.id] = createHash('sha256').update(bytes).digest('hex')
    records.push({
      ...document,
      anxDocumentId: pkg.document.documentId,
      revision: pkg.document.revision,
      packagePath,
      markdownPath: `${stem}.md`,
      current: true,
    })
  }

  const anxUnits = records.flatMap(record => anxEvidenceUnits(record, packages.get(record.id)!, options.relationships))
  const markdownFiles = new Map<string, string>()
  const markdownUnits = records.flatMap(record => {
    const markdown = strongMarkdownProjection(record, packages.get(record.id)!, options.relationships)
    markdownFiles.set(record.id, markdown)
    return markdownEvidenceUnits(record, markdown, options.relationships)
  })

  return {
    anx: finalizeIndex('anx-native-corpus', records, anxUnits, options.relationships, new Map(), sourcePackageSha256),
    markdown: finalizeIndex('markdown-strong-corpus', records, markdownUnits, options.relationships, markdownFiles, sourcePackageSha256),
    packages,
  }
}

export function searchCorpus(index: CorpusIndex, query: string, options: {
  limit?: number
  maximumPerDocument?: number
  currentOnly?: boolean
  documentIds?: string[]
} = {}): CorpusSearchResult {
  const started = performance.now()
  const terms = meaningfulTerms(query)
  if (!terms.length) throw new Error('Corpus search query cannot be empty')
  const normalizedQuery = normalize(query)
  const currentOnly = options.currentOnly !== false
  const documentIds = new Set(options.documentIds || [])
  const candidateUnits = index.units.filter(unit => (!currentOnly || unit.current)
    && (!documentIds.size || documentIds.has(unit.corpusDocumentId)))
  const scored = candidateUnits.flatMap(unit => {
    const score = bm25Score(index, unit, terms, normalizedQuery)
    return score > 0 ? [{ unit, score }] : []
  }).sort((left, right) => right.score - left.score
    || left.unit.corpusDocumentId.localeCompare(right.unit.corpusDocumentId)
    || left.unit.id.localeCompare(right.unit.id))

  const limit = clamp(options.limit ?? 12, 1, 100)
  const maximumPerDocument = clamp(options.maximumPerDocument ?? 4, 1, 25)
  const perDocument = new Map<string, number>()
  const selected: typeof scored = []
  for (const candidate of scored) {
    const seen = perDocument.get(candidate.unit.corpusDocumentId) || 0
    if (seen >= maximumPerDocument) continue
    selected.push(candidate)
    perDocument.set(candidate.unit.corpusDocumentId, seen + 1)
    if (selected.length >= limit) break
  }

  return {
    schema: 'anx.corpus-search.v1',
    arm: index.arm,
    query,
    searchedDocuments: index.documents.filter(document => !currentOnly || document.current).length,
    searchedEvidenceUnits: candidateUnits.length,
    currentOnly,
    hits: selected.map((candidate, position) => ({
      rank: position + 1,
      score: Number(candidate.score.toFixed(6)),
      corpusDocumentId: candidate.unit.corpusDocumentId,
      anxDocumentId: candidate.unit.anxDocumentId,
      revision: candidate.unit.revision,
      title: candidate.unit.title,
      publisher: candidate.unit.publisher,
      publicationDate: candidate.unit.publicationDate,
      kind: candidate.unit.kind,
      sectionPath: candidate.unit.sectionPath,
      text: candidate.unit.text,
      ...(candidate.unit.page ? { page: candidate.unit.page } : {}),
      citation: candidate.unit.citation,
      ...(candidate.unit.relationship ? { relationship: candidate.unit.relationship } : {}),
    })),
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  }
}

export function traverseCorpusRelationships(index: CorpusIndex, options: {
  documentId: string
  direction?: 'outbound' | 'inbound' | 'both'
  types?: AnxRelationshipType[]
}): CorpusRelationshipFixture[] {
  const direction = options.direction || 'both'
  const types = new Set(options.types || [])
  return index.relationships.filter(relationship => {
    if (types.size && !types.has(relationship.type)) return false
    const outbound = relationship.sourceDocumentId === options.documentId
    const inbound = relationship.targetDocumentId === options.documentId
    return direction === 'outbound' ? outbound : direction === 'inbound' ? inbound : outbound || inbound
  }).map(relationship => structuredClone(relationship))
}

export function resolveCorpusCitation(index: CorpusIndex, citation: string): CorpusEvidenceUnit | null {
  return index.units.find(unit => unit.citation === citation) || null
}

export function renderEvidenceBundle(result: CorpusSearchResult): string {
  return result.hits.map((hit, index) => [
    `[Evidence ${index + 1}]`,
    `document_id: ${hit.corpusDocumentId}`,
    `title: ${hit.title}`,
    `publisher: ${hit.publisher}`,
    `publication_date: ${hit.publicationDate}`,
    `revision: ${hit.revision}`,
    `kind: ${hit.kind}`,
    ...(hit.page ? [`source_page: ${hit.page}`] : []),
    ...(hit.sectionPath.length ? [`section: ${hit.sectionPath.join(' > ')}`] : []),
    `citation: ${hit.citation}`,
    `text: ${hit.text}`,
  ].join('\n')).join('\n\n')
}

export function serializeCorpusIndex(index: CorpusIndex): SerializedCorpusIndex {
  return {
    ...index,
    documentFrequency: [...index.documentFrequency.entries()].sort(([left], [right]) => left.localeCompare(right)),
    markdownFiles: [...index.markdownFiles.entries()].sort(([left], [right]) => left.localeCompare(right)),
  }
}

export function hydrateCorpusIndex(index: SerializedCorpusIndex): CorpusIndex {
  return {
    ...index,
    documentFrequency: new Map(index.documentFrequency),
    markdownFiles: new Map(index.markdownFiles),
  }
}

function finalizeIndex(
  arm: CorpusArm,
  documents: CorpusDocumentRecord[],
  units: CorpusEvidenceUnit[],
  relationships: CorpusRelationshipFixture[],
  markdownFiles: Map<string, string>,
  sourcePackageSha256: Record<string, string>,
): CorpusIndex {
  const documentFrequency = new Map<string, number>()
  for (const unit of units) {
    for (const term of new Set(unit.tokens)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1)
  }
  return {
    schema: 'anx.corpus-index.v1',
    arm,
    documents: structuredClone(documents),
    units,
    documentFrequency,
    averageTokenCount: units.reduce((total, unit) => total + unit.tokens.length, 0) / Math.max(1, units.length),
    relationships: structuredClone(relationships),
    markdownFiles,
    sourcePackageSha256: structuredClone(sourcePackageSha256),
  }
}

export function anxEvidenceUnits(
  record: CorpusDocumentRecord,
  pkg: AndocPackage,
  fixtureRelationships: CorpusRelationshipFixture[],
): CorpusEvidenceUnit[] {
  const units: CorpusEvidenceUnit[] = []
  const headings: string[] = []
  units.push(unit({
    id: `${record.id}:metadata`,
    arm: 'anx-native-corpus',
    record,
    kind: 'metadata',
    sectionPath: [],
    text: `${record.title}. ${record.publisher}. Published ${record.publicationDate}.`,
    citation: `anx://${pkg.document.documentId}/revisions/${pkg.document.revision}`,
  }))
  for (const block of pkg.document.blocks) {
    if (block.type === 'pageBreak') continue
    const text = blockText(block)
    if (!text.trim()) continue
    if (block.type === 'heading') {
      headings.splice(block.level - 1)
      headings[block.level - 1] = runsText(block.content)
    }
    units.push(unit({
      id: `${record.id}:${block.id}`,
      arm: 'anx-native-corpus',
      record,
      kind: anxKind(block),
      sectionPath: headings.filter(Boolean),
      text,
      ...(block.provenance?.page ? { page: block.provenance.page } : {}),
      citation: `anx://${pkg.document.documentId}/revisions/${pkg.document.revision}/blocks/${encodeURIComponent(block.id)}`,
    }))
  }

  const embedded = documentRelationshipsState(pkg.document).relationships.flatMap(relationship => {
    if (relationship.status !== 'active') return []
    const targetDocumentId = relationship.resolution.resolvedDocumentId
    if (!targetDocumentId) return []
    return [{
      id: relationship.id,
      type: relationship.type,
      sourceDocumentId: record.id,
      targetDocumentId,
      authority: relationship.authority.status,
      note: relationship.note || 'Portable ANX relationship.',
    }]
  })
  const relationships = [...embedded, ...fixtureRelationships.filter(relationship => relationship.sourceDocumentId === record.id)]
  for (const relationship of relationships) {
    const target = relationship.targetDocumentId
    units.push(unit({
      id: `${record.id}:${relationship.id}`,
      arm: 'anx-native-corpus',
      record,
      kind: 'relationship',
      sectionPath: [],
      text: `${record.title} ${relationship.type} ${target}. ${relationship.note}`,
      citation: `anx://${pkg.document.documentId}/revisions/${pkg.document.revision}/relationships/${encodeURIComponent(relationship.id)}`,
      relationship,
    }))
  }
  return units
}

function strongMarkdownProjection(
  record: CorpusDocumentRecord,
  pkg: AndocPackage,
  relationships: CorpusRelationshipFixture[],
): string {
  const exported = strFromU8(exportAnxMarkdown(pkg).bytes)
  const outbound = relationships.filter(relationship => relationship.sourceDocumentId === record.id)
  const frontmatter = [
    '---',
    `document_id: ${record.id}`,
    `title: ${jsonScalar(record.title)}`,
    `publisher: ${jsonScalar(record.publisher)}`,
    `publication_date: ${record.publicationDate}`,
    `revision: ${record.revision}`,
    'status: current',
    ...(outbound.length ? ['relationships:', ...outbound.map(relationship => `  - ${relationship.type}: ${relationship.targetDocumentId}`)] : ['relationships: []']),
    '---',
    '',
  ].join('\n')
  return `${frontmatter}${exported}`
}

function markdownEvidenceUnits(
  record: CorpusDocumentRecord,
  markdown: string,
  relationships: CorpusRelationshipFixture[],
): CorpusEvidenceUnit[] {
  const lines = markdown.split('\n')
  const units: CorpusEvidenceUnit[] = []
  const headings: string[] = []
  let start = 1
  let buffer: string[] = []
  const flush = (endExclusive: number) => {
    if (!buffer.length) return
    const raw = buffer.join('\n')
    const text = cleanMarkdown(raw)
    const lineStart = start
    const lineEnd = Math.max(start, endExclusive - 1)
    buffer = []
    if (!text) return
    const heading = raw.match(/^(#{1,6})\s+(.+)$/u)
    if (heading) {
      const level = heading[1]!.length
      headings.splice(level - 1)
      headings[level - 1] = cleanMarkdown(heading[2]!)
    }
    units.push(unit({
      id: `${record.id}:lines-${lineStart}-${lineEnd}`,
      arm: 'markdown-strong-corpus',
      record,
      kind: markdownKind(raw),
      sectionPath: headings.filter(Boolean),
      text,
      citation: `markdown://${record.id}/${encodeURIComponent(record.markdownPath)}#L${lineStart}-L${lineEnd}`,
      lineStart,
      lineEnd,
    }))
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!line.trim()) {
      flush(index + 1)
      start = index + 2
    } else {
      if (!buffer.length) start = index + 1
      buffer.push(line)
    }
  }
  flush(lines.length + 1)

  for (const relationship of relationships.filter(item => item.sourceDocumentId === record.id)) {
    const line = lines.findIndex(value => value.includes(`${relationship.type}: ${relationship.targetDocumentId}`)) + 1
    units.push(unit({
      id: `${record.id}:${relationship.id}`,
      arm: 'markdown-strong-corpus',
      record,
      kind: 'relationship',
      sectionPath: [],
      text: `${record.title} ${relationship.type} ${relationship.targetDocumentId}. ${relationship.note}`,
      citation: `markdown://${record.id}/${encodeURIComponent(record.markdownPath)}#L${line}-L${line}`,
      lineStart: line,
      lineEnd: line,
      relationship,
    }))
  }
  return units
}

function unit(input: {
  id: string
  arm: CorpusArm
  record: CorpusDocumentRecord
  kind: CorpusEvidenceUnit['kind']
  sectionPath: string[]
  text: string
  page?: number
  citation: string
  lineStart?: number
  lineEnd?: number
  relationship?: CorpusRelationshipFixture
}): CorpusEvidenceUnit {
  const searchable = [input.record.title, input.record.publisher, input.record.publicationDate, input.sectionPath.join(' '), input.text].join(' ')
  return {
    id: input.id,
    arm: input.arm,
    corpusDocumentId: input.record.id,
    anxDocumentId: input.record.anxDocumentId,
    revision: input.record.revision,
    title: input.record.title,
    publisher: input.record.publisher,
    publicationDate: input.record.publicationDate,
    current: input.record.current,
    kind: input.kind,
    sectionPath: [...input.sectionPath],
    text: input.text,
    ...(input.page ? { page: input.page } : {}),
    citation: input.citation,
    ...(input.lineStart ? { lineStart: input.lineStart } : {}),
    ...(input.lineEnd ? { lineEnd: input.lineEnd } : {}),
    ...(input.relationship ? { relationship: structuredClone(input.relationship) } : {}),
    tokens: tokenize(searchable),
  }
}

function bm25Score(index: CorpusIndex, unit: CorpusEvidenceUnit, terms: string[], normalizedQuery: string): number {
  const frequencies = new Map<string, number>()
  for (const token of unit.tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1)
  const k1 = 1.2
  const b = 0.75
  let score = 0
  for (const term of terms) {
    const tf = frequencies.get(term) || 0
    if (!tf) continue
    const df = index.documentFrequency.get(term) || 0
    const idf = Math.log(1 + (index.units.length - df + 0.5) / (df + 0.5))
    const denominator = tf + k1 * (1 - b + b * unit.tokens.length / Math.max(1, index.averageTokenCount))
    score += idf * (tf * (k1 + 1)) / denominator
  }
  const normalizedText = normalize(unit.text)
  if (normalizedText.includes(normalizedQuery)) score += 12
  const normalizedTitle = normalize(unit.title)
  if (terms.some(term => normalizedTitle.includes(term))) score += 0.75
  if (/\b(?:table|row|column|total|rate|percent|percentage|compare)\b/iu.test(normalizedQuery) && unit.kind === 'table') score += 1.5
  if (/\b(?:figure|chart|diagram|visual)\b/iu.test(normalizedQuery) && (unit.kind === 'figure' || unit.kind === 'chart')) score += 1.5
  if (/\b(?:supersede|supersedes|superseded|current|latest|previous|relationship|related)\b/iu.test(normalizedQuery) && unit.kind === 'relationship') score += 5
  return score
}

function blockText(block: AndocBlock): string {
  if (block.type === 'heading' || block.type === 'paragraph') return runsText(block.content)
  if (block.type === 'list') return listText(block.items)
  if (block.type === 'footnote') return `${block.label} ${runsText(block.content)}`
  if (block.type === 'extension') return runsText(block.fallback)
  if (block.type === 'image') return [block.alt, runsText(block.caption)].filter(Boolean).join(' — ')
  if (block.type === 'chart') return [block.alt, runsText(block.caption), JSON.stringify(block.spec.data || '')].filter(Boolean).join(' — ')
  if (block.type === 'table') return [
    runsText(block.caption),
    ...block.rows.map(row => row.map(cell => runsText(cell.content)).join(' | ')),
  ].filter(Boolean).join('\n')
  return ''
}

function listText(items: Array<{ content: Array<{ text: string }>; children?: Array<any> }>): string {
  return items.flatMap(item => [runsText(item.content), ...(item.children?.length ? [listText(item.children)] : [])]).filter(Boolean).join('\n')
}

function runsText(runs?: Array<{ text: string }>): string {
  return (runs || []).map(run => run.text).join('')
}

function anxKind(block: AndocBlock): CorpusEvidenceUnit['kind'] {
  if (block.type === 'heading') return 'heading'
  if (block.type === 'list') return 'list'
  if (block.type === 'table') return 'table'
  if (block.type === 'image') return 'figure'
  if (block.type === 'chart') return 'chart'
  if (block.type === 'footnote') return 'note'
  return 'text'
}

function markdownKind(raw: string): CorpusEvidenceUnit['kind'] {
  if (/^#{1,6}\s+/u.test(raw)) return 'heading'
  if (/^\|.+\|\n\|(?:\s*:?-+:?\s*\|)+/u.test(raw)) return 'table'
  if (/^!\[/u.test(raw)) return /chart/iu.test(raw) ? 'chart' : 'figure'
  if (/^(?:[-*+] |\d+\. )/u.test(raw)) return 'list'
  if (/^\[\^[^\]]+\]:/u.test(raw)) return 'note'
  if (/^---(?:\n|$)/u.test(raw) || /^document_id:/mu.test(raw)) return 'metadata'
  return 'text'
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/^---$/gmu, '')
    .replace(/^<!--.*-->$/gmu, '')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^>\s?/gmu, '')
    .replace(/^\s*(?:[-*+] |\d+\. )/gmu, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`]/gu, '')
    .replace(/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/gmu, '')
    .replace(/\|/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function tokenize(value: string): string[] {
  return normalize(value).split(' ').filter(Boolean).map(stem)
}

function meaningfulTerms(value: string): string[] {
  const stop = new Set(['about', 'after', 'also', 'and', 'are', 'between', 'did', 'does', 'for', 'from', 'has', 'have', 'how', 'in', 'into', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'with'])
  return [...new Set(tokenize(value).filter(term => !stop.has(term) && (term.length > 2 || /\d/u.test(term))))]
}

function stem(value: string): string {
  if (/\d/u.test(value)) return value
  if (value.length > 5 && value.endsWith('ies')) return `${value.slice(0, -3)}y`
  if (value.length > 5 && value.endsWith('ing')) return value.slice(0, -3)
  if (value.length > 4 && value.endsWith('es')) return value.slice(0, -2)
  if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1)
  return value
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}.$%]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

function jsonScalar(value: string): string {
  return JSON.stringify(value)
}
