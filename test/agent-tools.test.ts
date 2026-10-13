import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  andocApply,
  andocCite,
  andocContext,
  andocEditLocate,
  andocExportPdf,
  andocGet,
  andocGetBatch,
  andocInsertImage,
  andocOpen,
  andocOutline,
  andocPreview,
  andocQuery,
  andocReadAdaptive,
  andocSearch,
  buildConflictReview,
  packAndoc,
  readAndoc,
  RevisionConflictError,
  type AndocDocument,
  type AndocOperation,
} from '../src/index.js'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures')
const workspaceRoot = path.resolve(import.meta.dirname, '..')

async function fixtureDocument(): Promise<AndocDocument> {
  return JSON.parse(await readFile(path.join(fixtureRoot, 'sample.document.json'), 'utf8')) as AndocDocument
}

async function runHumanTransactionWorker(documentPath: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(workspaceRoot, 'test/helpers/human-transaction-worker.ts'), documentPath], {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const exitCode = await new Promise<number | null>(resolve => child.once('close', resolve))
  if (exitCode !== 0) throw new Error(`Human transaction worker failed (${exitCode}): ${stderr}`)
  return JSON.parse(stdout) as Record<string, unknown>
}

test('agent tools expose low-token discovery, citations, preview, apply, media, and export', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-agent-tools-'))
  const document = JSON.parse(await readFile(path.join(fixtureRoot, 'sample.document.json'), 'utf8')) as AndocDocument
  const documentPath = path.join(root, 'agent-experience.anx')
  await writeFile(documentPath, await packAndoc({ document }))

  const outline = await andocOutline(documentPath) as { revision: number; blockCount: number; blocks: Array<{ id: string; citation: string }> }
  assert.equal(outline.revision, 0)
  assert.equal(outline.blockCount, 4)
  assert.match(outline.blocks[0]!.citation, /^anx:\/\/agn-sample\/revisions\/0\/blocks\/heading-1$/)

  const search = await andocSearch(documentPath, 'structured blocks') as { matches: Array<{ nodeId: string; citation: { uri: string } }> }
  assert.equal(search.matches[0]?.nodeId, 'cell-agent-source')
  assert.match(search.matches[0]!.citation.uri, /table-1\/cells\/cell-agent-source$/)

  const targeted = await andocGet(documentPath, 'cell-agent-source') as { cell: { content: Array<{ text: string }> }; block: { id: string } }
  assert.equal(targeted.block.id, 'table-1')
  assert.equal(targeted.cell.content[0]?.text, 'Structured blocks and transactions')
  assert.equal((await andocCite(documentPath, 'cell-agent-source')).nodeId, 'cell-agent-source')

  const editTarget = await andocEditLocate(documentPath, 'Structured blocks and transactions') as {
    matches: Array<{
      nodeId: string
      tableContext: { tableId: string; rowIndex: number; columnIndex: number; rowValues: Array<{ id: string; text: string }> }
      operationTemplate: Record<string, unknown>
    }>
  }
  assert.equal(editTarget.matches[0]?.nodeId, 'cell-agent-source')
  assert.equal(editTarget.matches[0]?.tableContext.tableId, 'table-1')
  assert.equal(editTarget.matches[0]?.tableContext.rowValues[1]?.text, 'Structured blocks and transactions')
  assert.deepEqual(editTarget.matches[0]?.operationTemplate, {
    op: 'updateTableCell',
    tableId: 'table-1',
    cellId: 'cell-agent-source',
    content: [{ text: '<replacement text>' }],
  })
  const structuralTarget = await andocEditLocate(documentPath, 'One canonical document drives both views') as {
    matches: Array<{ structuralOperationTemplates: Record<string, unknown> }>
  }
  assert.deepEqual(structuralTarget.matches[0]?.structuralOperationTemplates, {
    moveAfter: { op: 'moveBlock', targetId: 'paragraph-1', afterId: '<anchor-block-id>' },
    moveToBeginning: { op: 'moveBlock', targetId: 'paragraph-1', afterId: null },
    remove: { op: 'removeBlock', targetId: 'paragraph-1' },
  })
  const chartTarget = await andocEditLocate(documentPath, 'Two equal bars representing human and agent access') as {
    matches: Array<{ chartDataOperationTemplate: Record<string, unknown> }>
  }
  assert.deepEqual(chartTarget.matches[0]?.chartDataOperationTemplate, {
    op: 'updateChartData',
    targetId: 'chart-1',
    data: { columns: ['<column name>'], rows: [['<value>']] },
    evidence: { method: 'human-provided', source: '<source description>', verified: true },
  })

  const opened = await andocOpen(documentPath) as { documentId: string; blockCount: number; cached: boolean }
  assert.deepEqual(opened, {
    documentId: 'agn-sample',
    revision: 0,
    title: 'AGN Sample',
    blockCount: 4,
    assetCount: 0,
    cached: true,
    sourceBaseline: {
      status: 'UNVERIFIED_SOURCE',
      evidencePresent: false,
      registered: false,
      trusted: false,
      cryptographicallyValid: false,
      sourceMatches: false,
      issuerVerified: false,
      statement: 'No organizational source baseline has been registered.',
      agentGuidance: 'Treat the retained file as an unverified imported source. Do not call it authentic, original, authoritative, or issuer-verified.',
    },
  })

  const query = await andocQuery(documentPath, 'What structured source does the agent use for transactions?') as {
    matches: Array<{ evidence: Array<{ nodeId: string; text: string; citation: string }> }>
  }
  const evidence = query.matches[0]?.evidence || []
  assert.ok(evidence.some(node => node.nodeId === 'cell-agent'))
  assert.ok(evidence.some(node => node.nodeId === 'cell-agent-source' && node.text === 'Structured blocks and transactions'))
  assert.match(evidence.find(node => node.nodeId === 'cell-agent-source')!.citation, /table-1\/cells\/cell-agent-source$/)

  const adaptiveFull = await andocReadAdaptive(documentPath, { maximumTokens: 8_000 }) as {
    strategy: string
    fullContextEligible: boolean
    nodeIdsInline: boolean
    nodes: Array<{ nodeId: string; citation: string; block: { id: string } }>
  }
  assert.equal(adaptiveFull.strategy, 'full-canonical')
  assert.equal(adaptiveFull.fullContextEligible, true)
  assert.equal(adaptiveFull.nodeIdsInline, true)
  assert.deepEqual(adaptiveFull.nodes.map(node => node.nodeId), ['heading-1', 'paragraph-1', 'table-1', 'chart-1'])
  assert.ok(adaptiveFull.nodes.every(node => node.block.id === node.nodeId && node.citation.startsWith('anx://')))

  const adaptiveBounded = await andocReadAdaptive(documentPath, { maximumTokens: 512, estimatedCharactersPerToken: 2, query: 'structured source for transactions' }) as {
    strategy: string
    fullContextEligible: boolean
    retrieval: { matches: Array<{ evidence: Array<{ nodeId: string }> }> }
  }
  assert.equal(adaptiveBounded.strategy, 'bounded-retrieval')
  assert.equal(adaptiveBounded.fullContextEligible, false)
  assert.ok(adaptiveBounded.retrieval.matches.flatMap(match => match.evidence).some(node => node.nodeId === 'cell-agent-source'))

  const batch = await andocGetBatch(documentPath, ['paragraph-1', 'cell-agent-source']) as {
    nodes: Array<{ nodeId: string; text: string; citation: string }>
  }
  assert.deepEqual(batch.nodes.map(node => node.nodeId), ['paragraph-1', 'cell-agent-source'])
  assert.match(batch.nodes[0]!.text, /stable node IDs/)
  assert.equal(batch.nodes[1]!.text, 'Structured blocks and transactions')

  const context = await andocContext(documentPath, 'cell-agent-source', 1, 1) as {
    anchor: { nodeId: string; text: string }
    context: Array<{ nodeId: string }>
  }
  assert.equal(context.anchor.nodeId, 'cell-agent-source')
  assert.match(context.anchor.text, /Structured blocks and transactions/)
  assert.deepEqual(context.context.map(node => node.nodeId), ['paragraph-1', 'chart-1'])

  const operations = [{ op: 'updateTableCell' as const, tableId: 'table-1', cellId: 'cell-agent-source', content: [{ text: 'Targeted tools and transactions' }] }]
  const preview = await andocPreview(documentPath, operations, { actorId: 'benchmark-agent', message: 'Preview targeted edit' }) as { baseRevision: number; resultingRevision: number; changes: Array<{ targetId: string }> }
  assert.equal(preview.baseRevision, 0)
  assert.equal(preview.resultingRevision, 1)
  assert.equal(preview.changes[0]?.targetId, 'cell-agent-source')

  const applied = await andocApply(documentPath, operations, { actorId: 'benchmark-agent', message: 'Apply targeted edit' }) as { revision: number }
  assert.equal(applied.revision, 1)
  assert.equal((await readAndoc(documentPath)).document.revision, 1)

  const inserted = await andocInsertImage(documentPath, path.join(fixtureRoot, 'pdf-media-chart.png'), 'Agent-added validation chart', { actorId: 'benchmark-agent' }) as { revision: number; asset: { id: string; sha256: string } }
  assert.equal(inserted.revision, 2)
  const withImage = await readAndoc(documentPath)
  assert.equal(withImage.document.blocks.at(-1)?.type, 'image')
  assert.deepEqual(withImage.files[withImage.document.assets[inserted.asset.id]!.packagePath], withImage.files[withImage.document.assets[inserted.asset.id]!.packagePath])

  const pdfPath = path.join(root, 'agent-experience.pdf')
  const exported = await andocExportPdf(documentPath, pdfPath) as { revision: number; pages: number }
  assert.equal(exported.revision, 2)
  assert(exported.pages >= 1)
  assert((await readFile(pdfPath)).length > 500)
})

test('PDF agent reads disclose page and node text legibility by default', async () => {
  const documentPath = path.join(workspaceRoot, 'examples/pdf-media-fixture.agn')
  const opened = await andocOpen(documentPath) as {
    textQuality: { pages: Array<{ page: number; state: string }> }
  }
  assert.deepEqual(opened.textQuality.pages, [
    { page: 1, state: 'native-clean' },
    { page: 2, state: 'native-clean' },
  ])

  const outline = await andocOutline(documentPath) as {
    blocks: Array<{ page?: number; textQuality: string }>
  }
  assert.ok(outline.blocks.every(block => !block.page || block.textQuality === 'native-clean'))

  const query = await andocQuery(documentPath, 'What does the chart retain?') as {
    matches: Array<{ evidence: Array<{ textQuality: string }> }>
  }
  assert.ok(query.matches.flatMap(match => match.evidence).every(node => node.textQuality === 'native-clean'))
})

test('agent apply commits a multi-operation batch as one revision and exposes a complete inverse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-agent-multi-operation-'))
  const original = await fixtureDocument()
  const documentPath = path.join(root, 'multi-operation.agn')
  await writeFile(documentPath, await packAndoc({ document: original }))
  const operations: AndocOperation[] = [
    { op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'One atomic human and agent document.' }] },
    { op: 'updateTableCell', tableId: 'table-1', cellId: 'cell-agent-source', content: [{ text: 'Revision-pinned atomic operations' }] },
    { op: 'moveBlock', targetId: 'chart-1', afterId: 'heading-1' },
  ]

  const preview = await andocPreview(documentPath, operations, {
    actorId: 'batch-agent',
    baseRevision: 0,
    includeInverse: true,
    message: 'Preview one atomic three-operation edit',
  }) as { baseRevision: number; resultingRevision: number; changes: unknown[]; inverseOperations: AndocOperation[] }
  assert.equal(preview.baseRevision, 0)
  assert.equal(preview.resultingRevision, 1)
  assert.equal(preview.changes.length, 3)
  assert.equal(preview.inverseOperations.length, 3)

  const applied = await andocApply(documentPath, operations, {
    actorId: 'batch-agent',
    baseRevision: 0,
    includeInverse: true,
    message: 'Apply one atomic three-operation edit',
  }) as { baseRevision: number; revision: number; inverseOperations: AndocOperation[] }
  assert.equal(applied.baseRevision, 0)
  assert.equal(applied.revision, 1)

  const committed = await readAndoc(documentPath)
  assert.equal(committed.transactions.length, 1)
  assert.equal(committed.transactions[0]?.operations.length, 3)
  assert.deepEqual(committed.document.blocks.map(block => block.id), ['heading-1', 'chart-1', 'paragraph-1', 'table-1'])

  const undone = await andocApply(documentPath, applied.inverseOperations, {
    actorId: 'batch-agent',
    baseRevision: 1,
    message: 'Undo the entire atomic batch',
  }) as { revision: number }
  assert.equal(undone.revision, 2)
  assert.deepEqual((await readAndoc(documentPath)).document.blocks, original.blocks)
})

test('agent apply leaves the package byte-for-byte unchanged when a later batch operation is invalid', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-agent-atomic-failure-'))
  const documentPath = path.join(root, 'atomic-failure.agn')
  await writeFile(documentPath, await packAndoc({ document: await fixtureDocument() }))
  const before = await readFile(documentPath)

  await assert.rejects(andocApply(documentPath, [
    { op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'This must never be committed.' }] },
    { op: 'removeBlock', targetId: 'missing-block' },
  ], { actorId: 'batch-agent', baseRevision: 0 }), /Block not found: missing-block/)

  assert.deepEqual(await readFile(documentPath), before)
  assert.equal((await readAndoc(documentPath)).document.revision, 0)
})

test('concurrent human-server and agent edits from one revision produce one winner and one structured conflict', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-human-agent-conflict-'))
  const importsDirectory = path.join(root, 'artifacts/imports')
  await mkdir(importsDirectory, { recursive: true })
  const documentId = 'pdf-aaaaaaaaaaaaaaaaaaaaaaaa'
  const documentPath = path.join(importsDirectory, `${documentId}.agn`)
  await writeFile(documentPath, await packAndoc({ document: await fixtureDocument() }))
  const humanPromise = runHumanTransactionWorker(documentPath)
  const agentPromise = andocApply(documentPath, [
    { op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Agent won the race' }] },
  ], { actorId: 'concurrent-agent', baseRevision: 0, message: 'Concurrent agent paragraph edit' })

  const [human, agent] = await Promise.allSettled([humanPromise, agentPromise])
  assert.equal(human.status, 'fulfilled')
  const humanResult = human.value
  const humanWon = humanResult.ok === true
  const agentWon = agent.status === 'fulfilled'
  assert.notEqual(humanWon, agentWon, 'exactly one concurrent writer must commit')
  if (!humanWon) {
    assert.equal(humanResult.code, 'REVISION_CONFLICT')
    assert.equal(humanResult.currentRevision, 1)
    assert.equal(humanResult.baseRevision, 0)
  }
  if (!agentWon) {
    assert.ok(agent.reason instanceof RevisionConflictError)
    assert.equal(agent.reason.currentRevision, 1)
    assert.equal(agent.reason.baseRevision, 0)
  }

  const final = await readAndoc(documentPath)
  assert.equal(final.document.revision, 1)
  assert.equal(final.transactions.length, 1)
  assert.equal(final.transactions[0]?.actor.type, humanWon ? 'human' : 'agent')
  await assert.rejects(stat(`${documentPath}.lock`), /ENOENT/)
})

test('same-node conflict review preserves latest and proposed values for explicit resolution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-conflict-review-'))
  const documentPath = path.join(root, 'conflict-review.agn')
  await writeFile(documentPath, await packAndoc({ document: await fixtureDocument() }))
  await andocApply(documentPath, [
    { op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Agent latest value' }] },
  ], { actorId: 'conflict-agent', baseRevision: 0, message: 'Agent changed the shared paragraph' })
  const current = await readAndoc(documentPath)
  const attempted = {
    schema: 'andoc.transaction.v1' as const,
    id: 'tx-human-stale-proposal',
    baseRevision: 0,
    actor: { type: 'human' as const, id: 'human-reviewer' },
    timestamp: '2026-07-17T12:30:00.000Z',
    message: 'Human proposed a competing paragraph value',
    operations: [{ op: 'updateTextBlock' as const, targetId: 'paragraph-1', content: [{ text: 'Human proposed value' }] }],
  }
  const review = buildConflictReview(current.document, current.transactions, attempted)
  assert.equal(review.schema, 'andoc.conflict-review.v1')
  assert.equal(review.baseRevision, 0)
  assert.equal(review.currentRevision, 1)
  assert.deepEqual(review.allowedResolutions, ['keep-latest', 'apply-proposal', 'revise-manually'])
  assert.equal(review.interveningTransactions[0]?.actor.type, 'agent')
  assert.deepEqual(review.proposals[0]?.overlappingTargetIds, ['paragraph-1'])
  assert.equal(review.proposals[0]?.overlapsInterveningChange, true)
  assert.deepEqual(review.proposals[0]?.currentValue, { id: 'paragraph-1', type: 'paragraph', text: 'Agent latest value' })
  assert.deepEqual(review.proposals[0]?.proposedValue, { text: 'Human proposed value' })
})

test('agent search normalizes Unicode and repeated whitespace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-agent-search-normalization-'))
  const document = JSON.parse(await readFile(path.join(fixtureRoot, 'sample.document.json'), 'utf8')) as AndocDocument
  const paragraph = document.blocks.find(block => block.type === 'paragraph')
  assert(paragraph?.type === 'paragraph')
  paragraph.content = [{ text: 'Core loans grew at a 2.2\u00a0percent   annualized rate.' }]
  const documentPath = path.join(root, 'normalized-search.agn')
  await writeFile(documentPath, await packAndoc({ document }))

  const search = await andocSearch(documentPath, '2.2 percent annualized rate') as { matches: Array<{ nodeId: string; excerpt: string }> }
  assert.equal(search.matches[0]?.nodeId, paragraph.id)
  assert.match(search.matches[0]!.excerpt, /2\.2 percent annualized rate/)
})

test('agent search ranks partial question terms and preserves original text casing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-agent-ranked-search-'))
  const document = JSON.parse(await readFile(path.join(fixtureRoot, 'sample.document.json'), 'utf8')) as AndocDocument
  const documentPath = path.join(root, 'ranked-search.agn')
  await writeFile(documentPath, await packAndoc({ document }))

  const search = await andocSearch(documentPath, 'Which canonical structure keeps stable transaction identifiers?') as {
    matches: Array<{ nodeId: string; excerpt: string; score: number }>
  }
  assert.equal(search.matches[0]?.nodeId, 'paragraph-1')
  assert.match(search.matches[0]!.excerpt, /One canonical document/)
  assert.ok(search.matches[0]!.score > 0)
})

test('answer-ready query diversifies labelled endpoints and prioritizes numeric comparison evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-agent-answer-ready-'))
  const document = JSON.parse(await readFile(path.join(fixtureRoot, 'sample.document.json'), 'utf8')) as AndocDocument
  document.blocks = [
    { id: 'trl-summary', type: 'paragraph', content: [{ text: 'The report interprets technology readiness levels and discusses the endpoints.' }] },
    { id: 'trl-1', type: 'paragraph', content: [{ text: 'TRL 1: Basic principles observed.' }] },
    { id: 'trl-9', type: 'paragraph', content: [{ text: 'TRL 9: Actual system proven in operational environment.' }] },
    { id: 'trl-example', type: 'paragraph', content: [{ text: 'A lengthy operational example discusses readiness and notes that one specialized system happened to reach TRL 9.' }] },
    { id: 'comparison-summary', type: 'paragraph', content: [{ text: 'School-district and charter-school TK teachers generally meet the additional requirements; 9 percent and 17 percent do not meet them.' }] },
    { id: 'comparison-detail', type: 'paragraph', content: [{ text: 'School districts reported 47 of 504 TK teachers did not meet requirements (9 percent) and 457 met them (91 percent); charter schools reported 39 of 235 did not meet them (17 percent) and 196 met them (83 percent).' }] },
    { id: 'characteristics-lead-in', type: 'paragraph', content: [{ text: 'Characteristics of trustworthy systems include' }] },
    { id: 'characteristics-answer', type: 'paragraph', content: [{ text: 'valid and reliable, safe, secure and resilient.' }] },
  ]
  const documentPath = path.join(root, 'answer-ready.agn')
  await writeFile(documentPath, await packAndoc({ document }))

  const endpoints = await andocQuery(documentPath, 'What do the endpoints TRL 1 and TRL 9 represent?', { limit: 3 }) as {
    matches: Array<{ evidence: Array<{ nodeId: string }> }>
  }
  const endpointIds = endpoints.matches.flatMap(match => match.evidence.map(node => node.nodeId))
  assert.ok(endpointIds.includes('trl-1'))
  assert.ok(endpointIds.includes('trl-9'))
  assert.equal(endpoints.matches[0]?.evidence[0]?.nodeId, 'trl-1')
  assert.equal(endpoints.matches[1]?.evidence[0]?.nodeId, 'trl-9')

  const comparison = await andocQuery(documentPath, 'Compare school-district and charter-school TK teachers meeting versus not meeting the additional requirements.', { limit: 3 }) as {
    matches: Array<{ evidence: Array<{ nodeId: string }> }>
  }
  assert.equal(comparison.matches[0]?.evidence[0]?.nodeId, 'comparison-detail')

  const characteristics = await andocQuery(documentPath, 'List the characteristics of trustworthy systems.', { limit: 2 }) as {
    matches: Array<{ evidence: Array<{ nodeId: string; evidenceRole: string }> }>
  }
  assert.deepEqual(characteristics.matches[0]?.evidence.map(node => [node.nodeId, node.evidenceRole]), [
    ['characteristics-lead-in', 'lead-in'],
    ['characteristics-answer', 'answer'],
  ])
})
