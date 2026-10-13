#!/usr/bin/env node
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import {
  andocApply,
  andocCite,
  andocContext,
  andocEditLocate,
  andocExportPdf,
  andocGet,
  andocGetBatch,
  andocInsertImage,
  andocOcrCandidates,
  andocOpen,
  andocOutline,
  andocPreview,
  andocQuery,
  andocRegions,
  andocReadAdaptive,
  andocReviewPropose,
  andocReviewStatus,
  andocSearch,
  andocSharedContent,
  andocTextQuality,
  anxPageEvidence,
  anxRelationships,
  anxTableEvidenceBundle,
  inspectAndocCapabilities,
  verifyAndocFinalization,
  verifyAndocLineage,
  verifySourceBaseline,
  type AndocOperation,
  type AndocTrustStore,
} from './index.js'
import { ANX_RELATIONSHIP_TYPES } from './relationships.js'

const allowedRoot = path.resolve(process.env.ANX_ALLOWED_ROOT || process.env.AGN_ALLOWED_ROOT || process.env.ANDOC_ALLOWED_ROOT || process.cwd())
const server = new McpServer({ name: 'anx', version: '0.4.0' })
const documentPathSchema = z.string().min(1).describe('Path to a canonical .anx document (legacy .anxd, .agn, and .andoc documents are also readable) inside the configured workspace')
const actorIdSchema = z.string().min(1).optional().describe('Stable identity for the agent making the change')
const messageSchema = z.string().min(1).optional().describe('Concise audit message explaining the requested change')
const includeInverseSchema = z.boolean().optional().describe('Include full inverse operations; defaults to false to keep agent responses compact')
const baseRevisionSchema = z.number().int().min(0).describe('Expected document revision from the preceding open, locate, query, or preview call; stale plans fail without writing')
const responseModeSchema = z.enum(['compact', 'standard']).optional().describe('Compact returns citation URIs and bounded text; standard includes full citation metadata')
const regionKindSchema = z.enum(['table', 'text', 'note', 'caption', 'figure', 'screenshot', 'visualization', 'simulation', 'infographic', 'roster', 'logo', 'qrCode', 'chart', 'map', 'equation', 'handwriting', 'signature', 'other'])
const relationshipTypeSchema = z.enum(ANX_RELATIONSHIP_TYPES)
const textRunSchema = z.object({
  text: z.string(),
  marks: z.array(z.enum(['bold', 'italic', 'underline', 'strike', 'code', 'subscript', 'superscript'])).optional(),
  href: z.string().optional(),
})
const provenanceSchema = z.object({
  kind: z.enum(['imported', 'human', 'agent', 'generated']),
  sourceId: z.string().optional(),
  sourceUri: z.string().optional(),
  page: z.number().int().min(1).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  capturedAt: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
})
const baseBlockFields = {
  id: z.string().min(1),
  provenance: provenanceSchema.optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
}
const tableCellSchema = z.object({
  id: z.string().min(1),
  content: z.array(textRunSchema),
  header: z.boolean().optional(),
  colspan: z.number().int().min(1).optional(),
  rowspan: z.number().int().min(1).optional(),
  provenance: provenanceSchema.optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
})
const listItemSchema: z.ZodTypeAny = z.lazy(() => z.object({
  id: z.string().min(1),
  content: z.array(textRunSchema),
  children: z.array(listItemSchema).optional(),
  provenance: provenanceSchema.optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
}))
const blockSchema = z.discriminatedUnion('type', [
  z.object({ ...baseBlockFields, type: z.literal('paragraph'), content: z.array(textRunSchema) }),
  z.object({ ...baseBlockFields, type: z.literal('heading'), level: z.number().int().min(1).max(6), content: z.array(textRunSchema) }),
  z.object({ ...baseBlockFields, type: z.literal('list'), ordered: z.boolean(), start: z.number().int().min(1).optional(), items: z.array(listItemSchema).min(1) }),
  z.object({
    ...baseBlockFields,
    type: z.literal('footnote'),
    label: z.string().min(1),
    content: z.array(textRunSchema),
    noteKind: z.enum(['footnote', 'endnote']).optional(),
    anchorIds: z.array(z.string().min(1)).min(1).optional(),
    anchorStatus: z.enum(['resolved', 'uncertain', 'unanchored']).optional(),
  }),
  z.object({ ...baseBlockFields, type: z.literal('extension'), extensionId: z.string().regex(/^andoc\.extension\.[a-z0-9][a-z0-9.-]*$/), version: z.string().regex(/^[0-9]+\.[0-9]+$/), payload: z.record(z.string(), z.unknown()), fallback: z.array(textRunSchema).min(1) }),
  z.object({ ...baseBlockFields, type: z.literal('image'), assetId: z.string().min(1), alt: z.string(), caption: z.array(textRunSchema).optional() }),
  z.object({ ...baseBlockFields, type: z.literal('table'), rows: z.array(z.array(tableCellSchema)), caption: z.array(textRunSchema).optional() }),
  z.object({ ...baseBlockFields, type: z.literal('chart'), alt: z.string(), spec: z.record(z.string(), z.unknown()), dataAssetId: z.string().optional(), fallbackAssetId: z.string().optional(), caption: z.array(textRunSchema).optional() }),
  z.object({ ...baseBlockFields, type: z.literal('pageBreak') }),
])
const assetSchema = z.object({
  id: z.string().min(1),
  packagePath: z.string().startsWith('assets/'),
  mediaType: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0),
  originalName: z.string().optional(),
  description: z.string().optional(),
})
const chartDataSchema = z.object({
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
})
const chartEvidenceSchema = z.object({
  method: z.enum(['imported', 'human-provided', 'agent-provided', 'local-extraction']),
  source: z.string().min(1),
  verified: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  notes: z.string().optional(),
})
const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addAsset'), asset: assetSchema }),
  z.object({ op: z.literal('insertBlocks'), afterId: z.string().min(1).nullable(), blocks: z.array(blockSchema).min(1) }),
  z.object({ op: z.literal('moveBlock'), targetId: z.string().min(1), afterId: z.string().min(1).nullable() }),
  z.object({ op: z.literal('replaceBlock'), targetId: z.string().min(1), block: blockSchema }),
  z.object({ op: z.literal('removeBlock'), targetId: z.string().min(1) }),
  z.object({ op: z.literal('updateTextBlock'), targetId: z.string().min(1), content: z.array(textRunSchema), level: z.number().int().min(1).max(6).optional() }),
  z.object({ op: z.literal('updateTableCell'), tableId: z.string().min(1), cellId: z.string().min(1), content: z.array(textRunSchema) }),
  z.object({ op: z.literal('insertTableRow'), tableId: z.string().min(1), afterRowIndex: z.number().int().min(0).nullable(), cells: z.array(tableCellSchema).min(1) }),
  z.object({ op: z.literal('removeTableRow'), tableId: z.string().min(1), rowIndex: z.number().int().min(0) }),
  z.object({ op: z.literal('insertTableColumn'), tableId: z.string().min(1), afterColumnIndex: z.number().int().min(0).nullable(), cells: z.array(tableCellSchema).min(1) }),
  z.object({ op: z.literal('removeTableColumn'), tableId: z.string().min(1), columnIndex: z.number().int().min(0) }),
  z.object({ op: z.literal('updateMediaMetadata'), targetId: z.string().min(1), patch: z.object({ alt: z.string().optional(), caption: z.array(textRunSchema).optional() }) }),
  z.object({ op: z.literal('updateChartData'), targetId: z.string().min(1), data: chartDataSchema, evidence: chartEvidenceSchema }),
  z.object({ op: z.literal('setDocument'), patch: z.object({ title: z.string().optional(), locale: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional() }) }),
  z.object({ op: z.literal('replaceDocumentMetadata'), metadata: z.record(z.string(), z.unknown()) }),
])
const operationsSchema = z.array(operationSchema).min(1).describe('Typed canonical andoc.transaction.v1 operations; use andoc_edit_locate first to obtain stable node IDs and copy-ready templates')
const trustStoreSchema = z.object({
  schema: z.literal('andoc.trust-store.v1'),
  keys: z.array(z.object({
    keyId: z.string().min(1),
    publicKeySha256: z.string().regex(/^[a-f0-9]{64}$/),
    roles: z.array(z.string().min(1)).optional(),
  })),
})

server.registerTool('andoc_open', {
  description: 'Open and validate an ANX package and warm the persistent process cache. Legacy .agn and .andoc packages remain readable.',
  inputSchema: { documentPath: documentPathSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath }) => toolResult(await andocOpen(allowedDocumentPath(documentPath))))

server.registerTool('andoc_capabilities', {
  description: 'Inspect the document core profile, domain profiles, optional extensions, template reference, support state, and whether the package is finalized without loading document content.',
  inputSchema: { documentPath: documentPathSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath }) => toolResult(await inspectAndocCapabilities(allowedDocumentPath(documentPath))))

server.registerTool('andoc_verify_final', {
  description: 'Cryptographically verify the protected document, history, human view, profile declaration, Ed25519 signatures, approval threshold, signer roles, optional trust store, and external receipt state. This tool never receives private keys.',
  inputSchema: { documentPath: documentPathSchema, trustStore: trustStoreSchema.optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, trustStore }) => toolResult(await verifyAndocFinalization(
  allowedDocumentPath(documentPath),
  trustStore as AndocTrustStore | undefined,
)))

server.registerTool('andoc_verify_lineage', {
  description: 'Verify that a derived draft embeds the exact finalized parent package named by its structured lineage record, and verify the parent finalization and optional trust policy. This tool never receives private keys.',
  inputSchema: { documentPath: documentPathSchema, trustStore: trustStoreSchema.optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, trustStore }) => toolResult(await verifyAndocLineage(
  allowedDocumentPath(documentPath),
  trustStore as AndocTrustStore | undefined,
)))

server.registerTool('andoc_verify_source_baseline', {
  description: 'Verify whether the exact retained source bytes were signed as an organization-designated baseline. This distinguishes a registered baseline from an unverified import and never claims issuer authenticity or originality.',
  inputSchema: { documentPath: documentPathSchema, trustStore: trustStoreSchema.optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, trustStore }) => toolResult(await verifySourceBaseline(
  allowedDocumentPath(documentPath),
  trustStore as AndocTrustStore | undefined,
)))

server.registerTool('andoc_query', {
  description: 'Preferred answer-ready retrieval tool. Rank exact and keyword matches, return bounded row-aware evidence, neighboring context, stable node IDs, and exact citations in one call.',
  inputSchema: {
    documentPath: documentPathSchema,
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).optional(),
    contextBefore: z.number().int().min(0).max(5).optional(),
    contextAfter: z.number().int().min(0).max(5).optional(),
    maximumCharacters: z.number().int().min(120).max(4000).optional(),
    mode: responseModeSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, query, limit, contextBefore, contextAfter, maximumCharacters, mode }) => toolResult(await andocQuery(
  allowedDocumentPath(documentPath),
  query,
  { limit, contextBefore, contextAfter, maximumCharacters, mode },
)))

server.registerTool('andoc_read', {
  description: 'Adaptive document read. Return a lossless structured projection with stable node IDs and recurring boilerplate stored once with page scope when it fits the requested token budget; otherwise return bounded query evidence or an outline that directs the next query.',
  inputSchema: {
    documentPath: documentPathSchema,
    query: z.string().min(1).optional().describe('Focused question used only when the full canonical document exceeds the token budget.'),
    maximumTokens: z.number().int().min(512).max(100000).optional().describe('Approximate response budget; defaults to 8000 tokens.'),
    estimatedCharactersPerToken: z.number().min(2).max(8).optional().describe('Budget conversion factor; defaults to 4 characters per token.'),
    mode: responseModeSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, query, maximumTokens, estimatedCharactersPerToken, mode }) => toolResult(await andocReadAdaptive(
  allowedDocumentPath(documentPath),
  { query, maximumTokens, estimatedCharactersPerToken, mode },
)))

server.registerTool('andoc_shared_content', {
  description: 'Inspect recurring disclaimers, headers, footers, notices, and other exact repeated text as one shared content group with page scope. Expand only when exact occurrence-level node citations and geometry are needed. Near-matches are never merged.',
  inputSchema: {
    documentPath: documentPathSchema,
    sharedContentId: z.string().min(1).optional().describe('Optional shared-content ID returned by andoc_read, andoc_outline, andoc_query'),
    expandOccurrences: z.boolean().optional().describe('Return every exact page/node/source occurrence; defaults to a token-efficient compact scope'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, sharedContentId, expandOccurrences }) => toolResult(await andocSharedContent(
  allowedDocumentPath(documentPath),
  sharedContentId,
  expandOccurrences === true,
)))

server.registerTool('andoc_edit_locate', {
  description: 'Preferred edit-target locator. Search exact current text or metadata and return stable node IDs, revision-pinned citations, table coordinates and headers, plus copy-ready canonical transaction templates.',
  inputSchema: {
    documentPath: documentPathSchema,
    query: z.string().min(1).describe('Distinctive exact text, cell value, caption, or alt text currently present in the document'),
    limit: z.number().int().min(1).max(25).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, query, limit }) => toolResult(await andocEditLocate(
  allowedDocumentPath(documentPath),
  query,
  limit,
)))

server.registerTool('andoc_get_batch', {
  description: 'Retrieve up to 50 stable blocks or table cells in one compact call with bounded text and exact revision-pinned citations.',
  inputSchema: {
    documentPath: documentPathSchema,
    nodeIds: z.array(z.string().min(1)).min(1).max(50),
    maximumCharacters: z.number().int().min(120).max(4000).optional(),
    mode: responseModeSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, nodeIds, maximumCharacters, mode }) => toolResult(await andocGetBatch(
  allowedDocumentPath(documentPath),
  nodeIds,
  { maximumCharacters, mode },
)))

server.registerTool('andoc_context', {
  description: 'Retrieve one stable anchor plus a bounded window of neighboring canonical blocks, with exact citations and compact text.',
  inputSchema: {
    documentPath: documentPathSchema,
    nodeId: z.string().min(1),
    before: z.number().int().min(0).max(10).optional(),
    after: z.number().int().min(0).max(10).optional(),
    maximumCharacters: z.number().int().min(120).max(4000).optional(),
    mode: responseModeSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, nodeId, before, after, maximumCharacters, mode }) => toolResult(await andocContext(
  allowedDocumentPath(documentPath),
  nodeId,
  before,
  after,
  { maximumCharacters, mode },
)))

server.registerTool('andoc_outline', {
  description: 'Return a compact ordered block map with stable IDs, short summaries, source pages, and revision-pinned ANX citations. Start here instead of reading the full document.',
  inputSchema: { documentPath: documentPathSchema, maximumBlocks: z.number().int().min(1).max(1000).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, maximumBlocks }) => toolResult(await andocOutline(allowedDocumentPath(documentPath), maximumBlocks)))

server.registerTool('andoc_get', {
  description: 'Read one canonical block or table cell by stable node ID, including its revision-pinned citation and source provenance.',
  inputSchema: { documentPath: documentPathSchema, nodeId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, nodeId }) => toolResult(await andocGet(allowedDocumentPath(documentPath), nodeId)))

server.registerTool('andoc_search', {
  description: 'Search canonical text, table cells, captions, alt text, and structured chart data without loading the whole document. Returns compact excerpts and stable citations.',
  inputSchema: { documentPath: documentPathSchema, query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, query, limit }) => toolResult(await andocSearch(allowedDocumentPath(documentPath), query, limit)))

server.registerTool('anx_relationships', {
  description: 'Read revision-bound internal and external document relationships, target availability, authority, resolution state, and assertion citations. This tool does not retrieve or verify unavailable target content.',
  inputSchema: {
    documentPath: documentPathSchema,
    types: z.array(relationshipTypeSchema).min(1).optional(),
    includeRemoved: z.boolean().optional(),
    limit: z.number().int().min(1).max(250).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, types, includeRemoved, limit }) => toolResult(await anxRelationships(
  allowedDocumentPath(documentPath),
  { types, includeRemoved, limit },
)))

server.registerTool('andoc_cite', {
  description: 'Resolve a stable block or table-cell ID to a revision-pinned anx:// citation plus original PDF page, source URI, and bounding box when available.',
  inputSchema: { documentPath: documentPathSchema, nodeId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, nodeId }) => toolResult(await andocCite(allowedDocumentPath(documentPath), nodeId)))

server.registerTool('andoc_text_quality', {
  description: 'Diagnose retained PDF pages using deterministic font-dictionary and native-text plausibility tiers. Return OCR/review candidates with reasons, font risks, and source provenance without invoking OCR or a model.',
  inputSchema: {
    documentPath: documentPathSchema,
    includeCleanPages: z.boolean().optional().describe('Include clean-native and blank pages; defaults to only pages that require OCR or comparison.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, includeCleanPages }) => toolResult(await andocTextQuality(
  allowedDocumentPath(documentPath),
  includeCleanPages,
)))

server.registerTool('andoc_regions', {
  description: 'Return typed, source-bound semantic page objects for tables, missing-text recovery, linked footnotes/endnotes, captions, figures, visualizations, infographics, rosters, logos, QR codes, charts, maps, equations, handwriting, and signatures. Text recovery regions disclose whether a human transcription exists; geometry-only text remains review-required. Notes expose subtype and anchor status; only deterministically resolved note links are unattended-safe. Captions retain their own geometry while their canonical text remains attached to the parent object. Legacy simulation regions remain queryable, while new importers emit visualization with a simulation subtype. Source-image parts are omitted by default to prevent duplicate evidence; request includeParts only for component-level geometry.',
  inputSchema: {
    documentPath: documentPathSchema,
    page: z.number().int().min(1).optional().describe('Return only regions on this 1-based source page.'),
    kinds: z.array(regionKindSchema).min(1).optional().describe('Return only the requested page-object, text-recovery, note, or caption region kinds.'),
    includeParts: z.boolean().optional().describe('Include evidence-only source parts, backgrounds, and decorations. Defaults to false.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, page, kinds, includeParts }) => toolResult(await andocRegions(
  allowedDocumentPath(documentPath),
  { ...(page ? { page } : {}), ...(kinds?.length ? { kinds } : {}), ...(includeParts ? { includeParts: true } : {}) },
)))

server.registerTool('anx_page_evidence', {
  description: 'Preferred typed page-reading tool for mixed text and visual evidence. Returns bounded canonical blocks, semantic regions, independently resolvable anx:// region citations, source hashes, evidence status, provenance, and review guidance in one read-only call.',
  inputSchema: {
    documentPath: documentPathSchema,
    page: z.number().int().min(1).describe('Required 1-based retained source page.'),
    query: z.string().min(1).optional().describe('Optional focus used to prioritize matching canonical blocks within the page response budget.'),
    kinds: z.array(regionKindSchema).min(1).optional().describe('Optionally return only the requested page-object, text-recovery, note, or caption region kinds.'),
    includeParts: z.boolean().optional().describe('Include evidence-only source parts, backgrounds, and decorations. Defaults to false.'),
    maximumBlocks: z.number().int().min(1).max(250).optional().describe('Maximum canonical blocks returned for this page; defaults to 32 with evidence-priority selection.'),
    maximumCharacters: z.number().int().min(120).max(4000).optional().describe('Maximum text characters returned per canonical block; defaults to 700.'),
    mode: responseModeSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, page, query, kinds, includeParts, maximumBlocks, maximumCharacters, mode }) => toolResult(await anxPageEvidence(
  allowedDocumentPath(documentPath),
  page,
  { query, kinds, includeParts, maximumBlocks, maximumCharacters, mode },
)))

server.registerTool('anx_table_evidence', {
  description: 'Return answer-ready table dimensions, evidence state, unattended-use decision, citations, provenance, and linked notes/captions in one bounded read-only call. Return only the citations used; ANX attaches the machine evidence envelope after model generation.',
  inputSchema: {
    documentPath: documentPathSchema,
    page: z.number().int().min(1),
    query: z.string().min(1).optional(),
    tableRegionId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(8).optional(),
    maximumDescriptionCharacters: z.number().int().min(120).max(1200).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, page, query, tableRegionId, limit, maximumDescriptionCharacters }) => toolResult(await anxTableEvidenceBundle(
  allowedDocumentPath(documentPath),
  page,
  {
    query,
    tableRegionId,
    limit,
    maximumDescriptionCharacters,
    includeResponseEvidence: false,
  },
)))

server.registerTool('andoc_ocr_candidates', {
  description: 'Generate non-destructive OCR text candidates for retained PDF pages of an existing ANX package: no re-import, no canonical change. Select explicit pages, router-selected pages (default), or every page as a verification compare. Returns a per-page agentRead decision with a preferred evidence source, source/candidate hash, numeric-disagreement review requirement, and explicit abstention when neither candidate is safe. Preserves engine and model hashes, line geometry, confidence, runtime, and deterministic selection reasoning. Promotion of a reviewed candidate is a separate explicit applyTextCandidate operation via andoc_preview/andoc_apply.',
  inputSchema: {
    documentPath: documentPathSchema,
    pages: z.string().optional().describe('Comma-separated 1-based page list; omit to use router-selected pages'),
    mode: z.enum(['router', 'all']).optional().describe("Selection mode when no explicit pages are given; 'all' forces a verification compare on every page"),
    includeText: z.boolean().optional().describe('Include candidate text and line geometry for up to textPageLimit pages; defaults to false to keep agent responses compact'),
    textPageLimit: z.number().int().min(1).max(20).optional().describe('Maximum pages whose text is inlined when includeText is true; defaults to 5'),
    dpi: z.number().int().min(72).max(400).optional().describe('Render DPI override; defaults to the pinned OCR policy DPI'),
    pageBatchSize: z.number().int().min(1).max(32).optional().describe('Maximum pages per OCR worker process; defaults to 4 to bound peak memory'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, pages, mode, includeText, textPageLimit, dpi, pageBatchSize }) => toolResult(await andocOcrCandidates(allowedDocumentPath(documentPath), {
  ...(pages ? { pages: pages.split(',').map(value => Number(value.trim())) } : {}),
  ...(mode ? { mode } : {}),
  ...(includeText !== undefined ? { includeText } : {}),
  ...(textPageLimit !== undefined ? { textPageLimit } : {}),
  ...(dpi !== undefined ? { dpi } : {}),
  ...(pageBatchSize !== undefined ? { pageBatchSize } : {}),
})))

server.registerTool('andoc_preview', {
  description: 'Validate one atomic batch of canonical operations against an explicit expected revision and return a concise change set plus inverse operations without writing the document.',
  inputSchema: { documentPath: documentPathSchema, baseRevision: baseRevisionSchema, operations: operationsSchema, actorId: actorIdSchema, message: messageSchema, includeInverse: includeInverseSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, baseRevision, operations, actorId, message, includeInverse }) => toolResult(await andocPreview(
  allowedDocumentPath(documentPath),
  operations as AndocOperation[],
  { actorId, message, includeInverse, baseRevision },
)))

server.registerTool('andoc_apply', {
  description: 'Atomically apply one or more validated canonical operations using an explicit expected revision, document lock, agent identity, audit entry, derived human view update, and inverse operations. A concurrent human or agent winner causes a revision conflict with no write. Use andoc_preview first for material edits.',
  inputSchema: { documentPath: documentPathSchema, baseRevision: baseRevisionSchema, operations: operationsSchema, actorId: actorIdSchema, message: messageSchema, includeInverse: includeInverseSchema, outputPath: z.string().min(1).optional() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ documentPath, baseRevision, operations, actorId, message, includeInverse, outputPath }) => toolResult(await andocApply(
  allowedDocumentPath(documentPath),
  operations as AndocOperation[],
  { actorId, message, includeInverse, baseRevision, ...(outputPath ? { outputPath: allowedDocumentPath(outputPath) } : {}) },
)))

server.registerTool('andoc_review_status', {
  description: 'Read comments, highlights, agent proposals, decisions, and revision approvals embedded in the ANX document without loading all canonical content.',
  inputSchema: { documentPath: documentPathSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath }) => toolResult(await andocReviewStatus(allowedDocumentPath(documentPath))))

server.registerTool('andoc_review_propose', {
  description: 'Store typed canonical operations as a non-destructive agent proposal. Content does not change until a human accepts it; stale targets fail closed at acceptance.',
  inputSchema: { documentPath: documentPathSchema, baseRevision: baseRevisionSchema, operations: operationsSchema, actorId: actorIdSchema, message: z.string().min(1), outputPath: z.string().min(1).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ documentPath, baseRevision, operations, actorId, message, outputPath }) => toolResult(await andocReviewPropose(
  allowedDocumentPath(documentPath),
  operations as AndocOperation[],
  { baseRevision, actorId, message, ...(outputPath ? { outputPath: allowedDocumentPath(outputPath) } : {}) },
)))

server.registerTool('andoc_insert_image', {
  description: 'Atomically add or replace a PNG/JPEG image, content-address its bytes, require accessible alt text, update canonical structure, and record agent provenance.',
  inputSchema: {
    documentPath: documentPathSchema,
    imagePath: z.string().min(1),
    alt: z.string().min(1),
    afterId: z.string().min(1).nullable().optional(),
    replaceBlockId: z.string().min(1).optional(),
    baseRevision: baseRevisionSchema,
    actorId: actorIdSchema,
    message: messageSchema,
    includeInverse: includeInverseSchema,
    outputPath: z.string().min(1).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
}, async ({ documentPath, imagePath, alt, afterId, replaceBlockId, baseRevision, actorId, message, includeInverse, outputPath }) => toolResult(await andocInsertImage(
  allowedDocumentPath(documentPath),
  allowedPath(imagePath),
  alt,
  {
    ...(afterId !== undefined ? { afterId } : {}),
    ...(replaceBlockId ? { replaceBlockId } : {}),
    baseRevision,
    actorId,
    message,
    includeInverse,
    ...(outputPath ? { outputPath: allowedDocumentPath(outputPath) } : {}),
  },
)))

server.registerTool('andoc_export_pdf', {
  description: 'Export the current canonical revision to a deterministic human-readable PDF and report the exact revision rendered.',
  inputSchema: { documentPath: documentPathSchema, outputPath: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, outputPath }) => toolResult(await andocExportPdf(
  allowedDocumentPath(documentPath),
  allowedPath(outputPath, '.pdf'),
)))

function allowedPath(value: string, extension?: string): string {
  const resolved = path.resolve(allowedRoot, value)
  if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) throw new Error(`Path is outside the configured ANX workspace: ${value}`)
  if (extension && path.extname(resolved).toLowerCase() !== extension) throw new Error(`Expected a ${extension} path: ${value}`)
  return resolved
}

function allowedDocumentPath(value: string): string {
  const resolved = allowedPath(value)
  const extension = path.extname(resolved).toLowerCase()
  if (!['.anx', '.anxd', '.agn', '.andoc'].includes(extension)) throw new Error(`Expected a .anx path (legacy .anxd, .agn, and .andoc are also accepted): ${value}`)
  return resolved
}

function toolResult(value: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value }
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent }
}

const transport = new StdioServerTransport()
await server.connect(transport)
