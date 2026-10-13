import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ANX_COMPACT_SEARCH_DEFAULT_LIMIT,
  anxCompactPageEvidence,
  anxCompactSearch,
  anxPageTextEvidenceBundle,
  anxPageTextEvidenceModelView,
  anxResponseEvidenceFromPageTextBundle,
  anxResponseEvidenceFromTableBundle,
  anxTableEvidenceBundle,
  anxTableEvidenceModelView,
} from '../src/agent-evidence-compact.js'
import { andocSearch } from '../src/agent-tools.js'
import { packAndoc, type AndocDocument } from '../src/index.js'
import { ocrPageFixtureBytes } from './helpers/ocr-page-fixture.js'

test('compact evidence defaults to five citation-complete matches and expands page detail on demand', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'anx-compact-evidence-'))
  const document = JSON.parse(
    await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8'),
  ) as AndocDocument
  document.blocks.push(...Array.from({ length: 8 }, (_, index): AndocDocument['blocks'][number] => ({
    id: `compact-paragraph-${index + 1}`,
    type: 'paragraph',
    content: [{ text: `Compact projection evidence ${index + 1} with enough context for ranked retrieval.` }],
    provenance: {
      kind: 'imported',
      sourceUri: 'fixture.pdf',
      page: 1,
      bbox: [40, 100 + index * 20, 560, 115 + index * 20],
    },
  })))
  const chart = document.blocks.find(block => block.type === 'chart')
  assert.ok(chart)
  chart.provenance = {
    kind: 'imported',
    sourceUri: 'fixture.pdf',
    page: 1,
    bbox: [60, 300, 550, 600],
    confidence: 0.75,
  }
  const table = document.blocks.find(block => block.type === 'table')
  assert.ok(table)
  table.provenance = {
    kind: 'imported',
    sourceUri: 'fixture.pdf',
    page: 1,
    bbox: [60, 620, 550, 760],
  }
  const documentPath = path.join(root, 'compact.anx')
  await writeFile(documentPath, await packAndoc({ document }))

  const fullSearch = await andocSearch(documentPath, 'Compact projection evidence', 10) as {
    matches: Array<{ nodeId: string; citation: { uri: string } }>
  }
  const compactSearch = await anxCompactSearch(documentPath, 'Compact projection evidence') as {
    schema: string
    matches: Array<{ nodeId: string; citation: string; page: number; textQuality: string }>
  }
  assert.equal(compactSearch.schema, 'anx.search-evidence.v1')
  assert.equal(compactSearch.matches.length, ANX_COMPACT_SEARCH_DEFAULT_LIMIT)
  assert.deepEqual(
    compactSearch.matches.map(match => match.nodeId),
    fullSearch.matches.slice(0, ANX_COMPACT_SEARCH_DEFAULT_LIMIT).map(match => match.nodeId),
  )
  assert.ok(compactSearch.matches.every(match => match.citation.startsWith('anx://')))
  assert.ok(compactSearch.matches.every(match => match.page === 1))
  assert.ok(
    Buffer.byteLength(JSON.stringify(compactSearch))
      < Buffer.byteLength(JSON.stringify(fullSearch)) * 0.7,
  )

  const compactPage = await anxCompactPageEvidence(documentPath, 1, { kinds: ['chart'] }) as {
    projection: string
    regions: Array<{ citation: string; bbox?: number[]; provenance: { verified: boolean } }>
    automaticCanonicalChange: boolean
  }
  assert.equal(compactPage.projection, 'agent-compact-v1')
  assert.ok(compactPage.regions.length >= 1)
  assert.ok(compactPage.regions.every(region => region.citation.startsWith('anx://')))
  assert.ok(compactPage.regions.every(region => region.bbox === undefined))
  assert.equal(compactPage.automaticCanonicalChange, false)

  const compactTablePage = await anxCompactPageEvidence(documentPath, 1, {
    kinds: ['table'],
  }) as {
    regions: Array<{
      kind: string
      structuredData?: { rowCount?: number; columnCount?: number }
    }>
  }
  const compactTable = compactTablePage.regions.find(region => region.kind === 'table')
  assert.ok(compactTable)
  assert.equal(compactTable.structuredData?.rowCount, 3)
  assert.equal(compactTable.structuredData?.columnCount, 2)

  const tableBundle = await anxTableEvidenceBundle(documentPath, 1, {
    query: 'Quarterly revenue table',
  }) as {
    schema: string
    projection: string
    selection: { returnedTables: number }
    tables: Array<{
      id: string
      dimensions: { rowCount: number; columnCount: number; disclosure: string }
      citation: string
      agentUse: { reviewRequired: boolean; safeForUnattendedAcceptance: boolean }
    }>
    responseEvidence: {
      schema: string
      representation: string
      items: Array<{
        role: string
        evidenceId: string
        citation: string
        semanticType: string
        sourceRepresentation: string
        dataState: string
        textQuality: string
        dimensions: { rowCount: number; columnCount: number; disclosure: string } | null
        anchorStatus: string
      }>
    }
    responseInstructions: string
    automaticCanonicalChange: boolean
    nextAction: string
  }
  assert.equal(tableBundle.schema, 'anx.table-answer-evidence.v1')
  assert.equal(tableBundle.projection, 'agent-table-answer-v1')
  assert.equal(tableBundle.selection.returnedTables, 1)
  assert.deepEqual(tableBundle.tables[0]?.dimensions, {
    rowCount: 3,
    columnCount: 2,
    disclosure: 'complete',
  })
  assert.match(tableBundle.tables[0]!.citation, /\/regions\//)
  assert.equal(typeof tableBundle.tables[0]!.agentUse.reviewRequired, 'boolean')
  assert.equal(typeof tableBundle.tables[0]!.agentUse.safeForUnattendedAcceptance, 'boolean')
  assert.equal(tableBundle.responseEvidence.schema, 'anx.agent-response-evidence.v1')
  assert.equal(tableBundle.responseEvidence.representation, 'anx-native')
  assert.equal(tableBundle.responseEvidence.items[0]?.role, 'primary')
  assert.equal(tableBundle.responseEvidence.items[0]?.evidenceId, tableBundle.tables[0]?.id)
  assert.equal(tableBundle.responseEvidence.items[0]?.citation, tableBundle.tables[0]?.citation)
  assert.equal(tableBundle.responseEvidence.items[0]?.semanticType, 'table')
  assert.equal(tableBundle.responseEvidence.items[0]?.textQuality, 'not-applicable')
  assert.deepEqual(
    tableBundle.responseEvidence.items[0]?.dimensions,
    tableBundle.tables[0]?.dimensions,
  )
  assert.equal(tableBundle.responseEvidence.items[0]?.anchorStatus, 'not-applicable')
  assert.match(tableBundle.responseInstructions, /Legacy full-envelope mode/)
  assert.deepEqual(
    anxResponseEvidenceFromTableBundle(tableBundle),
    tableBundle.responseEvidence,
  )
  const modelView = anxTableEvidenceModelView(tableBundle) as {
    projection: string
    source?: unknown
    sourceBaseline: { status: string }
    tables: Array<{
      citation: string
      sourceCitations?: unknown
      provenance?: unknown
      evidence: {
        semanticType: string
        dataState: string
        reviewRequired: boolean
      }
    }>
  }
  assert.equal(modelView.projection, 'agent-table-model-v1')
  assert.equal(modelView.source, undefined)
  assert.equal(modelView.sourceBaseline.status, 'UNVERIFIED_SOURCE')
  assert.equal(modelView.tables[0]?.evidence.semanticType, 'table')
  assert.equal(typeof modelView.tables[0]?.evidence.reviewRequired, 'boolean')
  assert.match(modelView.tables[0]!.citation, /\/regions\//)
  assert.equal(modelView.tables[0]?.sourceCitations, undefined)
  assert.equal(modelView.tables[0]?.provenance, undefined)
  assert.ok(
    Buffer.byteLength(JSON.stringify(modelView))
      < Buffer.byteLength(JSON.stringify(tableBundle)) * 0.8,
  )
  assert.equal(tableBundle.automaticCanonicalChange, false)
  assert.match(tableBundle.nextAction, /Stop/)

  const modelCompactBundle = await anxTableEvidenceBundle(documentPath, 1, {
    query: 'Quarterly revenue table',
    includeResponseEvidence: false,
  }) as {
    responseEvidence?: unknown
    responseInstructions: string
    tables: unknown[]
  }
  assert.equal(modelCompactBundle.responseEvidence, undefined)
  assert.equal(modelCompactBundle.tables.length, 1)
  assert.match(modelCompactBundle.responseInstructions, /ANX records this tool result/)
  assert.match(modelCompactBundle.responseInstructions, /attaches its canonical citations and machine evidence/)

  const pageTextBundle = await anxPageTextEvidenceBundle(documentPath, 1, {
    query: 'Summarize the selected page text.',
    limit: 4,
  }) as {
    schema: string
    projection: string
    page: number
    selection: {
      textBlocksOnPage: number
      returnedTextBlocks: number
      excludedNonTextBlocks: number
    }
    blocks: Array<{
      id: string
      type: string
      text: string
      textQuality: string
      citation: string
    }>
    responseEvidence: {
      schema: string
      items: Array<{
        role: string
        evidenceId: string
        citation: string
        semanticType: string
        dataState: string
      }>
    }
  }
  assert.equal(pageTextBundle.schema, 'anx.page-text-answer-evidence.v1')
  assert.equal(pageTextBundle.projection, 'agent-page-text-answer-v1')
  assert.equal(pageTextBundle.page, 1)
  assert.equal(pageTextBundle.selection.returnedTextBlocks, 4)
  assert.ok(pageTextBundle.selection.textBlocksOnPage >= 4)
  assert.ok(pageTextBundle.selection.excludedNonTextBlocks >= 2)
  assert.ok(pageTextBundle.blocks.every(block => (
    ['heading', 'paragraph', 'list', 'footnote', 'extension'].includes(block.type)
  )))
  assert.ok(pageTextBundle.blocks.every(block => block.citation.startsWith('anx://')))
  assert.deepEqual(
    anxResponseEvidenceFromPageTextBundle(pageTextBundle),
    pageTextBundle.responseEvidence,
  )
  assert.equal(pageTextBundle.responseEvidence.items[0]?.role, 'primary')
  assert.equal(
    pageTextBundle.responseEvidence.items[0]?.evidenceId,
    pageTextBundle.blocks[0]?.id,
  )
  assert.equal(
    pageTextBundle.responseEvidence.items[0]?.citation,
    pageTextBundle.blocks[0]?.citation,
  )
  assert.equal(pageTextBundle.responseEvidence.items[0]?.dataState, 'canonical-text')

  const pageTextModelView = anxPageTextEvidenceModelView(pageTextBundle) as {
    projection: string
    source?: unknown
    blocks: Array<{ citation: string }>
    claimBoundary: string
  }
  assert.equal(pageTextModelView.projection, 'agent-page-text-model-v1')
  assert.equal(pageTextModelView.source, undefined)
  assert.equal(pageTextModelView.blocks.length, 4)
  assert.ok(pageTextModelView.blocks.every(block => block.citation.startsWith('anx://')))
  assert.match(pageTextModelView.claimBoundary, /page-text reading/)

  const standardPage = await anxCompactPageEvidence(documentPath, 1, {
    kinds: ['chart'],
    mode: 'standard',
  }) as {
    projection?: string
    regions: Array<{ citation: { uri: string }; bbox: number[] }>
  }
  assert.equal(standardPage.projection, undefined)
  assert.ok(standardPage.regions.every(region => region.citation.uri.startsWith('anx://')))
  assert.ok(standardPage.regions.every(region => region.bbox.length === 4))
})

test('page-text evidence exposes preferred OCR as source-bound candidate evidence without canonical promotion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'anx-compact-ocr-evidence-'))
  const documentPath = path.join(root, 'scanned.anx')
  await writeFile(documentPath, await ocrPageFixtureBytes({ anchorPages: [] }))
  const bundle = await anxPageTextEvidenceBundle(documentPath, 1, {
    query: 'What are the Table 2 parameters?',
    maximumCharacters: 1_600,
  }) as Record<string, any>
  assert.equal(bundle.selection.method, 'validated-source-bound-ocr-candidate')
  assert.equal(bundle.blocks.length, 1)
  assert.match(bundle.blocks[0].text, /Angle Phi/)
  assert.equal(bundle.blocks[0].textQuality, 'ocr')
  assert.equal(bundle.blocks[0].sourceRepresentation, 'source-text')
  assert.equal(bundle.blocks[0].dataState, 'candidate-only')
  assert.equal(bundle.blocks[0].reviewRequired, true)
  assert.equal(bundle.blocks[0].canonical, false)
  assert.equal(bundle.blocks[0].id, 'source-page-1')
  assert.match(bundle.blocks[0].citation, /\/source-pages\/source-page-1$/u)
  assert.equal(bundle.automaticCanonicalChange, false)
  const responseEvidence = anxResponseEvidenceFromPageTextBundle(bundle)
  assert.equal(responseEvidence.items[0]?.semanticType, 'ocr-page-text')
  assert.equal(responseEvidence.items[0]?.evidenceStatus, 'candidate')
  assert.equal(responseEvidence.items[0]?.unattendedUse, 'review-required')
  assert.equal(responseEvidence.items[0]?.safeForUnattendedAcceptance, false)
})
