import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  agentContentProjection,
  agentSharedContentIndex,
  sharedContentCitation,
  type AnxSharedContentCitation,
  type AnxSharedContentGroup,
} from './agent-shared-content.js'
import { createImageAsset } from './assets.js'
import { captionAssistedRegionEvidence } from './caption-assist.js'
import { withDocumentLocks } from './document-lock.js'
import { pdfOcrAgentReadDecision } from './ocr-agent-read.js'
import {
  type AnxRegionEvidence,
  type AnxRegionEvidenceQuery,
  type AnxRegionKind,
} from './region-evidence.js'
import { exportAndocPdf } from './pdf-export.js'
import {
  generatePdfOcrCandidates,
  validatedPackagePdfOcrCandidates,
} from './pdf-ocr.js'
import { packagePdfTextQuality, pdfTextLegibilityState, type PdfTextLegibilityState } from './pdf-text-quality.js'
import { ANX_SOURCE_BASELINES_PATH, packAndoc, readAndoc, type AndocPackage } from './package.js'
import { transactAndocPackage } from './revision.js'
import { previewTransaction } from './revision-review.js'
import { addReviewProposalTransaction, reviewSummary } from './review.js'
import { RevisionConflictError } from './transaction.js'
import type { AndocBlock, AndocDocument, AndocOperation, AndocTransaction, Provenance, TableCell } from './types.js'
import { sourceBaselineSummary, verifySourceBaseline } from './source-baseline.js'
import {
  documentRelationships,
  relationshipById,
  relationshipCitation,
  type AnxRelationshipCitation,
  type AnxRelationshipQuery,
} from './relationships.js'

export interface NodeCitation {
  uri: string
  documentId: string
  revision: number
  blockId: string
  nodeId: string
  blockType: AndocBlock['type']
  page?: number
  sourceUri?: string
  bbox?: [number, number, number, number]
  textQuality: PdfTextLegibilityState
}

export interface RegionCitation {
  uri: string
  documentId: string
  revision: number
  regionId: string
  evidenceType: 'region'
  page: number
  kind: AnxRegionKind
  status: AnxRegionEvidence['status']
  unattendedUse: AnxRegionEvidence['unattendedUse']
  bbox: [number, number, number, number]
  coordinateOrigin: AnxRegionEvidence['coordinateOrigin']
  source: string
  sourceSha256?: string
}

export interface SourcePageCitation {
  uri: string
  documentId: string
  revision: number
  sourcePageId: string
  evidenceType: 'source-page'
  page: number
  sourceUri: string
  sourceSha256: string
  textQuality: PdfTextLegibilityState
}

export type AgentCitation = NodeCitation | RegionCitation | SourcePageCitation | AnxRelationshipCitation | AnxSharedContentCitation

export interface AgentTransactionOptions {
  actorId?: string
  message?: string
  includeInverse?: boolean
  baseRevision?: number
}

export type AgentResponseMode = 'compact' | 'standard'

export interface AgentQueryOptions {
  limit?: number
  contextBefore?: number
  contextAfter?: number
  maximumCharacters?: number
  mode?: AgentResponseMode
}

export interface AgentBatchOptions {
  maximumCharacters?: number
  mode?: AgentResponseMode
}

export interface AgentAdaptiveReadOptions {
  query?: string
  maximumTokens?: number
  estimatedCharactersPerToken?: number
  mode?: AgentResponseMode
}

export interface AgentPageEvidenceOptions {
  query?: string
  kinds?: AnxRegionKind[]
  includeParts?: boolean
  maximumBlocks?: number
  maximumCharacters?: number
  mode?: AgentResponseMode
}

interface CachedPackage {
  fingerprint: string
  pkg: AndocPackage
}

interface RankedNode {
  block: AndocBlock
  cell?: TableCell
  nodeId: string
  text: string
  score: number
  matchText: string
  normalizedText: string
}

const maximumCachedPackages = 8
const packageCache = new Map<string, CachedPackage>()

export async function andocOpen(input: string | Uint8Array): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const sourceBaseline = await verifySourceBaseline(pkg)
  return {
    documentId: document.documentId,
    revision: document.revision,
    title: document.title,
    blockCount: document.blocks.length,
    assetCount: Object.keys(document.assets).length,
    cached: typeof input === 'string',
    sourceBaseline: sourceBaselineSummary(sourceBaseline),
    ...(quality.report ? {
      textQuality: {
        schema: quality.report.schema,
        summary: quality.report.summary,
        pages: quality.report.pages.map(page => ({ page: page.page, state: quality.byPage.get(page.page) })),
      },
    } : {}),
  }
}

export async function andocTextQuality(input: string | Uint8Array, includeCleanPages = false): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const sourceEntry = pkg.manifest.entries.find(entry => entry.path.startsWith('sources/original/') && entry.mediaType === 'application/pdf')
  if (!sourceEntry) throw new Error('The ANX package does not contain an original PDF source')
  const report = await packagePdfTextQuality(pkg)
  if (!report) throw new Error('The ANX package does not contain enough retained PDF and Docling evidence for text-quality diagnosis')
  const pages = includeCleanPages
    ? report.pages
    : report.pages.filter(page => page.recommendedRoute !== 'native' && page.recommendedRoute !== 'none')
  return {
    document: { id: pkg.document.documentId, revision: pkg.document.revision, title: pkg.document.title },
    source: { path: sourceEntry.path, sha256: sourceEntry.sha256, bytes: sourceEntry.size },
    schema: report.schema,
    analyzer: report.analyzer,
    pageCount: report.pageCount,
    summary: report.summary,
    returnedPages: pages.length,
    includeCleanPages,
    pages,
  }
}

export async function andocRegions(input: string | Uint8Array, query: AnxRegionEvidenceQuery = {}): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const state = captionAssistedRegionEvidence(pkg, { includeParts: false, ...query })
  const sourceEntry = pkg.manifest.entries.find(entry => entry.path.startsWith('sources/original/'))
  const sourceBaseline = await verifySourceBaseline(pkg)
  return {
    document: { id: pkg.document.documentId, revision: pkg.document.revision, title: pkg.document.title },
    ...(sourceEntry ? { source: { path: sourceEntry.path, mediaType: sourceEntry.mediaType, sha256: sourceEntry.sha256, bytes: sourceEntry.size } } : {}),
    sourceBaseline: sourceBaselineSummary(sourceBaseline),
    ...state,
  }
}

export async function anxPageEvidence(
  input: string | Uint8Array,
  page: number,
  options: AgentPageEvidenceOptions = {},
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(page) || page < 1) throw new Error(`Page must be a positive integer: ${page}`)
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const pageCount = retainedPageCount(document, quality.report?.pageCount)
  if (pageCount && page > pageCount) throw new Error(`Page ${page} exceeds the retained ${pageCount}-page source`)

  const maximumBlocks = clampInteger(options.maximumBlocks ?? 32, 1, 250)
  const maximumCharacters = clampInteger(options.maximumCharacters ?? 700, 120, 4_000)
  const mode = options.mode || 'compact'
  const pageBlocks = document.blocks.filter(block => block.provenance?.page === page)
  const state = captionAssistedRegionEvidence(pkg, {
    page,
    ...(options.kinds?.length ? { kinds: options.kinds } : {}),
    includeParts: options.includeParts === true,
  })
  const selectedBlocks = selectPageEvidenceBlocks(pageBlocks, state.regions, maximumBlocks, options.query)
  const returnedBlocks = selectedBlocks
    .map(block => compactNode(document, { block }, maximumCharacters, mode, quality.byPage))
  const regions = state.regions.map(region => {
    const citation = regionCitationFor(document, region)
    const sourceCitations = regionSourceCitations(document, region, quality.byPage)
    const tableEvidence = tableEvidenceRecord(region)
    const tableUseAllowed = !tableEvidence || tableEvidence.agentUse === 'allowed'
    return {
      ...region,
      citation,
      agentUse: {
        directCitation: citation.uri,
        unattendedUse: region.unattendedUse,
        reviewRequired: region.unattendedUse === 'review-required' || !tableUseAllowed,
        safeForUnattendedAcceptance: region.unattendedUse === 'allowed' && tableUseAllowed,
        instruction: regionAgentInstruction(region),
      },
      ...(sourceCitations.length ? {
        sourceCitations: sourceCitations.map(sourceCitation => mode === 'compact' ? sourceCitation.uri : sourceCitation),
      } : {}),
    }
  })
  const sourceEntry = pkg.manifest.entries.find(entry => entry.path.startsWith('sources/original/'))
  const sourceBaseline = await verifySourceBaseline(pkg)
  const ocrEvidence = validatedPageOcrEvidence(
    pkg,
    page,
    pageBlocks,
    quality.byPage,
    maximumCharacters,
  )

  return {
    schema: 'anx.page-evidence.v1',
    document: { id: document.documentId, revision: document.revision, title: document.title },
    ...(sourceEntry ? {
      source: {
        path: sourceEntry.path,
        mediaType: sourceEntry.mediaType,
        sha256: sourceEntry.sha256,
        bytes: sourceEntry.size,
      },
    } : {}),
    sourceBaseline: sourceBaselineSummary(sourceBaseline),
    page,
    pageCount,
    ...(options.query ? { query: options.query } : {}),
    textQuality: quality.byPage.get(page) || 'unverified',
    blocks: returnedBlocks,
    ...(ocrEvidence ? { ocrEvidence } : {}),
    regions,
    captionAssist: state.captionAssist,
    summary: {
      canonicalBlocks: pageBlocks.length,
      returnedBlocks: returnedBlocks.length,
      blocksTruncated: returnedBlocks.length < pageBlocks.length,
      blockSelection: returnedBlocks.length < pageBlocks.length
        ? 'bounded-priority: headings, tables, query matches, and coordinate-compatible region-overlapping blocks first; returned blocks remain in source order'
        : 'complete-page-source-order',
      semanticRegions: regions.filter(region => region.defaultVisibility === 'visible').length,
      evidenceParts: regions.filter(region => region.defaultVisibility === 'evidence-only').length,
      verifiedRegions: regions.filter(region => region.status === 'verified').length,
      reviewRequiredRegions: regions.filter(region => region.unattendedUse === 'review-required').length,
      reviewRequiredRegionIds: regions.filter(region => region.unattendedUse === 'review-required').map(region => region.id),
      abstainedRegions: regions.filter(region => region.unattendedUse === 'abstain').length,
      abstainedRegionIds: regions.filter(region => region.unattendedUse === 'abstain').map(region => region.id),
    },
    issues: state.issues,
    automaticCanonicalChange: false,
    citationGuidance: 'Use each block citation for canonical text and each region citation for the region description, semantic type, status, geometry, and provenance. When ocrEvidence is present, its citation anchors the validated candidate to the retained source page; OCR remains candidate-only and is never canonical text. Region citations are independently resolvable by ID. Do not use contextual block citations as substitutes for a region claim.',
    guidance: state.guidance,
    claimBoundary: state.claimBoundary,
  }
}

function validatedPageOcrEvidence(
  pkg: AndocPackage,
  page: number,
  pageBlocks: AndocBlock[],
  qualityByPage: Map<number, PdfTextLegibilityState>,
  maximumCharacters: number,
): Record<string, unknown> | null {
  const report = validatedPackagePdfOcrCandidates(pkg)
  const candidate = report?.pages.find(item => item.page === page)
  if (!report || !candidate) return null
  const decision = pdfOcrAgentReadDecision(candidate)
  const anchor = pageBlocks.find(block => block.type !== 'pageBreak') || pageBlocks[0]
  const citation = anchor
    ? citationFor(pkg.document, anchor.id, qualityByPage)
    : sourcePageCitationFor(pkg, page, qualityByPage)
  return {
    evidenceType: 'ocr-page-candidate',
    page,
    text: shorten(candidate.ocrCandidate.text, maximumCharacters),
    textTruncated: candidate.ocrCandidate.text.length > maximumCharacters,
    citation: citation.uri,
    ...(anchor ? { anchorBlockId: anchor.id } : { sourcePageId: `source-page-${page}` }),
    sourceSha256: report.sourceSha256,
    candidateSha256: candidate.ocrCandidate.sha256,
    nativeSha256: candidate.nativeCandidate.sha256,
    meanConfidence: candidate.ocrCandidate.meanConfidence,
    minimumConfidence: candidate.ocrCandidate.minimumConfidence,
    lineCount: candidate.ocrCandidate.lineCount,
    preferredSource: decision.preferredSource,
    evidenceState: decision.evidenceState,
    unattendedUse: decision.unattendedUse,
    reviewRequired: decision.unattendedUse === 'review-required',
    numericReviewRequired: candidate.comparison.numericReviewRequired,
    numericAgreement: candidate.comparison.numericAgreement,
    reviewReasons: decision.reviewReasons,
    guidance: decision.guidance,
    canonical: false,
    automaticCanonicalChange: false,
    engine: {
      name: report.engine.name,
      version: report.engine.version,
      policyId: report.engine.policyId,
      policySha256: report.engine.policySha256,
      modelHashes: report.engine.models.map(model => model.sha256),
    },
  }
}

function regionAgentInstruction(region: AnxRegionEvidence): string {
  const tableEvidence = tableEvidenceRecord(region)
  if (tableEvidence && typeof tableEvidence.guidance === 'string') return tableEvidence.guidance
  return region.unattendedUse === 'allowed'
    ? 'This verified region may be used unattended within the disclosed claim boundary.'
    : region.unattendedUse === 'abstain'
      ? 'Do not use this region for an unattended claim.'
      : 'Disclose that source review is required; do not present this region as verified or unattended-safe.'
}

function tableEvidenceRecord(region: AnxRegionEvidence): Record<string, unknown> | null {
  return region.kind === 'table'
    && region.structuredData?.tableEvidence
    && typeof region.structuredData.tableEvidence === 'object'
    && !Array.isArray(region.structuredData.tableEvidence)
    ? region.structuredData.tableEvidence as Record<string, unknown>
    : null
}

export interface AgentOcrCandidatesOptions {
  pages?: number[]
  mode?: 'router' | 'all'
  includeText?: boolean
  textPageLimit?: number
  dpi?: number
  pageBatchSize?: number
  fullReport?: boolean
  pythonCommand?: string
  bridgePath?: string
  attachTo?: string
}

export async function andocOcrCandidates(
  input: string | Uint8Array,
  options: AgentOcrCandidatesOptions = {},
): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const sourceEntry = pkg.manifest.entries.find(entry => entry.path.startsWith('sources/original/') && entry.mediaType === 'application/pdf')
  if (!sourceEntry) throw new Error('The ANX package does not contain an original PDF source')
  const quality = await packagePdfTextQuality(pkg)
  if (!quality) throw new Error('The ANX package does not contain enough retained PDF and Docling evidence for OCR candidate generation')

  const requested = options.pages && options.pages.length ? [...new Set(options.pages)].sort((a, b) => a - b) : null
  if (requested) {
    const invalid = requested.filter(page => !Number.isInteger(page) || page < 1 || page > quality.pageCount)
    if (invalid.length) throw new Error(`Requested pages are out of range for this ${quality.pageCount}-page document: ${invalid.join(', ')}`)
  }
  const mode = requested ? 'pages' : options.mode === 'all' ? 'all' : 'router'
  const requestedSet = requested ? new Set(requested) : null
  const selectedPages = quality.pages
    .filter(page => (requestedSet ? requestedSet.has(page.page) : mode === 'all' ? true : page.recommendedRoute.startsWith('ocr-')))
    .map(page => (page.recommendedRoute.startsWith('ocr-') ? page : { ...page, recommendedRoute: 'ocr-compare' as const }))

  const document = { id: pkg.document.documentId, revision: pkg.document.revision, title: pkg.document.title }
  const source = { path: sourceEntry.path, sha256: sourceEntry.sha256, bytes: sourceEntry.size }
  const selection = { mode, ...(requested ? { requestedPages: requested } : {}), selectedPageCount: selectedPages.length }
  if (!selectedPages.length) {
    return {
      document, source, selection,
      automaticCanonicalChange: false,
      routedPages: [], returnedPages: 0, pages: [],
      note: 'No pages selected: the router found no OCR-worthy pages and no explicit pages or all-page mode was requested.',
    }
  }

  const doclingEntry = pkg.files['sources/docling/document.json']
  if (!doclingEntry) throw new Error('The ANX package does not retain its Docling companion document')
  const docling = JSON.parse(Buffer.from(doclingEntry).toString('utf8'))
  const report = await generatePdfOcrCandidates(pkg.files[sourceEntry.path]!, docling, { ...quality, pages: selectedPages }, {
    ...(options.dpi ? { dpi: options.dpi } : {}),
    ...(options.pageBatchSize ? { pageBatchSize: options.pageBatchSize } : {}),
    ...(options.pythonCommand ? { pythonCommand: options.pythonCommand } : {}),
    ...(options.bridgePath ? { bridgePath: options.bridgePath } : {}),
    timeoutSeconds: 1800,
  })

  let attachedTo: string | null = null
  if (options.attachTo) {
    if (typeof input !== 'string') throw new Error('Attaching candidate evidence requires a package path input')
    if (pkg.finalizations.length) throw new Error('Cannot attach candidate evidence to a finalized package; derive a draft first')
    const inputPath = path.resolve(input)
    const outputPath = path.resolve(options.attachTo)
    await withDocumentLocks([inputPath, outputPath], async () => {
      const current = await readAndoc(inputPath)
      if (current.finalizations.length) throw new Error('Cannot attach candidate evidence to a finalized package; derive a draft first')
      const currentSource = current.manifest.entries.find(
        entry => entry.path.startsWith('sources/original/') && entry.mediaType === 'application/pdf',
      )
      if (!currentSource || currentSource.sha256 !== report.sourceSha256) {
        throw new Error(
          `Cannot attach candidate evidence because the retained PDF changed during OCR candidate generation: expected ${report.sourceSha256}, received ${currentSource?.sha256 || 'missing'}`,
        )
      }
      const assets = Object.fromEntries(Object.values(current.document.assets).map(asset => {
        const bytes = current.files[asset.packagePath]
        if (!bytes) throw new Error(`Cannot attach evidence: missing asset bytes for ${asset.id}`)
        return [asset.id, bytes]
      }))
      const sources: Record<string, Uint8Array> = Object.fromEntries(
        Object.entries(current.files).filter(([entryPath]) => entryPath.startsWith('sources/') && entryPath !== ANX_SOURCE_BASELINES_PATH),
      )
      // Evidence attachment: candidates are retained source evidence, never a
      // canonical change — document, revision, and transaction history are
      // byte-preserved, exactly like import-time evidence.
      sources['sources/ocr/candidates.json'] = new TextEncoder().encode(JSON.stringify(report, null, 2) + '\n')
      const bytes = await packAndoc({
        document: current.document,
        versionBaseline: current.versionBaseline || current.document,
        assets,
        sources,
        transactions: current.transactions,
        ...(current.profiles ? { profiles: current.profiles } : {}),
        ...(current.lineage ? { lineage: current.lineage } : {}),
        ...(current.sourceBaselines ? { sourceBaselines: current.sourceBaselines } : {}),
      })
      await atomicWrite(outputPath, bytes)
      packageCache.delete(outputPath)
    })
    attachedTo = outputPath
  }

  const textPageLimit = Math.max(1, Math.min(options.textPageLimit ?? 5, 20))
  let textIncluded = 0
  const pages = report.pages.map(page => {
    const agentRead = pdfOcrAgentReadDecision(page)
    const compact: Record<string, unknown> = {
      page: page.page,
      route: page.route,
      nativeStronglyCorrupted: page.nativeCandidate.metrics.stronglyCorrupted,
      nativeSha256: page.nativeCandidate.sha256,
      candidateSha256: page.ocrCandidate.sha256,
      ocrMeanConfidence: page.ocrCandidate.meanConfidence,
      ocrMinimumConfidence: page.ocrCandidate.minimumConfidence,
      ocrLineCount: page.ocrCandidate.lineCount,
      ...(page.ocrCandidate.rawLineCount !== undefined ? { ocrRawLineCount: page.ocrCandidate.rawLineCount } : {}),
      normalizedSimilarity: page.comparison.normalizedSimilarity,
      tokenOverlap: page.comparison.tokenOverlap,
      numericAgreement: page.comparison.numericAgreement,
      numericReviewRequired: page.comparison.numericReviewRequired,
      recommendation: page.comparison.recommendation,
      reasons: page.comparison.reasons,
      agentRead,
      render: page.render,
      ...(page.resolution ? { resolution: page.resolution } : {}),
      wallElapsedMs: page.timing.wallElapsedMs,
    }
    if (options.includeText === true && textIncluded < textPageLimit) {
      textIncluded += 1
      compact.ocrText = page.ocrCandidate.text
      compact.ocrLines = page.ocrCandidate.lines
      compact.nativeText = page.nativeCandidate.text
    }
    return compact
  })

  return {
    document, source, selection,
    engine: report.engine,
    renderer: report.renderer,
    automaticCanonicalChange: report.automaticCanonicalChange,
    routedPages: report.routedPages,
    returnedPages: pages.length,
    includedTextPages: textIncluded,
    agentReadSummary: {
      ocrPreferredPages: pages.filter(page => (page.agentRead as Record<string, unknown>).preferredSource === 'ocr').length,
      nativePreferredPages: pages.filter(page => (page.agentRead as Record<string, unknown>).preferredSource === 'native').length,
      comparisonRequiredPages: pages.filter(page => (page.agentRead as Record<string, unknown>).preferredSource === null).length,
      reviewRequiredPages: pages.filter(page => (page.agentRead as Record<string, unknown>).unattendedUse === 'review-required').length,
      canonicalChange: false,
    },
    ...(attachedTo ? { attachedTo, attachedEntry: 'sources/ocr/candidates.json', canonicalRevisionUnchanged: true } : {}),
    pages,
    ...(options.fullReport === true ? { fullReport: report } : {}),
  }
}

export async function andocReadAdaptive(
  input: string | Uint8Array,
  options: AgentAdaptiveReadOptions = {},
): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const maximumTokens = clampInteger(options.maximumTokens ?? 8_000, 512, 100_000)
  const charactersPerToken = Math.max(2, Math.min(8, options.estimatedCharactersPerToken ?? 4))
  const maximumCharacters = Math.floor(maximumTokens * charactersPerToken)
  const canonicalNodes = document.blocks.map(block => ({
    nodeId: block.id,
    citation: citationFor(document, block.id, quality.byPage).uri,
    block,
  }))
  const projection = agentContentProjection(document)
  const expandedSharedContent = new Map(
    agentSharedContentIndex(document, { expandOccurrences: true }).groups.map(group => [group.id, group]),
  )
  const sharedContent = projection.sharedContent.map(group => ({
    ...group,
    citation: sharedContentCitation(document, group),
    agentUse: sharedContentAgentUse(expandedSharedContent.get(group.id) || group, quality.byPage),
    expansion: { tool: 'andoc_shared_content', sharedContentId: group.id, expandOccurrences: true },
  }))
  const serializedCanonicalCharacters = JSON.stringify(canonicalNodes).length
  const serializedProjectedCharacters = projection.sharedContentGroupCount
    ? JSON.stringify({ nodes: projection.nodes, sharedContent }).length
    : serializedCanonicalCharacters
  const estimatedCanonicalTokens = Math.ceil(serializedCanonicalCharacters / charactersPerToken)
  const estimatedProjectedTokens = Math.ceil(serializedProjectedCharacters / charactersPerToken)
  const budget = {
    maximumTokens,
    estimatedCharactersPerToken: charactersPerToken,
    maximumCharacters,
    estimatedFullTokens: estimatedProjectedTokens,
    estimatedCanonicalTokens,
    estimatedProjectedTokens,
    estimatedTokenSavings: Math.max(0, estimatedCanonicalTokens - estimatedProjectedTokens),
  }

  if (serializedProjectedCharacters <= maximumCharacters) {
    return {
      strategy: projection.sharedContentGroupCount ? 'full-structured-deduplicated' : 'full-canonical',
      document: { id: document.documentId, revision: document.revision, title: document.title },
      budget,
      fullContextEligible: true,
      nodeIdsInline: true,
      canonicalFidelity: 'The canonical document and retained source remain lossless. This default agent projection stores recurring text once and supplies its page scope; exact occurrences remain expandable.',
      canonicalBlocks: document.blocks.length,
      returnedBlocks: projection.nodes.length,
      sharedContentGroupCount: projection.sharedContentGroupCount,
      compactedOccurrenceCount: projection.compactedOccurrenceCount,
      nodes: projection.nodes,
      sharedContent,
    }
  }

  const query = options.query?.trim()
  if (query) {
    const perNodeCharacters = clampInteger(Math.floor(maximumCharacters / 8), 240, 4_000)
    const retrieval = await andocQuery(input, query, {
      limit: 5,
      contextBefore: 1,
      contextAfter: 1,
      maximumCharacters: perNodeCharacters,
      mode: options.mode || 'compact',
    })
    return {
      strategy: 'bounded-retrieval',
      document: { id: document.documentId, revision: document.revision, title: document.title },
      budget,
      fullContextEligible: false,
      query,
      retrieval,
    }
  }

  const outline = await andocOutline(input, Math.min(250, document.blocks.length))
  return {
    strategy: 'outline-then-query',
    document: { id: document.documentId, revision: document.revision, title: document.title },
    budget,
    fullContextEligible: false,
    outline,
    guidance: 'The canonical document exceeds the requested token budget. Call this tool again with a focused query to receive bounded evidence and revision-pinned citations.',
  }
}

export async function andocOutline(input: string | Uint8Array, maximumBlocks = 200): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const sharedByNode = sharedGroupByNode(document)
  const seenShared = new Set<string>()
  const projectedBlocks: Array<Record<string, unknown>> = []
  for (const block of document.blocks) {
    const shared = sharedByNode.get(block.id)
    if (shared) {
      if (seenShared.has(shared.id)) continue
      seenShared.add(shared.id)
      const firstNodeCitation = citationFor(document, block.id, quality.byPage)
      projectedBlocks.push({
        id: shared.id,
        type: 'sharedContent',
        sharedContentId: shared.id,
        text: shared.text,
        occurrenceCount: shared.occurrenceCount,
        pageRanges: shared.pageRanges,
        citation: sharedContentCitation(document, shared).uri,
        textQuality: firstNodeCitation.textQuality,
        expansion: { tool: 'andoc_shared_content', sharedContentId: shared.id, expandOccurrences: true },
      })
      continue
    }
    const citation = citationFor(document, block.id, quality.byPage)
    projectedBlocks.push({
      id: block.id,
      type: block.type,
      ...(block.type === 'heading' ? { level: block.level } : {}),
      text: summarizeBlock(block),
      ...(block.provenance?.page ? { page: block.provenance.page } : {}),
      citation: citation.uri,
      textQuality: citation.textQuality,
    })
  }
  const blocks = projectedBlocks.slice(0, Math.max(1, maximumBlocks))
  const sourceOnlySharedContent = agentSharedContentIndex(document).groups
    .filter(group => group.sourceOnly)
    .map(group => ({
      ...group,
      citation: sharedContentCitation(document, group),
      expansion: { tool: 'andoc_shared_content', sharedContentId: group.id, expandOccurrences: true },
    }))
  return {
    documentId: document.documentId,
    title: document.title,
    revision: document.revision,
    blockCount: document.blocks.length,
    returnedBlocks: blocks.length,
    projectedBlockCount: projectedBlocks.length,
    truncated: blocks.length < projectedBlocks.length,
    blocks,
    sourceOnlySharedContent,
    projectionSummary: {
      sharedContentGroups: seenShared.size + sourceOnlySharedContent.length,
      compactedCanonicalOccurrences: document.blocks.length - projectedBlocks.length,
      canonicalContentChanged: false,
    },
  }
}

export async function andocGet(input: string | Uint8Array, nodeId: string): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const located = locateNode(document, nodeId)
  return {
    documentId: document.documentId,
    revision: document.revision,
    citation: citationFor(document, nodeId, quality.byPage),
    block: located.block,
    ...(located.cell ? { cell: located.cell } : {}),
  }
}

export async function andocSearch(input: string | Uint8Array, query: string, limit = 10): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const maximum = clampInteger(limit, 1, 100)
  const ranked = rankNodes(document, query)
  const sharedByNode = sharedGroupByNode(document)
  const seenShared = new Set<string>()
  const selected = ranked.filter(candidate => {
    const shared = sharedByNode.get(candidate.nodeId)
    if (!shared) return true
    if (seenShared.has(shared.id)) return false
    seenShared.add(shared.id)
    return true
  }).slice(0, maximum)
  const matches = selected.map(candidate => ({
    blockId: candidate.block.id,
    nodeId: candidate.nodeId,
    type: candidate.block.type,
    excerpt: excerptFor(candidate.text, candidate.matchText, 420),
    citation: citationFor(document, candidate.nodeId, quality.byPage),
    score: candidate.score,
    ...(sharedByNode.get(candidate.nodeId) ? {
      sharedContent: compactSharedGroup(document, sharedByNode.get(candidate.nodeId)!),
    } : {}),
  }))
  return { documentId: document.documentId, revision: document.revision, query, matches, truncated: ranked.length > matches.length }
}

export async function anxRelationships(
  input: string | Uint8Array,
  query: AnxRelationshipQuery = {},
): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  return documentRelationships(pkg.document, query)
}

export async function andocEditLocate(input: string | Uint8Array, query: string, limit = 5): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const maximum = clampInteger(limit, 1, 25)
  const ranked = rankNodes(document, query)
  const matches = ranked.slice(0, maximum).map(candidate => {
    const citation = citationFor(document, candidate.nodeId, quality.byPage)
    const tableContext = candidate.cell && candidate.block.type === 'table'
      ? tableCellEditContext(candidate.block, candidate.cell)
      : null
    return {
      blockId: candidate.block.id,
      nodeId: candidate.nodeId,
      type: candidate.cell ? 'tableCell' : candidate.block.type,
      currentText: candidate.text,
      score: candidate.score,
      citation,
      ...(tableContext ? { tableContext } : {}),
      operationTemplate: editOperationTemplate(candidate.block, candidate.cell),
      ...(!candidate.cell ? { insertAfterTemplate: insertAfterTemplate(candidate.block.id) } : {}),
      ...(!candidate.cell ? { structuralOperationTemplates: structuralOperationTemplates(candidate.block.id) } : {}),
      ...(candidate.block.type === 'chart' && !candidate.cell ? { chartDataOperationTemplate: chartDataOperationTemplate(candidate.block.id) } : {}),
    }
  })
  return {
    document: { id: document.documentId, revision: document.revision, title: document.title },
    query,
    matches,
    truncated: ranked.length > matches.length,
    guidance: 'Copy the exact op and ID field names from the template matching the requested edit. Replace placeholder values only. Use insertAfterTemplate for insertion, structuralOperationTemplates for move/remove, and chartDataOperationTemplate only when structured chart data is explicitly supplied with evidence.',
  }
}

export async function andocQuery(
  input: string | Uint8Array,
  query: string,
  options: AgentQueryOptions = {},
): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const maximum = clampInteger(options.limit ?? 3, 1, 25)
  const contextBefore = clampInteger(options.contextBefore ?? 1, 0, 5)
  const contextAfter = clampInteger(options.contextAfter ?? 1, 0, 5)
  const maximumCharacters = clampInteger(options.maximumCharacters ?? 700, 120, 4000)
  const mode = options.mode || 'compact'
  const ranked = rankNodes(document, query)
  const sharedByNode = sharedGroupByNode(document)
  const selected = selectQueryMatches(ranked, query, maximum, sharedByNode)
  const matches = selected.map((candidate, index) => ({
    score: candidate.score,
    evidence: evidenceNodes(document, candidate, maximumCharacters, mode, quality.byPage),
    ...(sharedByNode.get(candidate.nodeId) ? {
      sharedContent: compactSharedGroup(document, sharedByNode.get(candidate.nodeId)!),
    } : {}),
    context: index === 0
      ? contextNodes(document, candidate.block.id, contextBefore, contextAfter, Math.max(240, Math.floor(maximumCharacters / 2)), mode, quality.byPage)
      : [],
  }))
  return {
    document: { id: document.documentId, revision: document.revision, title: document.title },
    query,
    matches,
    citationGuidance: 'Cite every evidence node with evidenceRole answer that directly supports a distinct part of the response. Do not cite lead-in, context-only, or unrelated nodes.',
    truncated: ranked.length > matches.length,
  }
}

export async function andocGetBatch(
  input: string | Uint8Array,
  nodeIds: string[],
  options: AgentBatchOptions = {},
): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const maximumCharacters = clampInteger(options.maximumCharacters ?? 1200, 120, 4000)
  const mode = options.mode || 'compact'
  const uniqueIds = [...new Set(nodeIds.map(value => value.trim()).filter(Boolean))]
  if (!uniqueIds.length) throw new Error('At least one node ID is required')
  if (uniqueIds.length > 50) throw new Error('A maximum of 50 node IDs may be retrieved at once')
  return {
    document: { id: document.documentId, revision: document.revision, title: document.title },
    nodes: uniqueIds.map(nodeId => compactNode(document, locateNode(document, nodeId), maximumCharacters, mode, quality.byPage)),
  }
}

export async function andocSharedContent(
  input: string | Uint8Array,
  sharedContentId?: string,
  expandOccurrences = false,
): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const index = agentSharedContentIndex(document, { expandOccurrences })
  const expandedById = new Map(
    (expandOccurrences ? index : agentSharedContentIndex(document, { expandOccurrences: true })).groups.map(group => [group.id, group]),
  )
  const groups = sharedContentId
    ? index.groups.filter(group => group.id === sharedContentId)
    : index.groups
  if (sharedContentId && !groups.length) throw new Error(`Shared content group not found: ${sharedContentId}`)
  return {
    schema: index.schema,
    document: { id: document.documentId, revision: document.revision, title: document.title },
    policy: index.policy,
    summary: {
      groups: groups.length,
      occurrences: groups.reduce((sum, group) => sum + group.occurrenceCount, 0),
      canonicalOccurrences: groups.reduce((sum, group) => sum + group.canonicalOccurrenceCount, 0),
      sourceOnlyOccurrences: groups.reduce((sum, group) => sum + (group.sourceOnly ? group.occurrenceCount : 0), 0),
      expanded: expandOccurrences,
      canonicalContentChanged: false,
    },
    groups: groups.map(group => ({
      ...group,
      citation: sharedContentCitation(document, group),
      agentUse: sharedContentAgentUse(expandedById.get(group.id) || group, quality.byPage),
      ...(!expandOccurrences ? {
        expansion: { tool: 'andoc_shared_content', sharedContentId: group.id, expandOccurrences: true },
      } : {}),
    })),
    guidance: 'Use the shared text once for its disclosed page scope. Expand occurrences when exact page/node citations, adjacency, legal review, or page-specific verification is required. Near-matches are never merged.',
  }
}

export async function andocContext(
  input: string | Uint8Array,
  nodeId: string,
  before = 2,
  after = 2,
  options: AgentBatchOptions = {},
): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const { document } = pkg
  const quality = await legibilityForPackage(pkg)
  const located = locateNode(document, nodeId)
  const maximumCharacters = clampInteger(options.maximumCharacters ?? 900, 120, 4000)
  const mode = options.mode || 'compact'
  return {
    document: { id: document.documentId, revision: document.revision, title: document.title },
    anchor: compactNode(document, located, maximumCharacters, mode, quality.byPage),
    context: contextNodes(
      document,
      located.block.id,
      clampInteger(before, 0, 10),
      clampInteger(after, 0, 10),
      maximumCharacters,
      mode,
      quality.byPage,
    ),
  }
}

export async function andocCite(input: string | Uint8Array, nodeId: string): Promise<AgentCitation> {
  const pkg = await readAgentAndoc(input)
  if (nodeId.startsWith('source-page-')) {
    const page = Number.parseInt(nodeId.slice('source-page-'.length), 10)
    if (!Number.isInteger(page) || page < 1) throw new Error(`Invalid source-page citation ID: ${nodeId}`)
    const quality = await legibilityForPackage(pkg)
    return sourcePageCitationFor(pkg, page, quality.byPage)
  }
  if (nodeId.startsWith('relationship-')) {
    return relationshipCitation(pkg.document, relationshipById(pkg.document, nodeId))
  }
  if (nodeId.startsWith('shared-')) {
    const group = agentSharedContentIndex(pkg.document).groups.find(candidate => candidate.id === nodeId)
    if (group) return sharedContentCitation(pkg.document, group)
  }
  if (nodeId.startsWith('region-')) {
    const region = captionAssistedRegionEvidence(pkg, { includeParts: true }).regions.find(candidate => candidate.id === nodeId)
    if (region) return regionCitationFor(pkg.document, region)
  }
  const quality = await legibilityForPackage(pkg)
  return citationFor(pkg.document, nodeId, quality.byPage)
}

export async function andocPreview(
  input: string | Uint8Array,
  operations: AndocOperation[],
  options: AgentTransactionOptions = {},
): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  const transaction = agentTransaction(pkg, operations, options)
  const preview = previewTransaction(pkg.document, transaction)
  return {
    documentId: pkg.document.documentId,
    baseRevision: transaction.baseRevision,
    resultingRevision: preview.document.revision,
    transactionId: transaction.id,
    actor: transaction.actor,
    message: transaction.message || null,
    changes: preview.changes,
    inverseOperationCount: preview.inverseOperations.length,
    ...(options.includeInverse ? { inverseOperations: preview.inverseOperations } : {}),
  }
}

export async function andocApply(
  inputPath: string,
  operations: AndocOperation[],
  options: AgentTransactionOptions & { outputPath?: string } = {},
): Promise<Record<string, unknown>> {
  const resolvedInputPath = path.resolve(inputPath)
  const outputPath = path.resolve(options.outputPath || inputPath)
  return withDocumentLocks([resolvedInputPath, outputPath], async () => {
    const pkg = await readAndoc(resolvedInputPath)
    const transaction = agentTransaction(pkg, operations, options)
    const preview = previewTransaction(pkg.document, transaction)
    const result = await transactAndocPackage(pkg, transaction)
    await atomicWrite(outputPath, result.packageBytes)
    packageCache.delete(outputPath)
    return {
      ok: true,
      documentId: result.document.documentId,
      outputPath,
      baseRevision: transaction.baseRevision,
      revision: result.document.revision,
      transactionId: transaction.id,
      changes: preview.changes,
      inverseOperationCount: preview.inverseOperations.length,
      ...(options.includeInverse ? { inverseOperations: preview.inverseOperations } : {}),
    }
  })
}

export async function andocReviewStatus(input: string | Uint8Array): Promise<Record<string, unknown>> {
  const pkg = await readAgentAndoc(input)
  return reviewSummary(pkg.document)
}

export async function andocReviewPropose(
  inputPath: string,
  operations: AndocOperation[],
  options: AgentTransactionOptions & { outputPath?: string } = {},
): Promise<Record<string, unknown>> {
  const resolvedInputPath = path.resolve(inputPath)
  const outputPath = path.resolve(options.outputPath || inputPath)
  return withDocumentLocks([resolvedInputPath, outputPath], async () => {
    const pkg = await readAndoc(resolvedInputPath)
    const baseRevision = options.baseRevision ?? pkg.document.revision
    if (baseRevision !== pkg.document.revision) throw new RevisionConflictError(pkg.document.revision, baseRevision)
    const transaction = addReviewProposalTransaction(pkg.document, {
      operations,
      message: options.message || 'Agent-proposed document change',
    }, {
      actor: { type: 'agent', id: options.actorId || 'andoc-agent' },
      message: options.message,
    })
    const preview = previewTransaction(pkg.document, transaction)
    const result = await transactAndocPackage(pkg, transaction)
    await atomicWrite(outputPath, result.packageBytes)
    packageCache.delete(outputPath)
    const summary = reviewSummary(result.document)
    const proposal = (summary.state as { proposals: Array<{ id: string }> }).proposals.at(-1)
    return {
      ok: true,
      documentId: result.document.documentId,
      outputPath,
      baseRevision,
      revision: result.document.revision,
      transactionId: transaction.id,
      proposalId: proposal?.id || null,
      changes: preview.changes,
      review: summary,
      canonicalContentChanged: false,
    }
  })
}

export async function andocInsertImage(
  inputPath: string,
  imagePath: string,
  alt: string,
  options: AgentTransactionOptions & { afterId?: string | null; replaceBlockId?: string; outputPath?: string } = {},
): Promise<Record<string, unknown>> {
  if (!alt.trim()) throw new Error('Alternative text is required for image insertion')
  const imageBytes = new Uint8Array(await readFile(imagePath))
  const mediaType = imageMediaType(imagePath, imageBytes)
  const resolvedInputPath = path.resolve(inputPath)
  const outputPath = path.resolve(options.outputPath || inputPath)
  return withDocumentLocks([resolvedInputPath, outputPath], async () => {
    const pkg = await readAndoc(resolvedInputPath)
    const candidateAsset = createImageAsset(imageBytes, { mediaType, originalName: path.basename(imagePath), description: alt.trim() })
    const asset = Object.values(pkg.document.assets).find(existing => existing.sha256 === candidateAsset.sha256 && existing.mediaType === candidateAsset.mediaType) || candidateAsset
    const actorId = options.actorId || 'andoc-agent'
    const timestamp = new Date().toISOString()
    const provenance: Provenance = { kind: 'agent', sourceId: actorId, capturedAt: timestamp }
    const operations: AndocOperation[] = pkg.document.assets[asset.id] ? [] : [{ op: 'addAsset', asset }]
    if (options.replaceBlockId) {
      const current = pkg.document.blocks.find(block => block.id === options.replaceBlockId)
      if (current?.type !== 'image') throw new Error(`Block is not an image: ${options.replaceBlockId}`)
      const sourceProvenance = current.attrs?.sourceProvenance || current.provenance
      operations.push({
        op: 'replaceBlock',
        targetId: current.id,
        block: {
          ...structuredClone(current),
          assetId: asset.id,
          alt: alt.trim(),
          provenance,
          attrs: {
            ...(current.attrs || {}),
            ...(sourceProvenance ? { sourceProvenance: structuredClone(sourceProvenance) } : {}),
            lastEditedBy: actorId,
            lastEditedAt: timestamp,
          },
        },
      })
    } else {
      operations.push({
        op: 'insertBlocks',
        afterId: options.afterId === undefined ? pkg.document.blocks.at(-1)?.id || null : options.afterId,
        blocks: [{
          id: `image-agent-${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          type: 'image',
          assetId: asset.id,
          alt: alt.trim(),
          provenance,
        }],
      })
    }
    const transaction = agentTransaction(pkg, operations, {
      actorId,
      baseRevision: options.baseRevision,
      message: options.message || (options.replaceBlockId ? `Agent replaced image ${options.replaceBlockId}` : `Agent inserted image ${path.basename(imagePath)}`),
    }, timestamp)
    const preview = previewTransaction(pkg.document, transaction)
    const result = await transactAndocPackage(pkg, transaction, pkg.document.assets[asset.id] ? {} : { [asset.id]: imageBytes })
    await atomicWrite(outputPath, result.packageBytes)
    packageCache.delete(outputPath)
    return {
      ok: true,
      documentId: result.document.documentId,
      outputPath,
      baseRevision: transaction.baseRevision,
      revision: result.document.revision,
      transactionId: transaction.id,
      asset,
      changes: preview.changes,
      inverseOperationCount: preview.inverseOperations.length,
      ...(options.includeInverse ? { inverseOperations: preview.inverseOperations } : {}),
    }
  })
}

export async function andocExportPdf(inputPath: string, outputPath: string): Promise<Record<string, unknown>> {
  const result = await exportAndocPdf(inputPath)
  const resolved = path.resolve(outputPath)
  await atomicWrite(resolved, result.bytes)
  return { ok: true, outputPath: resolved, revision: result.revision, pages: result.pageCount }
}

async function readAgentAndoc(input: string | Uint8Array): Promise<AndocPackage> {
  if (typeof input !== 'string') return readAndoc(input)
  const resolved = path.resolve(input)
  const metadata = await stat(resolved)
  const fingerprint = `${metadata.size}:${metadata.mtimeMs}`
  const cached = packageCache.get(resolved)
  if (cached?.fingerprint === fingerprint) {
    packageCache.delete(resolved)
    packageCache.set(resolved, cached)
    return cached.pkg
  }
  const pkg = await readAndoc(resolved)
  packageCache.set(resolved, { fingerprint, pkg })
  while (packageCache.size > maximumCachedPackages) {
    const oldest = packageCache.keys().next().value as string | undefined
    if (!oldest) break
    packageCache.delete(oldest)
  }
  return pkg
}

async function legibilityForPackage(pkg: AndocPackage): Promise<{
  report: Awaited<ReturnType<typeof packagePdfTextQuality>>
  byPage: Map<number, PdfTextLegibilityState>
}> {
  const report = await packagePdfTextQuality(pkg)
  const importer = pkg.document.metadata.importer as Record<string, unknown> | undefined
  const ocrApplied = importer?.ocrRequested === true
  return {
    report,
    byPage: new Map((report?.pages || []).map(page => [page.page, pdfTextLegibilityState(page, ocrApplied)])),
  }
}

function rankNodes(document: AndocDocument, query: string): RankedNode[] {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) throw new Error('Search query cannot be empty')
  const terms = meaningfulTerms(normalizedQuery)
  const numericIntent = /\b(?:how many|how much|compare|versus|change|rate|percent|percentage)\b/u.test(normalizedQuery)
  const ranked: RankedNode[] = []
  for (const block of document.blocks) {
    for (const candidate of searchableNodes(block)) {
      const normalizedText = normalizeSearchText(candidate.text)
      const exactIndex = normalizedText.indexOf(normalizedQuery)
      const textTerms = new Set(searchTerms(normalizedText))
      const matchedTerms = terms.filter(term => textTerms.has(term) || normalizedText.includes(term))
      if (exactIndex < 0 && !matchedTerms.length) continue
      const coverage = matchedTerms.length / Math.max(1, terms.length)
      const numericDensity = numericIntent
        ? Math.min(400, (normalizedText.match(/\b\d+(?:[.,]\d+)*(?:%|\s+percent)?\b/gu) || []).length * 30)
        : 0
      const score = (exactIndex >= 0 ? 10_000 + normalizedQuery.length : 0)
        + Math.round(coverage * 1000)
        + matchedTerms.length * 20
        + numericDensity
        + (candidate.nodeId === block.id ? 1 : 0)
      ranked.push({
        block,
        ...(candidate.cell ? { cell: candidate.cell } : {}),
        nodeId: candidate.nodeId,
        text: candidate.text,
        score,
        matchText: exactIndex >= 0 ? normalizedQuery : longestTerm(matchedTerms),
        normalizedText,
      })
    }
  }
  return ranked.sort((left, right) => right.score - left.score || document.blocks.indexOf(left.block) - document.blocks.indexOf(right.block))
}

function meaningfulTerms(query: string): string[] {
  const stopWords = new Set([
    'about', 'after', 'also', 'and', 'are', 'can', 'did', 'does', 'for', 'from', 'had', 'has', 'have',
    'how', 'into', 'its', 'may', 'not', 'of', 'on', 'or', 'that', 'the', 'their', 'then', 'this', 'to',
    'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'would',
  ])
  const terms = query.split(/[^\p{L}\p{N}.$%]+/u)
    .map(term => term.trim())
    .filter(term => term && !stopWords.has(term) && (term.length > 2 || /\d/u.test(term)))
    .map(searchStem)
  return [...new Set(terms)]
}

function searchTerms(value: string): string[] {
  return value.split(/[^\p{L}\p{N}.$%]+/u).filter(Boolean).map(searchStem)
}

function searchStem(value: string): string {
  if (/\d/u.test(value)) return value
  if (value.length > 5 && value.endsWith('ies')) return `${value.slice(0, -3)}y`
  if (value.length > 5 && value.endsWith('ing')) return value.slice(0, -3)
  if (value.length > 4 && value.endsWith('es')) return value.slice(0, -2)
  if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1)
  return value
}

function selectQueryMatches(
  ranked: RankedNode[],
  query: string,
  limit: number,
  sharedByNode: Map<string, AnxSharedContentGroup> = new Map(),
): RankedNode[] {
  const selected: RankedNode[] = []
  const seen = new Set<string>()
  const seenShared = new Set<string>()
  const labelledAnchors = [...normalizeSearchText(query).matchAll(/\b([\p{L}][\p{L}\p{N}]{1,12})\s*[-:]?\s*(\d+(?:[.,]\d+)*)\b/gu)]
    .map(match => `${match[1]} ${match[2]}`)
  for (const anchor of [...new Set(labelledAnchors)]) {
    const candidate = ranked
      .filter(item => {
        const shared = sharedByNode.get(item.nodeId)
        return anchorComparableText(item.normalizedText).includes(anchor)
          && !seen.has(item.nodeId)
          && (!shared || !seenShared.has(shared.id))
      })
      .sort((left, right) => {
        const leftText = anchorComparableText(left.normalizedText)
        const rightText = anchorComparableText(right.normalizedText)
        return leftText.indexOf(anchor) - rightText.indexOf(anchor) || leftText.length - rightText.length || right.score - left.score
      })[0]
    if (!candidate) continue
    selected.push(candidate)
    seen.add(candidate.nodeId)
    const shared = sharedByNode.get(candidate.nodeId)
    if (shared) seenShared.add(shared.id)
    if (selected.length >= limit) return selected
  }
  for (const candidate of ranked) {
    if (seen.has(candidate.nodeId)) continue
    const shared = sharedByNode.get(candidate.nodeId)
    if (shared && seenShared.has(shared.id)) continue
    selected.push(candidate)
    seen.add(candidate.nodeId)
    if (shared) seenShared.add(shared.id)
    if (selected.length >= limit) break
  }
  return selected
}

function sharedGroupByNode(document: AndocDocument): Map<string, AnxSharedContentGroup> {
  const result = new Map<string, AnxSharedContentGroup>()
  for (const group of agentSharedContentIndex(document, { expandOccurrences: true }).groups) {
    for (const occurrence of group.occurrences || []) {
      if (occurrence.nodeId) result.set(occurrence.nodeId, group)
    }
  }
  return result
}

function compactSharedGroup(document: AndocDocument, group: AnxSharedContentGroup): Record<string, unknown> {
  const { occurrences: _occurrences, ...compact } = group
  return {
    ...compact,
    citation: sharedContentCitation(document, group),
    expansion: { tool: 'andoc_shared_content', sharedContentId: group.id, expandOccurrences: true },
  }
}

function sharedContentAgentUse(
  group: AnxSharedContentGroup,
  qualityByPage: Map<number, PdfTextLegibilityState>,
): Record<string, unknown> {
  const pages = [...new Set((group.occurrences || []).map(occurrence => occurrence.page))]
  const states = [...new Set(pages.map(page => qualityByPage.get(page) || 'unverified'))]
  const reviewRequired = states.some(state => state === 'native-suspect' || state === 'unverified')
  return {
    textQualityStates: states,
    reviewRequired,
    instruction: reviewRequired
      ? 'The repetition scope is deterministic, but one or more text occurrences are suspect or unverified. Compare retained source/OCR evidence before relying on the text.'
      : 'Use the shared text once for the disclosed scope; expand only when exact occurrence-level evidence is required.',
  }
}

function anchorComparableText(value: string): string {
  return value.replace(/[-:]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function longestTerm(terms: string[]): string {
  return [...terms].sort((left, right) => right.length - left.length)[0] || ''
}

function evidenceNodes(
  document: AndocDocument,
  candidate: RankedNode,
  maximumCharacters: number,
  mode: AgentResponseMode,
  qualityByPage: Map<number, PdfTextLegibilityState>,
): Array<Record<string, unknown>> {
  if (candidate.block.type === 'table' && candidate.cell) {
    const row = candidate.block.rows.find(cells => cells.some(cell => cell.id === candidate.cell!.id)) || [candidate.cell]
    return row.map(cell => compactNode(document, { block: candidate.block, cell }, maximumCharacters, mode, qualityByPage))
  }
  const primary = compactNode(document, { block: candidate.block, ...(candidate.cell ? { cell: candidate.cell } : {}) }, maximumCharacters, mode, qualityByPage)
  if (!candidate.cell && isLeadIn(candidate.text)) {
    const blockIndex = document.blocks.findIndex(block => block.id === candidate.block.id)
    const continuation = document.blocks.slice(blockIndex + 1).find(block => block.type !== 'pageBreak')
    if (continuation) {
      return [
        { ...primary, evidenceRole: 'lead-in' },
        { ...compactNode(document, { block: continuation }, maximumCharacters, mode, qualityByPage), evidenceRole: 'answer' },
      ]
    }
  }
  return [{ ...primary, evidenceRole: 'answer' }]
}

function isLeadIn(value: string): boolean {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return /(?::|\b(?:include|includes|including|following|as follows))\s*$/iu.test(compact)
}

function contextNodes(
  document: AndocDocument,
  blockId: string,
  before: number,
  after: number,
  maximumCharacters: number,
  mode: AgentResponseMode,
  qualityByPage: Map<number, PdfTextLegibilityState>,
): Array<Record<string, unknown>> {
  const anchorIndex = document.blocks.findIndex(block => block.id === blockId)
  if (anchorIndex < 0) return []
  const start = Math.max(0, anchorIndex - before)
  const end = Math.min(document.blocks.length, anchorIndex + after + 1)
  return document.blocks.slice(start, end)
    .filter(block => block.id !== blockId)
    .map(block => compactNode(document, { block }, maximumCharacters, mode, qualityByPage))
}

function compactNode(
  document: AndocDocument,
  located: { block: AndocBlock; cell?: TableCell },
  maximumCharacters: number,
  mode: AgentResponseMode,
  qualityByPage: Map<number, PdfTextLegibilityState>,
): Record<string, unknown> {
  const nodeId = located.cell?.id || located.block.id
  const citation = citationFor(document, nodeId, qualityByPage)
  const text = located.cell ? runsText(located.cell.content) : blockText(located.block)
  return {
    nodeId,
    blockId: located.block.id,
    type: located.block.type,
    text: shorten(text, maximumCharacters),
    ...(located.block.type === 'heading' ? {
      heading: {
        level: located.block.level,
        ...(typeof located.block.attrs?.sectionNumber === 'string' ? { sectionNumber: located.block.attrs.sectionNumber } : {}),
      },
    } : {}),
    ...(located.block.type === 'footnote' ? {
      note: {
        kind: located.block.noteKind || 'footnote',
        marker: located.block.label,
        anchorIds: located.block.anchorIds || [],
        anchorStatus: located.block.anchorStatus || 'unanchored',
        reviewRequired: located.block.anchorStatus !== 'resolved',
      },
    } : {}),
    citation: mode === 'compact' ? citation.uri : citation,
    textQuality: citation.textQuality,
    ...(citation.page ? { page: citation.page } : {}),
  }
}

function blockText(block: AndocBlock): string {
  if (block.type === 'heading' || block.type === 'paragraph') return runsText(block.content)
  if (block.type === 'list') return listItemsText(block.items)
  if (block.type === 'footnote') return `${block.label} ${runsText(block.content)}`
  if (block.type === 'extension') return runsText(block.fallback)
  if (block.type === 'image') return [block.alt, runsText(block.caption)].filter(Boolean).join(' — ')
  if (block.type === 'chart') return [block.alt, runsText(block.caption), JSON.stringify(block.spec.data || '')].filter(Boolean).join(' — ')
  if (block.type === 'table') {
    const rows = block.rows.map(row => row.map(cell => runsText(cell.content)).join(' | ')).join('\n')
    return [runsText(block.caption), rows].filter(Boolean).join('\n')
  }
  return 'Page break'
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

function agentTransaction(
  pkg: AndocPackage,
  operations: AndocOperation[],
  options: AgentTransactionOptions = {},
  timestamp = new Date().toISOString(),
): AndocTransaction {
  return {
    schema: 'andoc.transaction.v1',
    id: `tx-agent-${randomUUID()}`,
    baseRevision: options.baseRevision ?? pkg.document.revision,
    actor: { type: 'agent', id: options.actorId || 'andoc-agent' },
    timestamp,
    ...(options.message ? { message: options.message } : {}),
    operations: structuredClone(operations),
  }
}

function citationFor(
  document: AndocDocument,
  nodeId: string,
  qualityByPage: Map<number, PdfTextLegibilityState> = new Map(),
): NodeCitation {
  const { block, cell } = locateNode(document, nodeId)
  const provenance = cell?.provenance || block.provenance
  return {
    uri: `anx://${document.documentId}/revisions/${document.revision}/blocks/${encodeURIComponent(block.id)}${cell ? `/cells/${encodeURIComponent(cell.id)}` : ''}`,
    documentId: document.documentId,
    revision: document.revision,
    blockId: block.id,
    nodeId: cell?.id || block.id,
    blockType: block.type,
    textQuality: provenance?.kind && provenance.kind !== 'imported'
      ? 'derived'
      : provenance?.page
        ? qualityByPage.get(provenance.page) || 'unverified'
        : 'unverified',
    ...(provenance?.page ? { page: provenance.page } : {}),
    ...(provenance?.sourceUri ? { sourceUri: provenance.sourceUri } : {}),
    ...(provenance?.bbox ? { bbox: provenance.bbox } : {}),
  }
}

function sourcePageCitationFor(
  pkg: AndocPackage,
  page: number,
  qualityByPage: Map<number, PdfTextLegibilityState> = new Map(),
): SourcePageCitation {
  const sourceEntry = pkg.manifest.entries.find(entry => (
    entry.role === 'source'
    && entry.mediaType === 'application/pdf'
    && entry.path.startsWith('sources/original/')
  ))
  if (!sourceEntry) throw new Error('The ANX package does not retain an original PDF source')
  const pageCount = retainedPageCount(pkg.document)
  if (pageCount && page > pageCount) throw new Error(`Source page ${page} exceeds the retained ${pageCount}-page source`)
  const sourcePageId = `source-page-${page}`
  return {
    uri: `anx://${pkg.document.documentId}/revisions/${pkg.document.revision}/source-pages/${sourcePageId}`,
    documentId: pkg.document.documentId,
    revision: pkg.document.revision,
    sourcePageId,
    evidenceType: 'source-page',
    page,
    sourceUri: sourceEntry.path,
    sourceSha256: sourceEntry.sha256,
    textQuality: qualityByPage.get(page) || 'unverified',
  }
}

function regionCitationFor(document: AndocDocument, region: AnxRegionEvidence): RegionCitation {
  return {
    uri: `anx://${document.documentId}/revisions/${document.revision}/regions/${encodeURIComponent(region.id)}`,
    documentId: document.documentId,
    revision: document.revision,
    regionId: region.id,
    evidenceType: 'region',
    page: region.page,
    kind: region.kind,
    status: region.status,
    unattendedUse: region.unattendedUse,
    bbox: [...region.bbox],
    coordinateOrigin: region.coordinateOrigin,
    source: region.provenance.source,
    ...(region.provenance.sourceSha256 ? { sourceSha256: region.provenance.sourceSha256 } : {}),
  }
}

function regionSourceCitations(
  document: AndocDocument,
  region: AnxRegionEvidence,
  qualityByPage: Map<number, PdfTextLegibilityState>,
): NodeCitation[] {
  const sourceIds = [...new Set([
    ...(region.sourceBlockId ? [region.sourceBlockId] : []),
    ...(region.sourceBlockIds || []),
  ])]
  return sourceIds.flatMap(sourceId => {
    try {
      return [citationFor(document, sourceId, qualityByPage)]
    } catch {
      return []
    }
  })
}

function retainedPageCount(document: AndocDocument, qualityPageCount?: number): number {
  if (qualityPageCount && qualityPageCount > 0) return qualityPageCount
  const layout = document.metadata.layout as { sourcePageSizes?: Record<string, unknown> } | undefined
  const layoutPages = Object.keys(layout?.sourcePageSizes || {}).map(value => Number.parseInt(value, 10)).filter(Number.isInteger)
  const blockPages = document.blocks.map(block => block.provenance?.page || 0)
  const stored = document.metadata.anxRegionEvidence as { regions?: Array<{ page?: unknown }> } | undefined
  const regionPages = Array.isArray(stored?.regions)
    ? stored.regions.map(region => typeof region.page === 'number' ? region.page : 0)
    : []
  return Math.max(0, ...layoutPages, ...blockPages, ...regionPages)
}

function selectPageEvidenceBlocks(
  blocks: AndocBlock[],
  regions: AnxRegionEvidence[],
  maximumBlocks: number,
  query?: string,
): AndocBlock[] {
  if (blocks.length <= maximumBlocks) return blocks
  const queryTerms = query ? meaningfulTerms(normalizeSearchText(query)) : []
  const ranked = blocks.map((block, index) => {
    const text = normalizeSearchText(blockText(block))
    const queryScore = queryTerms.filter(term => text.includes(term)).length
    const overlapsRegion = blockOverlapsRegion(block, regions)
    const priority = queryScore * 10_000
      + (block.type === 'heading' ? 5_000 : 0)
      + (block.type === 'table' ? 4_000 : 0)
      + (overlapsRegion ? 2_000 : 0)
      + (block.type === 'pageBreak' ? -1_000 : 0)
    return { block, index, priority }
  })
  return ranked
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .slice(0, maximumBlocks)
    .sort((left, right) => left.index - right.index)
    .map(item => item.block)
}

function blockOverlapsRegion(block: AndocBlock, regions: AnxRegionEvidence[]): boolean {
  const bbox = block.provenance?.bbox
  const coordinateOrigin = block.attrs && typeof block.attrs.coordinateOrigin === 'string'
    ? block.attrs.coordinateOrigin
    : null
  if (!bbox || !coordinateOrigin) return false
  return regions.some(region => region.coordinateOrigin === coordinateOrigin && boxesOverlap(bbox, region.bbox))
}

function boxesOverlap(
  left: [number, number, number, number],
  right: [number, number, number, number],
): boolean {
  const leftX1 = Math.min(left[0], left[2])
  const leftX2 = Math.max(left[0], left[2])
  const leftY1 = Math.min(left[1], left[3])
  const leftY2 = Math.max(left[1], left[3])
  const rightX1 = Math.min(right[0], right[2])
  const rightX2 = Math.max(right[0], right[2])
  const rightY1 = Math.min(right[1], right[3])
  const rightY2 = Math.max(right[1], right[3])
  return leftX1 <= rightX2 && rightX1 <= leftX2 && leftY1 <= rightY2 && rightY1 <= leftY2
}

function locateNode(document: AndocDocument, nodeId: string): { block: AndocBlock; cell?: TableCell } {
  const direct = document.blocks.find(block => block.id === nodeId)
  if (direct) return { block: direct }
  for (const block of document.blocks) {
    if (block.type !== 'table') continue
    const cell = block.rows.flat().find(candidate => candidate.id === nodeId)
    if (cell) return { block, cell }
  }
  throw new Error(`Node not found: ${nodeId}`)
}

function tableCellEditContext(table: Extract<AndocBlock, { type: 'table' }>, cell: TableCell): Record<string, unknown> {
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    const columnIndex = table.rows[rowIndex]!.findIndex(candidate => candidate.id === cell.id)
    if (columnIndex < 0) continue
    return {
      tableId: table.id,
      rowIndex,
      columnIndex,
      columnValuesAbove: table.rows.slice(0, rowIndex).map(row => runsText(row[columnIndex]?.content)),
      rowValues: table.rows[rowIndex]!.map(candidate => ({ id: candidate.id, text: runsText(candidate.content) })),
    }
  }
  return { tableId: table.id }
}

function editOperationTemplate(block: AndocBlock, cell?: TableCell): Record<string, unknown> {
  if (cell && block.type === 'table') {
    return { op: 'updateTableCell', tableId: block.id, cellId: cell.id, content: [{ text: '<replacement text>' }] }
  }
  if (block.type === 'heading' || block.type === 'paragraph') {
    return { op: 'updateTextBlock', targetId: block.id, content: [{ text: '<replacement text>' }] }
  }
  if (block.type === 'image' || block.type === 'chart') {
    return { op: 'updateMediaMetadata', targetId: block.id, patch: { alt: '<replacement alternative text>' } }
  }
  if (block.type === 'table') {
    return { op: 'replaceBlock', targetId: block.id, block: '<complete replacement table block>' }
  }
  return { op: 'removeBlock', targetId: block.id }
}

function insertAfterTemplate(afterId: string): Record<string, unknown> {
  return {
    op: 'insertBlocks',
    afterId,
    blocks: [{
      id: '<new-stable-id>',
      type: 'paragraph',
      content: [{ text: '<new text>' }],
      provenance: { kind: 'agent', sourceId: '<agent-id>' },
    }],
  }
}

function structuralOperationTemplates(targetId: string): Record<string, unknown> {
  return {
    moveAfter: { op: 'moveBlock', targetId, afterId: '<anchor-block-id>' },
    moveToBeginning: { op: 'moveBlock', targetId, afterId: null },
    remove: { op: 'removeBlock', targetId },
  }
}

function chartDataOperationTemplate(targetId: string): Record<string, unknown> {
  return {
    op: 'updateChartData',
    targetId,
    data: { columns: ['<column name>'], rows: [['<value>']] },
    evidence: { method: 'human-provided', source: '<source description>', verified: true },
  }
}

function searchableNodes(block: AndocBlock): Array<{ nodeId: string; text: string; cell?: TableCell }> {
  if (block.type === 'heading' || block.type === 'paragraph') return [{ nodeId: block.id, text: runsText(block.content) }]
  if (block.type === 'list') return [{ nodeId: block.id, text: listItemsText(block.items) }]
  if (block.type === 'footnote') return [{ nodeId: block.id, text: `${block.label} ${runsText(block.content)}` }]
  if (block.type === 'extension') return [{ nodeId: block.id, text: runsText(block.fallback) }]
  if (block.type === 'image') return [{ nodeId: block.id, text: [block.alt, runsText(block.caption)].filter(Boolean).join(' ') }]
  if (block.type === 'chart') return [{ nodeId: block.id, text: [block.alt, runsText(block.caption), JSON.stringify(block.spec.data || '')].filter(Boolean).join(' ') }]
  if (block.type === 'table') {
    return [
      ...(block.caption?.length ? [{ nodeId: block.id, text: runsText(block.caption) }] : []),
      ...block.rows.flat().map(cell => ({ nodeId: cell.id, text: runsText(cell.content), cell })),
    ]
  }
  return []
}

function summarizeBlock(block: AndocBlock): string {
  if (block.type === 'heading' || block.type === 'paragraph') return shorten(runsText(block.content), 140)
  if (block.type === 'list') return `${block.items.length} ${block.ordered ? 'ordered' : 'unordered'} item(s) — ${shorten(listItemsText(block.items), 110)}`
  if (block.type === 'footnote') return shorten(`${block.label} ${runsText(block.content)}`, 140)
  if (block.type === 'extension') return `${block.extensionId}@${block.version} — ${shorten(runsText(block.fallback), 100)}`
  if (block.type === 'image' || block.type === 'chart') return shorten([block.alt, runsText(block.caption)].filter(Boolean).join(' — '), 140)
  if (block.type === 'table') return `${block.rows.length} row(s) × ${Math.max(0, ...block.rows.map(row => row.length))} column(s)${block.caption?.length ? ` — ${shorten(runsText(block.caption), 100)}` : ''}`
  return 'Page break'
}

function runsText(runs?: Array<{ text: string }>): string {
  return (runs || []).map(run => run.text).join('')
}

function listItemsText(items: Extract<AndocBlock, { type: 'list' }>['items']): string {
  return items.flatMap(item => [runsText(item.content), ...(item.children?.length ? [listItemsText(item.children)] : [])]).filter(Boolean).join('\n')
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

function shorten(value: string, length: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact
}

function excerptFor(value: string, matchText: string, maximum: number): string {
  const compact = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const index = matchText ? compact.toLocaleLowerCase().indexOf(matchText.toLocaleLowerCase()) : -1
  if (index < 0) return shorten(compact, maximum)
  const start = Math.max(0, index - Math.floor((maximum - matchText.length) / 2))
  const end = Math.min(compact.length, start + maximum)
  return `${start ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`
}

function imageMediaType(filePath: string, bytes: Uint8Array): string {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.png' || (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)) return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg' || (bytes[0] === 255 && bytes[1] === 216)) return 'image/jpeg'
  throw new Error('Editable image must be PNG or JPEG')
}

async function atomicWrite(destination: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}
