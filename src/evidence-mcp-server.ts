#!/usr/bin/env node
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { andocCite, anxRelationships } from './agent-tools.js'
import { appendAnxEvidenceTrace } from './agent-evidence-trace.js'
import {
  ANX_COMPACT_SEARCH_DEFAULT_LIMIT,
  anxCompactPageEvidence,
  anxCompactSearch,
  anxTableEvidenceBundle,
  anxTableEvidenceModelView,
} from './agent-evidence-compact.js'
import {
  anxEvidenceToolEnabled,
  configuredAnxEvidenceToolProfile,
} from './evidence-tool-profile.js'
import { ANX_RELATIONSHIP_TYPES } from './relationships.js'

const allowedRoot = path.resolve(process.env.ANX_ALLOWED_ROOT || process.cwd())
const evidenceTracePath = configuredEvidenceTracePath()
const toolProfile = configuredAnxEvidenceToolProfile()
const compactTableTransport = toolProfile === 'table-answer'
const server = new McpServer({ name: 'anx-evidence', version: '0.4.0' })
const documentPathSchema = z.string().min(1)
  .describe('Path to a canonical .anx document inside the configured read-only workspace')
const regionKindSchema = z.enum([
  'table',
  'text',
  'note',
  'caption',
  'figure',
  'screenshot',
  'visualization',
  'simulation',
  'infographic',
  'roster',
  'logo',
  'qrCode',
  'chart',
  'map',
  'equation',
  'handwriting',
  'signature',
  'other',
])
const responseModeSchema = z.enum(['compact', 'standard']).optional()
  .describe('Compact bounds canonical text while retaining structured region citations; standard expands block citation metadata')
const relationshipTypeSchema = z.enum(ANX_RELATIONSHIP_TYPES)

if (anxEvidenceToolEnabled(toolProfile, 'anx_search')) server.registerTool('anx_search', {
  description: 'Search canonical ANX text, table cells, captions, alt text, and structured chart data. Defaults to five ranked excerpts with stable citations. Start with one focused search; narrow or expand only when the returned evidence is insufficient.',
  inputSchema: {
    documentPath: documentPathSchema,
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, query, limit }) => tracedToolResult('anx_search', await anxCompactSearch(
  allowedDocumentPath(documentPath),
  query,
  limit ?? ANX_COMPACT_SEARCH_DEFAULT_LIMIT,
)))

if (anxEvidenceToolEnabled(toolProfile, 'anx_page_evidence')) server.registerTool('anx_page_evidence', {
  description: 'Read one retained source page as bounded canonical text plus typed semantic regions. Compact mode is the default and retains citations, source hashes, provenance, status, and unattended-use decisions. Use standard mode only for exact geometry or complete structured data.',
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
}, async ({ documentPath, page, query, kinds, includeParts, maximumBlocks, maximumCharacters, mode }) => tracedToolResult('anx_page_evidence', await anxCompactPageEvidence(
  allowedDocumentPath(documentPath),
  page,
  { query, kinds, includeParts, maximumBlocks, maximumCharacters, mode },
)))

if (anxEvidenceToolEnabled(toolProfile, 'anx_table_evidence')) server.registerTool('anx_table_evidence', {
  description: compactTableTransport
    ? 'Read one table as answer-ready, citation-bound evidence with dimensions, safety state, and linked notes or captions.'
    : 'Answer-ready table evidence in one bounded read-only call: dimensions, evidence and unattended-use state, revision-pinned table/source citations, provenance, and linked notes or captions. ANX records the successful tool result and attaches the machine citation and evidence envelope after model generation.',
  inputSchema: {
    documentPath: compactTableTransport
      ? z.string().min(1)
      : documentPathSchema,
    page: compactTableTransport
      ? z.number().int().min(1)
      : z.number().int().min(1).describe('Required 1-based retained source page containing the table.'),
    query: compactTableTransport
      ? z.string().min(1).optional()
      : z.string().min(1).optional().describe('Optional table name, number, or phrase used for deterministic ranking when a page has multiple tables.'),
    tableRegionId: compactTableTransport
      ? z.string().min(1).optional()
      : z.string().min(1).optional().describe('Optional stable table region ID for exact selection.'),
    limit: compactTableTransport
      ? z.number().int().min(1).max(8).optional()
      : z.number().int().min(1).max(8).optional().describe('Maximum matching tables returned; defaults to 4.'),
    maximumDescriptionCharacters: compactTableTransport
      ? z.number().int().min(120).max(1200).optional()
      : z.number().int().min(120).max(1200).optional().describe('Maximum description characters per table or linked object; defaults to 700.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, page, query, tableRegionId, limit, maximumDescriptionCharacters }) => {
  const bundle = await anxTableEvidenceBundle(
    allowedDocumentPath(documentPath),
    page,
    {
      query,
      tableRegionId,
      limit,
      maximumDescriptionCharacters,
      includeResponseEvidence: false,
    },
  )
  return tracedToolResult(
    'anx_table_evidence',
    bundle,
    compactTableTransport ? anxTableEvidenceModelView(bundle) : bundle,
  )
})

if (anxEvidenceToolEnabled(toolProfile, 'anx_relationships')) server.registerTool('anx_relationships', {
  description: 'Read revision-bound internal and external document relationships, target availability, authority, resolution state, and assertion citations. A relationship does not supply or verify unavailable target content.',
  inputSchema: {
    documentPath: documentPathSchema,
    types: z.array(relationshipTypeSchema).min(1).optional(),
    includeRemoved: z.boolean().optional().describe('Include retained relationship tombstones. Defaults to active relationships only.'),
    limit: z.number().int().min(1).max(250).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, types, includeRemoved, limit }) => tracedToolResult('anx_relationships', await anxRelationships(
  allowedDocumentPath(documentPath),
  { types, includeRemoved, limit },
)))

if (anxEvidenceToolEnabled(toolProfile, 'anx_cite')) server.registerTool('anx_cite', {
  description: 'Resolve a stable canonical node ID or region ID to a revision-pinned anx:// citation with source-page and provenance metadata.',
  inputSchema: {
    documentPath: documentPathSchema,
    evidenceId: z.string().min(1).describe('Stable canonical node ID, table-cell ID, or region ID.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ documentPath, evidenceId }) => tracedToolResult('anx_cite', await andocCite(
  allowedDocumentPath(documentPath),
  evidenceId,
)))

function allowedDocumentPath(value: string): string {
  const resolved = path.resolve(value)
  const relative = path.relative(allowedRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path is outside the configured read-only ANX workspace: ${value}`)
  const extension = path.extname(resolved).toLowerCase()
  if (!['.anx', '.anxd', '.agn', '.andoc'].includes(extension)) {
    throw new Error(`Expected an .anx path (legacy .anxd, .agn, and .andoc are also accepted): ${value}`)
  }
  return resolved
}

function configuredEvidenceTracePath(): string | undefined {
  const configured = process.env.ANX_EVIDENCE_TRACE_PATH
  const required = process.env.ANX_REQUIRE_EVIDENCE_TRACE === '1'
  if (!configured) {
    if (required) {
      throw new Error(
        'ANX_EVIDENCE_TRACE_REQUIRED: the trusted MCP host requires an absolute evidence-trace path',
      )
    }
    return undefined
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(
      'ANX_EVIDENCE_TRACE_INVALID: the trusted MCP host requires an absolute evidence-trace path',
    )
  }
  return path.resolve(configured)
}

function toolResult(value: unknown, modelValue = value): {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
} {
  const structuredContent = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value }
  const modelContent = modelValue && typeof modelValue === 'object' && !Array.isArray(modelValue)
    ? modelValue as Record<string, unknown>
    : { value: modelValue }
  return {
    content: [{ type: 'text', text: JSON.stringify(modelContent) }],
    structuredContent,
  }
}

async function tracedToolResult(
  tool: string,
  value: unknown,
  modelValue = value,
): Promise<ReturnType<typeof toolResult>> {
  await appendAnxEvidenceTrace(evidenceTracePath, tool, value)
  return toolResult(value, modelValue)
}

const transport = new StdioServerTransport()
await server.connect(transport)
