import {
  andocSearch,
  anxPageEvidence,
  type AgentPageEvidenceOptions,
} from './agent-tools.js'
import {
  ANX_AGENT_RESPONSE_EVIDENCE_SCHEMA,
  type AnxAgentResponseEvidence,
  type AnxAgentResponseEvidenceItem,
} from './agent-response.js'

export const ANX_COMPACT_SEARCH_SCHEMA = 'anx.search-evidence.v1' as const
export const ANX_COMPACT_PAGE_PROJECTION = 'agent-compact-v1' as const
export const ANX_TABLE_ANSWER_SCHEMA = 'anx.table-answer-evidence.v1' as const
export const ANX_TABLE_ANSWER_PROJECTION = 'agent-table-answer-v1' as const
export const ANX_TABLE_MODEL_PROJECTION = 'agent-table-model-v1' as const
export const ANX_PAGE_TEXT_ANSWER_SCHEMA = 'anx.page-text-answer-evidence.v1' as const
export const ANX_PAGE_TEXT_ANSWER_PROJECTION = 'agent-page-text-answer-v1' as const
export const ANX_PAGE_TEXT_MODEL_PROJECTION = 'agent-page-text-model-v1' as const
export const ANX_COMPACT_SEARCH_DEFAULT_LIMIT = 5

interface FullSearchCitation {
  uri: string
  page?: number
  textQuality?: string
}

interface FullSearchMatch {
  nodeId: string
  type: string
  excerpt: string
  score: number
  citation: FullSearchCitation
  sharedContent?: {
    id?: string
    kind?: string
    occurrenceCount?: number
    pageRanges?: string[]
    citation?: { uri?: string } | string
  }
}

interface FullSearchResult {
  documentId: string
  revision: number
  query: string
  matches: FullSearchMatch[]
  truncated: boolean
}

interface FullPageCitation {
  uri: string
}

interface FullPageRegion {
  id: string
  kind: string
  status: string
  unattendedUse: string
  semanticLevel: string
  defaultVisibility: string
  parentRegionId?: string
  childRegionIds?: string[]
  description?: string
  transcription?: string
  structuredData?: Record<string, unknown>
  provenance: {
    method: string
    source: string
    verified: boolean
    sourceSha256?: string
    engine?: string
    engineVersion?: string
    confidence?: number
  }
  citation: FullPageCitation
  sourceCitations?: Array<FullPageCitation | string>
  agentUse: {
    reviewRequired: boolean
    safeForUnattendedAcceptance: boolean
    instruction: string
  }
}

interface FullPageResult {
  schema: string
  document: Record<string, unknown>
  source?: Record<string, unknown>
  sourceBaseline: Record<string, unknown>
  page: number
  pageCount: number
  query?: string
  textQuality: string
  blocks: Array<Record<string, unknown>>
  ocrEvidence?: Record<string, unknown>
  regions: FullPageRegion[]
  summary: {
    canonicalBlocks: number
    returnedBlocks: number
    blocksTruncated: boolean
    semanticRegions: number
    evidenceParts: number
    verifiedRegions: number
    reviewRequiredRegions: number
    reviewRequiredRegionIds: string[]
    abstainedRegions: number
    abstainedRegionIds: string[]
  }
  issues: Array<Record<string, unknown>>
  automaticCanonicalChange: false
}

export interface AgentTableEvidenceOptions {
  query?: string
  tableRegionId?: string
  limit?: number
  maximumDescriptionCharacters?: number
  includeResponseEvidence?: boolean
}

export interface AgentPageTextEvidenceOptions {
  query?: string
  limit?: number
  maximumCharacters?: number
  includeResponseEvidence?: boolean
}

const pageTextBlockTypes = new Set([
  'heading',
  'paragraph',
  'list',
  'footnote',
  'extension',
])

const compactSemanticKeys = [
  'captionAssist',
  'captionForKind',
  'parentMatchState',
  'regionRole',
  'expectedPanelCount',
  'rawVisualClass',
  'rawVisualConfidence',
  'noteKind',
  'marker',
  'anchorBlockIds',
  'anchorBlockId',
  'anchorStatus',
  'canonicalTextOwner',
  'subtype',
  'mergedKinds',
  'rowCount',
  'columnCount',
  'tableEvidence',
  'visualTextLines',
] as const

export async function anxCompactSearch(
  input: string | Uint8Array,
  query: string,
  limit = ANX_COMPACT_SEARCH_DEFAULT_LIMIT,
): Promise<Record<string, unknown>> {
  const result = await andocSearch(input, query, limit) as unknown as FullSearchResult
  return {
    schema: ANX_COMPACT_SEARCH_SCHEMA,
    document: { id: result.documentId, revision: result.revision },
    query: result.query,
    matches: result.matches.map((match, index) => ({
      rank: index + 1,
      nodeId: match.nodeId,
      type: match.type,
      excerpt: match.excerpt,
      citation: match.citation.uri,
      ...(match.citation.page ? { page: match.citation.page } : {}),
      textQuality: match.citation.textQuality || 'unverified',
      score: match.score,
      ...(match.sharedContent ? {
        sharedContent: {
          id: match.sharedContent.id,
          kind: match.sharedContent.kind,
          occurrenceCount: match.sharedContent.occurrenceCount,
          pageRanges: match.sharedContent.pageRanges,
          citation: citationUri(match.sharedContent.citation),
        },
      } : {}),
    })),
    truncated: result.truncated,
    nextAction: result.truncated
      ? 'Use the strongest returned evidence. Narrow the query or raise limit only when these matches are insufficient.'
      : 'Stop searching when the returned evidence answers the question.',
  }
}

export async function anxCompactPageEvidence(
  input: string | Uint8Array,
  page: number,
  options: AgentPageEvidenceOptions = {},
): Promise<Record<string, unknown>> {
  if (options.mode === 'standard') return anxPageEvidence(input, page, options)
  const result = await anxPageEvidence(input, page, { ...options, mode: 'compact' }) as unknown as FullPageResult
  return {
    schema: result.schema,
    projection: ANX_COMPACT_PAGE_PROJECTION,
    document: result.document,
    ...(result.source ? {
      source: {
        mediaType: result.source.mediaType,
        sha256: result.source.sha256,
      },
    } : {}),
    sourceBaseline: compactSourceBaseline(result.sourceBaseline),
    page: result.page,
    pageCount: result.pageCount,
    ...(result.query ? { query: result.query } : {}),
    textQuality: result.textQuality,
    blocks: result.blocks,
    ...(result.ocrEvidence ? { ocrEvidence: result.ocrEvidence } : {}),
    regions: result.regions.map(compactRegion),
    summary: {
      canonicalBlocks: result.summary.canonicalBlocks,
      returnedBlocks: result.summary.returnedBlocks,
      blocksTruncated: result.summary.blocksTruncated,
      semanticRegions: result.summary.semanticRegions,
      evidenceParts: result.summary.evidenceParts,
      verifiedRegions: result.summary.verifiedRegions,
      reviewRequiredRegions: result.summary.reviewRequiredRegions,
      reviewRequiredRegionIds: result.summary.reviewRequiredRegionIds,
      abstainedRegions: result.summary.abstainedRegions,
      abstainedRegionIds: result.summary.abstainedRegionIds,
    },
    ...(result.issues.length ? { issues: result.issues } : {}),
    automaticCanonicalChange: result.automaticCanonicalChange,
    policy: 'Use allowed evidence within its claim boundary. Disclose review-required evidence. Never use abstained evidence for an unattended claim.',
    detailExpansion: 'Set mode to standard only when exact geometry, complete structured data, or full citation provenance is required.',
    claimBoundary: 'This projection does not prove interpretation accuracy, signer identity, legal authenticity, QR safety, chart values, or automatic canonical promotion.',
  }
}

export async function anxPageTextEvidenceBundle(
  input: string | Uint8Array,
  page: number,
  options: AgentPageTextEvidenceOptions = {},
): Promise<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(24, options.limit ?? 8))
  const maximumCharacters = Math.max(
    120,
    Math.min(1_600, options.maximumCharacters ?? 700),
  )
  const result = await anxPageEvidence(input, page, {
    query: options.query,
    maximumBlocks: 250,
    maximumCharacters,
    mode: 'compact',
  }) as unknown as FullPageResult
  const pageBlocks = result.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => pageTextBlockTypes.has(stringValue(block.type)))
  const ranked = pageBlocks.map(({ block, index }) => ({
    block,
    index,
    score: pageTextQueryScore(block, options.query),
  }))
  const matched = options.query && ranked.some(candidate => candidate.score > 0)
    ? ranked.filter(candidate => candidate.score > 0)
    : ranked
  const selectedCanonical = matched
    .sort((left, right) => (
      right.score - left.score
      || pageTextTypePriority(right.block) - pageTextTypePriority(left.block)
      || left.index - right.index
    ))
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map(candidate => pageTextAnswer(candidate.block))
  const ocrEvidence = objectValue(result.ocrEvidence)
  const useOcrCandidate = ocrEvidence.preferredSource === 'ocr'
    && typeof ocrEvidence.text === 'string'
    && Boolean(ocrEvidence.text.trim())
  const selected = useOcrCandidate
    ? [ocrPageTextAnswer(ocrEvidence)]
    : selectedCanonical
  if (!selected.length) {
    throw new Error(`No usable canonical or validated OCR text evidence is available on source page ${page}`)
  }
  const sourceBaseline = compactSourceBaseline(result.sourceBaseline)
  return {
    schema: ANX_PAGE_TEXT_ANSWER_SCHEMA,
    projection: ANX_PAGE_TEXT_ANSWER_PROJECTION,
    document: result.document,
    sourceBaseline,
    page: result.page,
    pageCount: result.pageCount,
    ...(options.query ? { query: options.query } : {}),
    textQuality: result.textQuality,
    selection: {
      canonicalBlocksOnPage: result.summary.canonicalBlocks,
      textBlocksOnPage: pageBlocks.length,
      returnedTextBlocks: selected.length,
      truncated: useOcrCandidate
        ? ocrEvidence.textTruncated === true
        : selected.length < pageBlocks.length,
      excludedNonTextBlocks: Math.max(0, result.summary.canonicalBlocks - pageBlocks.length),
      method: useOcrCandidate
        ? 'validated-source-bound-ocr-candidate'
        : options.query && ranked.some(candidate => candidate.score > 0)
          ? 'deterministic-query-ranking'
          : 'source-order-with-heading-priority',
    },
    blocks: selected,
    ...(options.includeResponseEvidence === false ? {
      responseInstructions: 'Return the human answer, evidence judgment, and limitations. ANX records this host result and deterministically attaches its revision-pinned source citations and machine evidence after model generation.',
    } : {
      responseEvidence: pageTextResponseEvidence(
        selected,
        sourceBaseline,
        result.automaticCanonicalChange,
      ),
      responseInstructions: 'Legacy full-envelope mode: copy responseEvidence exactly into task.evidence and copy its item citations into task.citations without duplicates.',
    }),
    automaticCanonicalChange: result.automaticCanonicalChange,
    policy: useOcrCandidate
      ? 'Use only the returned source-bound OCR candidate within its disclosed review boundary. It is candidate-only, not canonical, and numeric or symbol disagreements require source-canvas review.'
      : 'Use only the returned canonical text. Preserve its text-quality and source-baseline disclosures. Do not infer omitted visual, table-cell, relationship, or off-page content.',
    nextAction: useOcrCandidate
      ? 'Use the OCR candidate as leading page evidence only as instructed. Explicitly disclose review-required numeric or symbol content and never treat it as an automatic canonical change.'
      : selected.length < pageBlocks.length
      ? 'The page text was deterministically bounded. Use provider tools when the requested answer depends on omitted or non-text evidence.'
      : 'Stop when the returned page text answers the question.',
    claimBoundary: 'This bundle supports explicit page-text reading and summarization only. OCR entries are validated, source-bound candidates and remain non-canonical. It does not interpret charts, figures, layout, signatures, relationships, table cells, or content from another page.',
  }
}

export function anxResponseEvidenceFromPageTextBundle(
  bundleValue: unknown,
): AnxAgentResponseEvidence {
  if (!bundleValue || typeof bundleValue !== 'object' || Array.isArray(bundleValue)) {
    throw new Error('ANX_PAGE_TEXT_EVIDENCE_INVALID: bundle must be an object')
  }
  const bundle = bundleValue as Record<string, unknown>
  if (bundle.schema !== ANX_PAGE_TEXT_ANSWER_SCHEMA) {
    throw new Error(`ANX_PAGE_TEXT_EVIDENCE_INVALID: schema must be ${ANX_PAGE_TEXT_ANSWER_SCHEMA}`)
  }
  const blocks = arrayRecords(bundle.blocks)
  if (!blocks.length) {
    throw new Error('ANX_PAGE_TEXT_EVIDENCE_INVALID: bundle must contain at least one text block')
  }
  return pageTextResponseEvidence(
    blocks,
    objectValue(bundle.sourceBaseline),
    bundle.automaticCanonicalChange === true,
  )
}

export function anxPageTextEvidenceModelView(
  bundleValue: unknown,
): Record<string, unknown> {
  if (!bundleValue || typeof bundleValue !== 'object' || Array.isArray(bundleValue)) {
    throw new Error('ANX_PAGE_TEXT_EVIDENCE_INVALID: bundle must be an object')
  }
  const bundle = bundleValue as Record<string, unknown>
  if (bundle.schema !== ANX_PAGE_TEXT_ANSWER_SCHEMA) {
    throw new Error(`ANX_PAGE_TEXT_EVIDENCE_INVALID: schema must be ${ANX_PAGE_TEXT_ANSWER_SCHEMA}`)
  }
  return {
    schema: bundle.schema,
    projection: ANX_PAGE_TEXT_MODEL_PROJECTION,
    document: bundle.document,
    sourceBaseline: bundle.sourceBaseline,
    page: bundle.page,
    pageCount: bundle.pageCount,
    textQuality: bundle.textQuality,
    selection: bundle.selection,
    blocks: arrayRecords(bundle.blocks).map(block => ({
      id: block.id,
      type: block.type,
      text: block.text,
      textQuality: block.textQuality,
      citation: block.citation,
      ...(block.sourceRepresentation ? { sourceRepresentation: block.sourceRepresentation } : {}),
      ...(block.dataState ? { dataState: block.dataState } : {}),
      ...(block.evidenceStatus ? { evidenceStatus: block.evidenceStatus } : {}),
      ...(block.unattendedUse ? { unattendedUse: block.unattendedUse } : {}),
      ...(typeof block.safeForUnattendedAcceptance === 'boolean' ? { safeForUnattendedAcceptance: block.safeForUnattendedAcceptance } : {}),
      ...(typeof block.reviewRequired === 'boolean' ? { reviewRequired: block.reviewRequired } : {}),
      ...(block.candidateSha256 ? { candidateSha256: block.candidateSha256 } : {}),
      ...(block.sourceSha256 ? { sourceSha256: block.sourceSha256 } : {}),
      ...(typeof block.meanConfidence === 'number' ? { meanConfidence: block.meanConfidence } : {}),
      ...(typeof block.numericReviewRequired === 'boolean' ? { numericReviewRequired: block.numericReviewRequired } : {}),
      ...(block.numericAgreement ? { numericAgreement: block.numericAgreement } : {}),
      ...(block.reviewReasons ? { reviewReasons: block.reviewReasons } : {}),
      ...(block.guidance ? { guidance: block.guidance } : {}),
      ...(typeof block.canonical === 'boolean' ? { canonical: block.canonical } : {}),
      ...(typeof block.automaticCanonicalChange === 'boolean' ? { automaticCanonicalChange: block.automaticCanonicalChange } : {}),
      ...(block.heading ? { heading: block.heading } : {}),
      ...(block.note ? { note: block.note } : {}),
    })),
    responseInstructions: bundle.responseInstructions,
    automaticCanonicalChange: bundle.automaticCanonicalChange,
    claimBoundary: bundle.claimBoundary,
  }
}

export async function anxTableEvidenceBundle(
  input: string | Uint8Array,
  page: number,
  options: AgentTableEvidenceOptions = {},
): Promise<Record<string, unknown>> {
  const maximumDescriptionCharacters = Math.max(
    120,
    Math.min(1200, options.maximumDescriptionCharacters ?? 700),
  )
  const limit = Math.max(1, Math.min(8, options.limit ?? 4))
  const result = await anxPageEvidence(input, page, {
    query: options.query,
    mode: 'compact',
  }) as unknown as FullPageResult
  const tableRegions = result.regions.filter(region => region.kind === 'table')
  if (
    options.tableRegionId
    && !tableRegions.some(region => region.id === options.tableRegionId)
  ) {
    throw new Error(`Table region is not available on source page ${page}: ${options.tableRegionId}`)
  }
  const ranked = tableRegions
    .filter(region => !options.tableRegionId || region.id === options.tableRegionId)
    .map(region => ({
      region,
      score: tableQueryScore(region, options.query),
    }))
    .sort((left, right) => (
      right.score - left.score
      || left.region.id.localeCompare(right.region.id)
    ))
  const selected = (
    options.query && ranked.some(item => item.score > 0)
      ? ranked.filter(item => item.score > 0)
      : ranked
  ).slice(0, limit)
  const tables = selected.map(({ region }) => tableAnswer(
    region,
    result.regions,
    maximumDescriptionCharacters,
  ))
  return {
    schema: ANX_TABLE_ANSWER_SCHEMA,
    projection: ANX_TABLE_ANSWER_PROJECTION,
    document: result.document,
    ...(result.source ? {
      source: {
        mediaType: result.source.mediaType,
        sha256: result.source.sha256,
      },
    } : {}),
    sourceBaseline: compactSourceBaseline(result.sourceBaseline),
    page: result.page,
    pageCount: result.pageCount,
    ...(options.query ? { query: options.query } : {}),
    selection: {
      tablesOnPage: tableRegions.length,
      returnedTables: selected.length,
      truncated: selected.length < tableRegions.length,
      ...(options.tableRegionId ? { requestedTableRegionId: options.tableRegionId } : {}),
      method: options.tableRegionId
        ? 'stable-region-id'
        : options.query
          ? 'deterministic-query-ranking'
          : 'source-order',
    },
    tables,
    ...(options.includeResponseEvidence === false ? {
      responseInstructions: 'Return the human answer, evidence judgment, and limitations. ANX records this tool result and deterministically attaches its canonical citations and machine evidence after model generation.',
    } : {
      responseEvidence: tableResponseEvidence(
        tables,
        compactSourceBaseline(result.sourceBaseline),
        result.automaticCanonicalChange,
      ),
      responseInstructions: 'Legacy full-envelope mode: copy responseEvidence exactly into task.evidence and copy its item citations into task.citations without duplicates.',
    }),
    automaticCanonicalChange: result.automaticCanonicalChange,
    policy: 'Use the table dimensions and evidence state as disclosed. Review structured-unverified cells against the retained source before quoting, comparing, or calculating exact values.',
    nextAction: selected.length
      ? 'Stop when this bundle answers the table question. Use anx_page_evidence only if exact geometry or unrelated page context is still required.'
      : 'No semantic table region matched this page and query. Use anx_search to locate the table or disclose that structured table evidence is unavailable.',
    claimBoundary: 'This bundle reports retained ANX table and linked-note evidence. It does not verify exact cell values, spans, source authenticity, or unattended safety beyond the explicit evidence fields.',
  }
}

export function anxResponseEvidenceFromTableBundle(
  bundleValue: unknown,
): AnxAgentResponseEvidence {
  if (!bundleValue || typeof bundleValue !== 'object' || Array.isArray(bundleValue)) {
    throw new Error('ANX_TABLE_EVIDENCE_INVALID: bundle must be an object')
  }
  const bundle = bundleValue as Record<string, unknown>
  if (bundle.schema !== ANX_TABLE_ANSWER_SCHEMA) {
    throw new Error(`ANX_TABLE_EVIDENCE_INVALID: schema must be ${ANX_TABLE_ANSWER_SCHEMA}`)
  }
  const tables = arrayRecords(bundle.tables)
  if (!tables.length) {
    throw new Error('ANX_TABLE_EVIDENCE_INVALID: bundle must contain at least one table')
  }
  return tableResponseEvidence(
    tables,
    objectValue(bundle.sourceBaseline),
    bundle.automaticCanonicalChange === true,
  )
}

export function anxTableEvidenceModelView(
  bundleValue: unknown,
): Record<string, unknown> {
  if (!bundleValue || typeof bundleValue !== 'object' || Array.isArray(bundleValue)) {
    throw new Error('ANX_TABLE_EVIDENCE_INVALID: bundle must be an object')
  }
  const bundle = bundleValue as Record<string, unknown>
  if (bundle.schema !== ANX_TABLE_ANSWER_SCHEMA) {
    throw new Error(`ANX_TABLE_EVIDENCE_INVALID: schema must be ${ANX_TABLE_ANSWER_SCHEMA}`)
  }
  const tables = arrayRecords(bundle.tables)
  return {
    schema: bundle.schema,
    projection: ANX_TABLE_MODEL_PROJECTION,
    document: bundle.document,
    sourceBaseline: bundle.sourceBaseline,
    page: bundle.page,
    tables: tables.map(table => {
      const evidence = objectValue(table.evidence)
      const tableEvidence = objectValue(evidence.tableEvidence)
      const agentUse = objectValue(table.agentUse)
      return {
        id: table.id,
        description: table.description,
        dimensions: table.dimensions,
        evidence: {
          status: evidence.status,
          unattendedUse: evidence.unattendedUse,
          semanticType: tableEvidence.semanticType,
          sourceRepresentation: tableEvidence.sourceRepresentation,
          dataState: tableEvidence.dataState,
          cellStructureAvailable: tableEvidence.cellStructureAvailable,
          cellStructureVerified: tableEvidence.cellStructureVerified,
          reviewRequired: agentUse.reviewRequired,
          safeForUnattendedAcceptance: agentUse.safeForUnattendedAcceptance,
          guidance: tableEvidence.guidance,
        },
        citation: table.citation,
        linkedEvidence: arrayRecords(table.linkedEvidence).map(linked => {
          const linkedEvidence = objectValue(linked.evidence)
          const linkedAgentUse = objectValue(linked.agentUse)
          return {
            id: linked.id,
            kind: linked.kind,
            description: linked.description,
            evidence: {
              status: linkedEvidence.status,
              unattendedUse: linkedEvidence.unattendedUse,
              noteKind: linkedEvidence.noteKind,
              marker: linkedEvidence.marker,
              anchorStatus: linkedEvidence.anchorStatus,
              reviewRequired: linkedAgentUse.reviewRequired,
              safeForUnattendedAcceptance: linkedAgentUse.safeForUnattendedAcceptance,
            },
            citation: linked.citation,
          }
        }),
      }
    }),
    responseInstructions: bundle.responseInstructions,
    automaticCanonicalChange: bundle.automaticCanonicalChange,
    claimBoundary: bundle.claimBoundary,
  }
}

function tableResponseEvidence(
  tables: Array<Record<string, unknown>>,
  sourceBaselineValue: Record<string, unknown>,
  automaticCanonicalChange: boolean,
): AnxAgentResponseEvidence {
  const items: AnxAgentResponseEvidenceItem[] = []
  for (const table of tables) {
    const evidence = objectValue(table.evidence)
    const tableEvidence = objectValue(evidence.tableEvidence)
    const agentUse = objectValue(table.agentUse)
    items.push({
      role: 'primary',
      evidenceId: stringValue(table.id),
      citation: stringValue(table.citation),
      semanticType: stringValue(tableEvidence.semanticType, 'table'),
      sourceRepresentation: enumValue(
        tableEvidence.sourceRepresentation,
        'unknown',
      ) as AnxAgentResponseEvidenceItem['sourceRepresentation'],
      dataState: enumValue(
        tableEvidence.dataState,
        'unknown',
      ) as AnxAgentResponseEvidenceItem['dataState'],
      textQuality: 'not-applicable',
      evidenceStatus: enumValue(
        evidence.status,
        'unknown',
      ) as AnxAgentResponseEvidenceItem['evidenceStatus'],
      unattendedUse: enumValue(
        evidence.unattendedUse,
        'unknown',
      ) as AnxAgentResponseEvidenceItem['unattendedUse'],
      safeForUnattendedAcceptance: booleanOrNull(agentUse.safeForUnattendedAcceptance),
      reviewRequired: booleanOrNull(agentUse.reviewRequired),
      dimensions: objectValue(table.dimensions) as unknown as AnxAgentResponseEvidenceItem['dimensions'],
      anchorStatus: 'not-applicable',
    })
    for (const linked of arrayRecords(table.linkedEvidence)) {
      const linkedEvidence = objectValue(linked.evidence)
      const linkedAgentUse = objectValue(linked.agentUse)
      items.push({
        role: 'supporting',
        evidenceId: stringValue(linked.id),
        citation: stringValue(linked.citation),
        semanticType: stringValue(linked.kind, 'unknown'),
        sourceRepresentation: 'not-applicable',
        dataState: 'not-applicable',
        textQuality: 'not-applicable',
        evidenceStatus: enumValue(
          linkedEvidence.status,
          'unknown',
        ) as AnxAgentResponseEvidenceItem['evidenceStatus'],
        unattendedUse: enumValue(
          linkedEvidence.unattendedUse,
          'unknown',
        ) as AnxAgentResponseEvidenceItem['unattendedUse'],
        safeForUnattendedAcceptance: booleanOrNull(linkedAgentUse.safeForUnattendedAcceptance),
        reviewRequired: booleanOrNull(linkedAgentUse.reviewRequired),
        dimensions: null,
        anchorStatus: enumValue(
          linkedEvidence.anchorStatus,
          'not-applicable',
        ) as AnxAgentResponseEvidenceItem['anchorStatus'],
      })
    }
  }
  return {
    schema: ANX_AGENT_RESPONSE_EVIDENCE_SCHEMA,
    representation: 'anx-native',
    sourceBaseline: {
      status: enumValue(
        sourceBaselineValue.status,
        'UNKNOWN',
      ) as AnxAgentResponseEvidence['sourceBaseline']['status'],
      trusted: booleanOrNull(sourceBaselineValue.trusted),
      issuerVerified: booleanOrNull(sourceBaselineValue.issuerVerified),
    },
    canonicalContentChangedAutomatically: automaticCanonicalChange,
    items,
  }
}

function pageTextResponseEvidence(
  blocks: Array<Record<string, unknown>>,
  sourceBaselineValue: Record<string, unknown>,
  automaticCanonicalChange: boolean,
): AnxAgentResponseEvidence {
  return {
    schema: ANX_AGENT_RESPONSE_EVIDENCE_SCHEMA,
    representation: 'anx-native',
    sourceBaseline: {
      status: enumValue(
        sourceBaselineValue.status,
        'UNKNOWN',
      ) as AnxAgentResponseEvidence['sourceBaseline']['status'],
      trusted: booleanOrNull(sourceBaselineValue.trusted),
      issuerVerified: booleanOrNull(sourceBaselineValue.issuerVerified),
    },
    canonicalContentChangedAutomatically: automaticCanonicalChange,
    items: blocks.map((block, index): AnxAgentResponseEvidenceItem => ({
      role: index === 0 ? 'primary' : 'supporting',
      evidenceId: stringValue(block.id),
      citation: stringValue(block.citation),
      semanticType: stringValue(block.type, 'unknown'),
      sourceRepresentation: enumValue(
        block.sourceRepresentation,
        'native-text',
      ) as AnxAgentResponseEvidenceItem['sourceRepresentation'],
      dataState: enumValue(
        block.dataState,
        'canonical-text',
      ) as AnxAgentResponseEvidenceItem['dataState'],
      textQuality: enumValue(
        block.textQuality,
        'unverified',
      ) as AnxAgentResponseEvidenceItem['textQuality'],
      evidenceStatus: enumValue(
        block.evidenceStatus,
        'unknown',
      ) as AnxAgentResponseEvidenceItem['evidenceStatus'],
      unattendedUse: enumValue(
        block.unattendedUse,
        'unknown',
      ) as AnxAgentResponseEvidenceItem['unattendedUse'],
      safeForUnattendedAcceptance: typeof block.safeForUnattendedAcceptance === 'boolean'
        ? block.safeForUnattendedAcceptance
        : null,
      reviewRequired: typeof block.reviewRequired === 'boolean'
        ? block.reviewRequired
        : null,
      dimensions: null,
      anchorStatus: 'not-applicable',
    })),
  }
}

function pageTextAnswer(block: Record<string, unknown>): Record<string, unknown> {
  return {
    id: block.nodeId,
    type: block.type,
    text: block.text,
    textQuality: block.textQuality,
    citation: block.citation,
    ...(block.heading ? { heading: block.heading } : {}),
    ...(block.note ? { note: block.note } : {}),
  }
}

function ocrPageTextAnswer(evidence: Record<string, unknown>): Record<string, unknown> {
  const reviewRequired = evidence.reviewRequired === true
  return {
    id: stringValue(evidence.anchorBlockId || evidence.sourcePageId),
    type: 'ocr-page-text',
    text: stringValue(evidence.text),
    textQuality: 'ocr',
    citation: stringValue(evidence.citation),
    sourceRepresentation: 'source-text',
    dataState: 'candidate-only',
    evidenceStatus: 'candidate',
    unattendedUse: enumValue(evidence.unattendedUse, 'review-required'),
    safeForUnattendedAcceptance: !reviewRequired,
    reviewRequired,
    candidateSha256: evidence.candidateSha256,
    sourceSha256: evidence.sourceSha256,
    meanConfidence: evidence.meanConfidence,
    numericReviewRequired: evidence.numericReviewRequired === true,
    numericAgreement: evidence.numericAgreement,
    reviewReasons: evidence.reviewReasons,
    guidance: evidence.guidance,
    canonical: false,
    automaticCanonicalChange: false,
  }
}

function pageTextQueryScore(block: Record<string, unknown>, query?: string): number {
  if (!query) return 0
  const haystack = normalizeQueryText(`${stringValue(block.type)} ${stringValue(block.text)}`)
  return [...new Set(normalizeQueryText(query).split(' '))]
    .filter(term => term.length > 2 && !pageTextRoutingStopWords.has(term))
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0)
}

const pageTextRoutingStopWords = new Set([
  'and',
  'about',
  'are',
  'current',
  'does',
  'from',
  'headings',
  'key',
  'main',
  'outline',
  'page',
  'points',
  'read',
  'says',
  'selected',
  'summarise',
  'summarize',
  'summary',
  'tell',
  'text',
  'the',
  'this',
  'topics',
  'transcribe',
  'transcription',
  'what',
  'written',
])

function pageTextTypePriority(block: Record<string, unknown>): number {
  return block.type === 'heading' ? 2 : block.type === 'footnote' ? 0 : 1
}

function compactRegion(region: FullPageRegion): Record<string, unknown> {
  const structuredData = compactStructuredData(region.structuredData)
  return {
    id: region.id,
    kind: region.kind,
    status: region.status,
    unattendedUse: region.unattendedUse,
    semanticLevel: region.semanticLevel,
    ...(region.parentRegionId ? { parentRegionId: region.parentRegionId } : {}),
    ...(region.childRegionIds?.length ? { childRegionIds: region.childRegionIds } : {}),
    ...(region.description ? { description: region.description } : {}),
    ...(region.transcription ? { transcription: region.transcription } : {}),
    ...(structuredData ? { structuredData } : {}),
    citation: region.citation.uri,
    ...(region.sourceCitations?.length ? {
      sourceCitations: region.sourceCitations.map(citationUri),
    } : {}),
    provenance: {
      method: region.provenance.method,
      source: region.provenance.source,
      verified: region.provenance.verified,
      ...(region.provenance.sourceSha256 ? { sourceSha256: region.provenance.sourceSha256 } : {}),
      ...(region.provenance.engine ? { engine: region.provenance.engine } : {}),
      ...(region.provenance.engineVersion ? { engineVersion: region.provenance.engineVersion } : {}),
      ...(typeof region.provenance.confidence === 'number' ? { confidence: region.provenance.confidence } : {}),
    },
    agentUse: {
      reviewRequired: region.agentUse.reviewRequired,
      safeForUnattendedAcceptance: region.agentUse.safeForUnattendedAcceptance,
      instruction: region.agentUse.instruction,
    },
  }
}

function tableAnswer(
  region: FullPageRegion,
  pageRegions: FullPageRegion[],
  maximumDescriptionCharacters: number,
): Record<string, unknown> {
  const structuredData = compactStructuredData(region.structuredData) || {}
  const rowCount = numericField(structuredData.rowCount)
  const columnCount = numericField(structuredData.columnCount)
  const sourceCitations = (region.sourceCitations || []).map(citationUri)
    .filter((value): value is string => Boolean(value))
  const sourceBlockId = sourceCitations[0]?.split('/').at(-1)
  const linkedEvidence = pageRegions.filter(candidate => {
    if (candidate.parentRegionId === region.id) return true
    const anchorBlockIds = candidate.structuredData?.anchorBlockIds
    return candidate.kind === 'note'
      && Boolean(sourceBlockId)
      && Array.isArray(anchorBlockIds)
      && anchorBlockIds.includes(sourceBlockId)
  })
  return {
    id: region.id,
    description: boundedText(region.description, maximumDescriptionCharacters),
    dimensions: {
      rowCount,
      columnCount,
      disclosure: rowCount !== null && columnCount !== null ? 'complete' : 'unavailable',
    },
    evidence: {
      status: region.status,
      unattendedUse: region.unattendedUse,
      semanticLevel: region.semanticLevel,
      regionRole: structuredData.regionRole,
      tableEvidence: structuredData.tableEvidence,
    },
    citation: region.citation.uri,
    sourceCitations,
    provenance: {
      method: region.provenance.method,
      source: region.provenance.source,
      verified: region.provenance.verified,
      ...(region.provenance.sourceSha256 ? { sourceSha256: region.provenance.sourceSha256 } : {}),
      ...(region.provenance.engine ? { engine: region.provenance.engine } : {}),
      ...(region.provenance.engineVersion ? { engineVersion: region.provenance.engineVersion } : {}),
      ...(typeof region.provenance.confidence === 'number' ? { confidence: region.provenance.confidence } : {}),
    },
    agentUse: {
      reviewRequired: region.agentUse.reviewRequired,
      safeForUnattendedAcceptance: region.agentUse.safeForUnattendedAcceptance,
      instruction: region.agentUse.instruction,
    },
    linkedEvidence: linkedEvidence.map(candidate => linkedAnswerEvidence(
      candidate,
      maximumDescriptionCharacters,
    )),
  }
}

function linkedAnswerEvidence(
  region: FullPageRegion,
  maximumDescriptionCharacters: number,
): Record<string, unknown> {
  const structuredData = compactStructuredData(region.structuredData) || {}
  return {
    id: region.id,
    kind: region.kind,
    description: boundedText(region.description, maximumDescriptionCharacters),
    evidence: {
      status: region.status,
      unattendedUse: region.unattendedUse,
      semanticLevel: region.semanticLevel,
      ...(structuredData.noteKind ? { noteKind: structuredData.noteKind } : {}),
      ...(structuredData.marker ? { marker: structuredData.marker } : {}),
      ...(structuredData.anchorStatus ? { anchorStatus: structuredData.anchorStatus } : {}),
      ...(structuredData.anchorBlockIds ? { anchorBlockIds: structuredData.anchorBlockIds } : {}),
    },
    citation: region.citation.uri,
    sourceCitations: (region.sourceCitations || []).map(citationUri)
      .filter((value): value is string => Boolean(value)),
    provenance: {
      method: region.provenance.method,
      source: region.provenance.source,
      verified: region.provenance.verified,
    },
    agentUse: {
      reviewRequired: region.agentUse.reviewRequired,
      safeForUnattendedAcceptance: region.agentUse.safeForUnattendedAcceptance,
      instruction: region.agentUse.instruction,
    },
  }
}

function compactStructuredData(value?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!value) return undefined
  const selected = Object.fromEntries(compactSemanticKeys
    .filter(key => value[key] !== undefined)
    .map(key => [key, value[key]]))
  return Object.keys(selected).length ? selected : undefined
}

function compactSourceBaseline(value: Record<string, unknown>): Record<string, unknown> {
  return {
    status: value.status,
    trusted: value.trusted,
    issuerVerified: value.issuerVerified,
    agentGuidance: value.agentGuidance,
  }
}

function citationUri(value?: { uri?: string } | string): string | undefined {
  if (typeof value === 'string') return value
  return value?.uri
}

function tableQueryScore(region: FullPageRegion, query?: string): number {
  if (!query) return 0
  const haystack = normalizeQueryText(`${region.id} ${region.description || ''}`)
  return [...new Set(normalizeQueryText(query).split(' '))]
    .filter(term => term.length > 1)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0)
}

function normalizeQueryText(value: string): string {
  return value.toLocaleLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function numericField(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null
}

function boundedText(value: string | undefined, maximum: number): string | undefined {
  if (!value || value.length <= maximum) return value
  return `${value.slice(0, maximum - 1).trimEnd()}…`
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>
    : []
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length ? value : fallback
}

function enumValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length ? value : fallback
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}
