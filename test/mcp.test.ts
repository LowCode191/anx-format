import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  citationsFromAnxEvidenceTrace,
  readAnxEvidenceTrace,
} from '../src/agent-evidence-trace.js'
import {
  anxEvidenceToolsForProfile,
  configuredAnxEvidenceToolProfile,
} from '../src/evidence-tool-profile.js'
import { packAndoc, type AndocDocument } from '../src/index.js'

test('MCP server advertises and executes the ANX agent-experience tools over stdio', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-mcp-'))
  const document = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8')) as AndocDocument
  document.metadata.anxRelationships = {
    schema: 'anx.relationships.v1',
    relationships: [{
      id: 'relationship-iso-9001',
      type: 'governed-by',
      status: 'active',
      target: { kind: 'external-document', identifier: 'ISO 9001:2015', title: 'Quality management systems — Requirements', revision: '2015', publisher: 'ISO' },
      resolution: { status: 'metadata-only', contentAvailable: false },
      authority: {
        status: 'human-approved',
        assertedBy: { type: 'human', id: 'reviewer' },
        assertedAt: '2026-07-27T12:00:00.000Z',
        approvedBy: { type: 'human', id: 'reviewer' },
        approvedAt: '2026-07-27T12:00:00.000Z',
      },
      createdAt: '2026-07-27T12:00:00.000Z',
      updatedAt: '2026-07-27T12:00:00.000Z',
    }],
  }
  const documentPath = path.join(root, 'mcp.anx')
  await writeFile(documentPath, await packAndoc({ document }))

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, '../dist/mcp-server.js')],
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...getDefaultEnvironment(), ANX_ALLOWED_ROOT: root },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'anx-test-client', version: '0.4.0' })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
      'andoc_apply',
      'andoc_capabilities',
      'andoc_cite',
      'andoc_context',
      'andoc_edit_locate',
      'andoc_export_pdf',
      'andoc_get',
      'andoc_get_batch',
      'andoc_insert_image',
      'andoc_ocr_candidates',
      'andoc_open',
      'andoc_outline',
      'andoc_preview',
      'andoc_query',
      'andoc_read',
      'andoc_regions',
      'andoc_review_propose',
      'andoc_review_status',
      'andoc_search',
      'andoc_shared_content',
      'andoc_text_quality',
      'andoc_verify_final',
      'andoc_verify_lineage',
      'andoc_verify_source_baseline',
      'anx_page_evidence',
      'anx_relationships',
      'anx_table_evidence',
    ])
    for (const toolName of ['andoc_preview', 'andoc_apply', 'andoc_insert_image']) {
      const schema = listed.tools.find(tool => tool.name === toolName)?.inputSchema as { required?: string[] } | undefined
      assert.ok(schema?.required?.includes('baseRevision'), `${toolName} must require an expected baseRevision`)
    }
    const result = await client.callTool({ name: 'andoc_search', arguments: { documentPath, query: 'stable node IDs' } })
    assert.equal(result.isError, undefined)
    const structured = result.structuredContent as { matches: Array<{ nodeId: string; citation: { uri: string } }> }
    assert.equal(structured.matches[0]?.nodeId, 'paragraph-1')
    assert.match(structured.matches[0]!.citation.uri, /^anx:\/\//)

    const queryResult = await client.callTool({ name: 'andoc_query', arguments: { documentPath, query: 'What uses stable node IDs?', limit: 2 } })
    assert.equal(queryResult.isError, undefined)
    const queried = queryResult.structuredContent as { matches: Array<{ evidence: Array<{ nodeId: string; citation: string }> }> }
    assert.equal(queried.matches[0]?.evidence[0]?.nodeId, 'paragraph-1')

    const proposalResult = await client.callTool({ name: 'andoc_review_propose', arguments: {
      documentPath,
      baseRevision: 0,
      actorId: 'mcp-review-agent',
      message: 'Clarify the stable-ID statement',
      operations: [{ op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Proposed replacement that is not applied yet.' }] }],
    } })
    assert.equal(proposalResult.isError, undefined)
    assert.equal((proposalResult.structuredContent as { canonicalContentChanged: boolean }).canonicalContentChanged, false)
    const reviewResult = await client.callTool({ name: 'andoc_review_status', arguments: { documentPath } })
    const review = reviewResult.structuredContent as { counts: { openProposals: number }; state: { proposals: Array<{ status: string }> } }
    assert.equal(review.counts.openProposals, 1)
    assert.equal(review.state.proposals[0]?.status, 'open')
    const unchangedResult = await client.callTool({ name: 'andoc_get', arguments: { documentPath, nodeId: 'paragraph-1' } })
    assert.match(JSON.stringify(unchangedResult.structuredContent), /stable node IDs/)
    assert.match(queried.matches[0]!.evidence[0]!.citation, /^anx:\/\//)

    const relationshipResult = await client.callTool({ name: 'anx_relationships', arguments: { documentPath } })
    assert.equal(relationshipResult.isError, undefined)
    const relationships = relationshipResult.structuredContent as {
      counts: { active: number; contentUnavailable: number }
      relationships: Array<{ id: string; citation: { uri: string }; agentUse: { targetContentAvailable: boolean; verificationRequired: boolean } }>
      claimBoundary: string
    }
    assert.equal(relationships.counts.active, 1)
    assert.equal(relationships.counts.contentUnavailable, 1)
    assert.equal(relationships.relationships[0]?.id, 'relationship-iso-9001')
    assert.equal(relationships.relationships[0]?.agentUse.targetContentAvailable, false)
    assert.equal(relationships.relationships[0]?.agentUse.verificationRequired, true)
    assert.match(relationships.relationships[0]!.citation.uri, /\/relationships\/relationship-iso-9001$/)
    assert.match(relationships.claimBoundary, /do not prove/)

    const sharedContentResult = await client.callTool({ name: 'andoc_shared_content', arguments: { documentPath } })
    assert.equal(sharedContentResult.isError, undefined)
    const sharedContent = sharedContentResult.structuredContent as { schema: string; summary: { groups: number; canonicalContentChanged: boolean } }
    assert.equal(sharedContent.schema, 'anx.shared-content.v1')
    assert.equal(sharedContent.summary.groups, 0)
    assert.equal(sharedContent.summary.canonicalContentChanged, false)

    const pdfPackagePath = path.join(root, 'pdf-media-fixture.agn')
    await writeFile(pdfPackagePath, await readFile(path.join(import.meta.dirname, '../examples/pdf-media-fixture.agn')))
    const qualityResult = await client.callTool({ name: 'andoc_text_quality', arguments: { documentPath: pdfPackagePath } })
    assert.equal(qualityResult.isError, undefined)
    const quality = qualityResult.structuredContent as { schema: string; pageCount: number; summary: { pagesRequiringOcr: number } }
    assert.equal(quality.schema, 'agn.pdf-text-quality.v1')
    assert.ok(quality.pageCount >= 1)
    assert.ok(quality.summary.pagesRequiringOcr >= 0)

    const regionResult = await client.callTool({ name: 'andoc_regions', arguments: { documentPath: pdfPackagePath } })
    assert.equal(regionResult.isError, undefined)
    const regions = regionResult.structuredContent as {
      schema: string
      summary: { total: number }
      captionAssist: { addedCaptions: number; automaticCanonicalChange: boolean }
      regions: Array<{ page: number; kind: string; unattendedUse: string }>
    }
    assert.equal(regions.schema, 'anx.region-evidence.v1')
    assert.ok(regions.summary.total >= 1)
    assert.ok(regions.regions.every(region => region.page >= 1 && ['figure', 'chart', 'caption'].includes(region.kind)))
    assert.ok(regions.regions.filter(region => ['figure', 'chart'].includes(region.kind)).every(region => region.unattendedUse === 'review-required'))
    assert.ok(regions.regions.filter(region => region.kind === 'caption').every(region => region.unattendedUse === 'allowed'))
    assert.equal(regions.captionAssist.addedCaptions, 2)
    assert.equal(regions.captionAssist.automaticCanonicalChange, false)

    const pageEvidenceResult = await client.callTool({
      name: 'anx_page_evidence',
      arguments: { documentPath: pdfPackagePath, page: regions.regions[0]!.page, mode: 'standard' },
    })
    assert.equal(pageEvidenceResult.isError, undefined)
    const pageEvidence = pageEvidenceResult.structuredContent as {
      schema: string
      automaticCanonicalChange: boolean
      regions: Array<{ id: string; citation: { uri: string; regionId: string; evidenceType: string } }>
    }
    assert.equal(pageEvidence.schema, 'anx.page-evidence.v1')
    assert.equal(pageEvidence.automaticCanonicalChange, false)
    assert.ok(pageEvidence.regions.length >= 1)
    assert.match(pageEvidence.regions[0]!.citation.uri, /^anx:\/\/.+\/regions\/region-/)
    assert.equal(pageEvidence.regions[0]!.citation.regionId, pageEvidence.regions[0]!.id)
    assert.equal(pageEvidence.regions[0]!.citation.evidenceType, 'region')

    const editResult = await client.callTool({ name: 'andoc_edit_locate', arguments: { documentPath, query: 'Structured blocks and transactions', limit: 3 } })
    assert.equal(editResult.isError, undefined)
    const editTarget = editResult.structuredContent as { matches: Array<{ nodeId: string; operationTemplate: Record<string, unknown> }> }
    assert.equal(editTarget.matches[0]?.nodeId, 'cell-agent-source')
    assert.deepEqual(editTarget.matches[0]?.operationTemplate, {
      op: 'updateTableCell',
      tableId: 'table-1',
      cellId: 'cell-agent-source',
      content: [{ text: '<replacement text>' }],
    })

    const capabilitiesResult = await client.callTool({ name: 'andoc_capabilities', arguments: { documentPath } })
    assert.equal(capabilitiesResult.isError, undefined)
    const capabilities = capabilitiesResult.structuredContent as { legacyDefault: boolean; finalized: boolean; core: { id: string } }
    assert.equal(capabilities.legacyDefault, true)
    assert.equal(capabilities.finalized, false)
    assert.equal(capabilities.core.id, 'andoc.profile.core-document')

    const verificationResult = await client.callTool({ name: 'andoc_verify_final', arguments: { documentPath } })
    assert.equal(verificationResult.isError, undefined)
    const verification = verificationResult.structuredContent as { status: string; sealed: boolean }
    assert.equal(verification.status, 'UNFINALIZED')
    assert.equal(verification.sealed, false)

    const lineageResult = await client.callTool({ name: 'andoc_verify_lineage', arguments: { documentPath } })
    assert.equal(lineageResult.isError, undefined)
    const lineage = lineageResult.structuredContent as { status: string; valid: boolean }
    assert.equal(lineage.status, 'NO_LINEAGE')
    assert.equal(lineage.valid, false)

    const sourceBaselineResult = await client.callTool({ name: 'andoc_verify_source_baseline', arguments: { documentPath } })
    assert.equal(sourceBaselineResult.isError, undefined)
    const sourceBaseline = sourceBaselineResult.structuredContent as { status: string; registered: boolean; issuerVerified: boolean }
    assert.equal(sourceBaseline.status, 'UNVERIFIED_SOURCE')
    assert.equal(sourceBaseline.registered, false)
    assert.equal(sourceBaseline.issuerVerified, false)
  } finally {
    await client.close()
  }
})

test('read-only ANX evidence MCP server advertises only the canonical bounded evidence surface', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'anx-evidence-mcp-'))
  const document = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8')) as AndocDocument
  document.metadata.anxRelationships = {
    schema: 'anx.relationships.v1',
    relationships: [{
      id: 'relationship-external-standard',
      type: 'references',
      status: 'active',
      target: { kind: 'external-document', identifier: 'EXTERNAL-1', title: 'External standard' },
      resolution: { status: 'metadata-only', contentAvailable: false },
      authority: {
        status: 'human-approved',
        assertedBy: { type: 'human', id: 'reviewer' },
        assertedAt: '2026-07-27T12:00:00.000Z',
        approvedBy: { type: 'human', id: 'reviewer' },
        approvedAt: '2026-07-27T12:00:00.000Z',
      },
      createdAt: '2026-07-27T12:00:00.000Z',
      updatedAt: '2026-07-27T12:00:00.000Z',
    }],
  }
  document.metadata.layout = { sourcePageSizes: { '1': { width: 612, height: 792 } } }
  const paragraph = document.blocks.find(block => block.id === 'paragraph-1')!
  paragraph.provenance = { kind: 'imported', sourceUri: 'fixture.pdf', page: 1, bbox: [40, 40, 560, 90] }
  const chart = document.blocks.find(block => block.id === 'chart-1')!
  chart.provenance = { kind: 'imported', sourceUri: 'fixture.pdf', page: 1, bbox: [60, 120, 550, 500], confidence: 0.9 }
  const table = document.blocks.find(block => block.id === 'table-1')!
  table.provenance = { kind: 'imported', sourceUri: 'fixture.pdf', page: 1, bbox: [60, 520, 550, 740], confidence: 0.9 }
  const documentPath = path.join(root, 'evidence.anx')
  const evidenceTracePath = path.join(root, 'agent-evidence-trace.jsonl')
  await writeFile(documentPath, await packAndoc({ document }))

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, '../dist/evidence-mcp-server.js')],
    cwd: path.join(import.meta.dirname, '..'),
    env: {
      ...getDefaultEnvironment(),
      ANX_ALLOWED_ROOT: root,
      ANX_EVIDENCE_TRACE_PATH: evidenceTracePath,
      ANX_REQUIRE_EVIDENCE_TRACE: '1',
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'anx-evidence-test-client', version: '0.4.0' })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['anx_cite', 'anx_page_evidence', 'anx_relationships', 'anx_search', 'anx_table_evidence'])
    assert.ok(listed.tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false))

    const searchResult = await client.callTool({
      name: 'anx_search',
      arguments: { documentPath, query: 'stable node IDs' },
    })
    assert.equal(searchResult.isError, undefined)
    const search = searchResult.structuredContent as {
      schema: string
      matches: Array<{ nodeId: string; citation: string; page: number; textQuality: string }>
      nextAction: string
    }
    assert.equal(search.schema, 'anx.search-evidence.v1')
    assert.equal(search.matches[0]?.nodeId, 'paragraph-1')
    assert.match(search.matches[0]!.citation, /^anx:\/\//)
    assert.equal(search.matches[0]!.page, 1)
    assert.equal(search.matches[0]!.textQuality, 'unverified')
    assert.match(search.nextAction, /Stop searching|Narrow the query/)

    const pageResult = await client.callTool({ name: 'anx_page_evidence', arguments: { documentPath, page: 1 } })
    assert.equal(pageResult.isError, undefined)
    const page = pageResult.structuredContent as {
      schema: string
      projection: string
      regions: Array<{ id: string; citation: string; agentUse: { reviewRequired: boolean } }>
      detailExpansion: string
    }
    assert.equal(page.schema, 'anx.page-evidence.v1')
    assert.equal(page.projection, 'agent-compact-v1')
    assert.ok(page.regions.length >= 1)
    assert.match(page.regions[0]!.citation, /\/regions\//)
    assert.equal(page.regions[0]!.agentUse.reviewRequired, true)
    assert.match(page.detailExpansion, /mode to standard/)

    const tableResult = await client.callTool({
      name: 'anx_table_evidence',
      arguments: { documentPath, page: 1, query: 'comparison table' },
    })
    assert.equal(tableResult.isError, undefined)
    const tableEvidence = tableResult.structuredContent as {
      schema: string
      projection: string
      tables: Array<{
        citation: string
        dimensions: { rowCount: number; columnCount: number; disclosure: string }
        agentUse: { reviewRequired: boolean }
      }>
      automaticCanonicalChange: boolean
    }
    assert.equal(tableEvidence.schema, 'anx.table-answer-evidence.v1')
    assert.equal(tableEvidence.projection, 'agent-table-answer-v1')
    assert.equal(
      (tableResult.content[0] as { type: 'text'; text: string }).text,
      JSON.stringify(tableResult.structuredContent),
    )
    assert.equal(tableEvidence.tables[0]?.dimensions.rowCount, 3)
    assert.equal(tableEvidence.tables[0]?.dimensions.columnCount, 2)
    assert.equal(tableEvidence.tables[0]?.dimensions.disclosure, 'complete')
    assert.match(tableEvidence.tables[0]!.citation, /\/regions\//)
    assert.equal(tableEvidence.tables[0]!.agentUse.reviewRequired, true)
    assert.equal(tableEvidence.automaticCanonicalChange, false)

    const standardPageResult = await client.callTool({
      name: 'anx_page_evidence',
      arguments: { documentPath, page: 1, mode: 'standard' },
    })
    assert.equal(standardPageResult.isError, undefined)
    const standardPage = standardPageResult.structuredContent as {
      projection?: string
      regions: Array<{ citation: { uri: string }; bbox: number[] }>
    }
    assert.equal(standardPage.projection, undefined)
    assert.match(standardPage.regions[0]!.citation.uri, /\/regions\//)
    assert.equal(standardPage.regions[0]!.bbox.length, 4)

    const citationResult = await client.callTool({
      name: 'anx_cite',
      arguments: { documentPath, evidenceId: page.regions[0]!.id },
    })
    assert.equal(citationResult.isError, undefined)
    assert.equal((citationResult.structuredContent as { uri: string }).uri, page.regions[0]!.citation)

    const relationshipResult = await client.callTool({
      name: 'anx_relationships',
      arguments: { documentPath, types: ['references'] },
    })
    assert.equal(relationshipResult.isError, undefined)
    const relationship = (relationshipResult.structuredContent as {
      relationships: Array<{ id: string; resolution: { status: string }; citation: { uri: string } }>
    }).relationships[0]!
    assert.equal(relationship.id, 'relationship-external-standard')
    assert.equal(relationship.resolution.status, 'metadata-only')
    assert.match(relationship.citation.uri, /\/relationships\//)

    const trace = await readAnxEvidenceTrace(evidenceTracePath)
    assert.deepEqual(trace.map(record => record.tool), [
      'anx_search',
      'anx_page_evidence',
      'anx_table_evidence',
      'anx_page_evidence',
      'anx_cite',
      'anx_relationships',
    ])
    const tracedCitations = citationsFromAnxEvidenceTrace(trace)
    assert.ok(tracedCitations.includes(search.matches[0]!.citation))
    assert.ok(tracedCitations.includes(tableEvidence.tables[0]!.citation))
    assert.ok(tracedCitations.includes(relationship.citation.uri))
  } finally {
    await client.close()
  }
})

test('table-answer MCP profile advertises one read-only tool and retains trusted trace guarantees', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'anx-table-answer-mcp-'))
  const document = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8')) as AndocDocument
  document.metadata.layout = { sourcePageSizes: { '1': { width: 612, height: 792 } } }
  const table = document.blocks.find(block => block.id === 'table-1')!
  table.provenance = { kind: 'imported', sourceUri: 'fixture.pdf', page: 1, bbox: [60, 520, 550, 740], confidence: 0.9 }
  const documentPath = path.join(root, 'table-profile.anx')
  const evidenceTracePath = path.join(root, 'agent-evidence-trace.jsonl')
  await writeFile(documentPath, await packAndoc({ document }))

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, '../dist/evidence-mcp-server.js')],
    cwd: path.join(import.meta.dirname, '..'),
    env: {
      ...getDefaultEnvironment(),
      ANX_ALLOWED_ROOT: root,
      ANX_EVIDENCE_TRACE_PATH: evidenceTracePath,
      ANX_REQUIRE_EVIDENCE_TRACE: '1',
      ANX_MCP_TOOL_PROFILE: 'table-answer',
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'anx-table-answer-test-client', version: '0.4.0' })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(tool => tool.name), ['anx_table_evidence'])
    assert.equal(listed.tools[0]?.annotations?.readOnlyHint, true)
    assert.equal(listed.tools[0]?.annotations?.destructiveHint, false)

    const result = await client.callTool({
      name: 'anx_table_evidence',
      arguments: { documentPath, page: 1, query: 'comparison table' },
    })
    assert.equal(result.isError, undefined)
    assert.equal((result.structuredContent as { schema: string }).schema, 'anx.table-answer-evidence.v1')
    const modelContent = JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as {
      projection: string
      source?: unknown
      tables: Array<{ citation: string }>
    }
    assert.equal(modelContent.projection, 'agent-table-model-v1')
    assert.equal(modelContent.source, undefined)
    assert.match(modelContent.tables[0]!.citation, /\/regions\//)
    assert.ok(
      Buffer.byteLength(JSON.stringify(modelContent))
        < Buffer.byteLength(JSON.stringify(result.structuredContent)),
    )
    const trace = await readAnxEvidenceTrace(evidenceTracePath)
    assert.deepEqual(trace.map(record => record.tool), ['anx_table_evidence'])
    assert.equal((await stat(evidenceTracePath)).mode & 0o777, 0o600)
  } finally {
    await client.close()
  }
})

test('unknown MCP tool profiles fail closed', () => {
  assert.equal(configuredAnxEvidenceToolProfile(undefined), 'full')
  assert.deepEqual(anxEvidenceToolsForProfile('table-answer'), ['anx_table_evidence'])
  assert.throws(
    () => configuredAnxEvidenceToolProfile('everything'),
    /ANX_MCP_TOOL_PROFILE_INVALID/,
  )
})
