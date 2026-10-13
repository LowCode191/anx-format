import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import {
  applyTransaction,
  createImageAsset,
  packAndoc,
  previewTransaction,
  readAndoc,
  repackAndocPackage,
  RevisionConflictError,
  renderHtml,
  sha256,
  transactAndocPackage,
  unpackAndoc,
  validateAndoc,
  validateDocument,
  validateTransaction,
  type AndocDocument,
  type AndocTransaction,
} from '../src/index.js'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures')

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), 'utf8')) as T
}

test('sample canonical document validates', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  assert.deepEqual(validateDocument(document).issues, [])
})

test('lists, footnotes, and declared extension fallbacks round-trip as machine-readable canonical blocks', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  document.blocks.push(
    {
      id: 'list-1',
      type: 'list',
      ordered: true,
      start: 3,
      items: [{ id: 'list-item-1', content: [{ text: 'Primary item' }], children: [{ id: 'list-item-1-a', content: [{ text: 'Nested evidence' }] }] }],
    },
    {
      id: 'footnote-1',
      type: 'footnote',
      label: '1.',
      content: [{ text: 'Source-qualified note.' }],
      noteKind: 'footnote',
      anchorIds: ['paragraph-1'],
      anchorStatus: 'resolved',
    },
    {
      id: 'extension-1',
      type: 'extension',
      extensionId: 'andoc.extension.domain-example',
      version: '1.0',
      payload: { domainValue: 42 },
      fallback: [{ text: 'Portable fallback for readers without the extension.' }],
    },
  )
  const profiles = {
    schema: 'andoc.profiles.v1' as const,
    core: { id: 'andoc.profile.core-document', version: '1.0', required: true },
    profiles: [],
    extensions: [{ id: 'andoc.extension.domain-example', version: '1.0', required: false }],
  }

  await assert.rejects(() => packAndoc({ document }), /every extension block must have an exact profiles\/declaration\.json entry/)
  const bytes = await packAndoc({ document, profiles })
  const pkg = await readAndoc(bytes)
  assert.deepEqual(pkg.document.blocks.slice(-3), document.blocks.slice(-3))
  assert.equal(pkg.profiles?.extensions[0]?.id, 'andoc.extension.domain-example')
  const html = new TextDecoder().decode(pkg.files['views/document.html'])
  assert.match(html, /<ol class="andoc-list"[^>]* start="3">/)
  assert.match(html, /data-andoc-list-item-id="list-item-1-a"/)
  assert.match(html, /class="andoc-footnote"/)
  assert.match(html, /data-anx-note-kind="footnote"/)
  assert.match(html, /data-anx-anchor-status="resolved"/)
  assert.match(html, /data-anx-note-anchors="paragraph-1"/)
  assert.match(html, /Portable fallback for readers without the extension/)

  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: 'tx-preserve-unknown-extension',
    baseRevision: document.revision,
    actor: { type: 'agent', id: 'extension-unaware-editor' },
    timestamp: '2026-07-18T18:00:00.000Z',
    operations: [{ op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Unrelated canonical edit.' }] }],
  }
  const next = await transactAndocPackage(pkg, transaction)
  const nextPackage = await readAndoc(next.packageBytes)
  assert.deepEqual(nextPackage.document.blocks.find(block => block.id === 'extension-1'), document.blocks.find(block => block.id === 'extension-1'))
  assert.deepEqual(nextPackage.profiles, profiles)
})

test('note anchors use the document-wide stable-node namespace and cannot resolve to themselves', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  document.blocks.push({
    id: 'endnote-1',
    type: 'footnote',
    label: 'A',
    content: [{ text: 'Supplemental release condition.' }],
    noteKind: 'endnote',
    anchorIds: ['missing-node', 'endnote-1'],
    anchorStatus: 'resolved',
  })
  const result = validateDocument(document)
  assert.equal(result.ok, false)
  assert(result.issues.some(issue => issue.code === 'missing_note_anchor'))
  assert(result.issues.some(issue => issue.code === 'self_anchored_note'))
})

test('nested list-item IDs share the document-wide stable-node namespace', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  document.blocks.push({ id: 'list-duplicate-test', type: 'list', ordered: false, items: [
    { id: 'nested-node', content: [{ text: 'One' }], children: [{ id: 'nested-node', content: [{ text: 'Duplicate' }] }] },
  ] })
  const result = validateDocument(document)
  assert.equal(result.ok, false)
  assert(result.issues.some(issue => issue.code === 'duplicate_list_item_id'))
})

test('human and agent edits use the same revisioned transaction path', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const transaction = await fixture<AndocTransaction>('sample.transaction.json')
  const next = applyTransaction(document, transaction)

  assert.equal(next.revision, 1)
  assert.equal(next.updatedAt, transaction.timestamp)
  assert.equal(next.metadata.lastEditor, 'andoc-product-engineer')
  assert.match(JSON.stringify(next.blocks), /same validated transaction path/)
  assert.equal(document.revision, 0, 'input is not mutated')
})

test('ANX package is deterministic, valid, and unpackable', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const first = await packAndoc({ document })
  const second = await packAndoc({ document })
  assert.equal(hash(first), hash(second))

  const validation = await validateAndoc(first)
  assert.equal(validation.ok, true, JSON.stringify(validation.issues))

  const directory = await mkdtemp(path.join(tmpdir(), 'andoc-test-'))
  const pkg = await unpackAndoc(first, directory)
  assert.equal(pkg.document.title, 'AGN Sample')
  assert.match(await readFile(path.join(directory, 'views/document.html'), 'utf8'), /data-andoc-id="chart-1"/)
  assert.equal(await readFile(path.join(directory, 'mimetype'), 'utf8'), 'application/anx+zip')
})

test('canonical .anx and legacy .anxd, .agn, and .andoc packages remain readable', async () => {
  for (const [fileName, mediaType] of [['sample.anx', 'application/anx+zip'], ['sample.anxd', 'application/anx+zip'], ['sample.agn', 'application/agn+zip'], ['sample.andoc', 'application/vnd.andoc+zip']] as const) {
    const legacyPath = path.join(import.meta.dirname, `../examples/${fileName}`)
    const validation = await validateAndoc(legacyPath)
    assert.equal(validation.ok, true, JSON.stringify(validation.issues))
    const pkg = await readAndoc(legacyPath)
    assert.equal(pkg.manifest.mediaType, mediaType)

    const migrated = await repackAndocPackage(pkg)
    const migratedValidation = await validateAndoc(migrated)
    assert.equal(migratedValidation.ok, true, JSON.stringify(migratedValidation.issues))
    assert.equal(migratedValidation.manifest?.mediaType, 'application/anx+zip')
  }
})

test('transaction can be persisted as package history', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const transaction = await fixture<AndocTransaction>('sample.transaction.json')
  const next = applyTransaction(document, transaction)
  const bytes = await packAndoc({ document: next, transactions: [transaction] })
  const pkg = await readAndoc(bytes)

  assert.equal(pkg.manifest.revision, 1)
  assert.equal(pkg.transactions[0]?.id, 'tx-agent-001')
})

test('semantic validation rejects a missing referenced asset', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  document.blocks.push({ id: 'image-1', type: 'image', assetId: 'asset-missing', alt: 'Missing' })
  const result = validateDocument(document)
  assert.equal(result.ok, false)
  assert(result.issues.some(issue => issue.code === 'missing_asset'))
})

test('stale human or agent edits are rejected before mutation', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const transaction = await fixture<AndocTransaction>('sample.transaction.json')
  transaction.baseRevision = 4
  assert.throws(() => applyTransaction(document, transaction), RevisionConflictError)
  assert.equal(document.revision, 0)
})

test('transaction preview rejects a stale revision before simulating operations', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const transaction = await fixture<AndocTransaction>('sample.transaction.json')
  document.revision = 2
  assert.throws(() => previewTransaction(document, transaction), RevisionConflictError)
})

test('targeted table-cell and media metadata operations preserve stable node identity', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: 'tx-agent-targeted-001',
    baseRevision: 0,
    actor: { type: 'agent', id: 'andoc-product-engineer' },
    timestamp: '2026-07-15T18:00:00.000Z',
    message: 'Update one table cell and chart metadata without replacing either block.',
    operations: [
      { op: 'updateTableCell', tableId: 'table-1', cellId: 'cell-agent-source', content: [{ text: 'Targeted structured transactions' }] },
      { op: 'updateMediaMetadata', targetId: 'chart-1', patch: { alt: 'Human and agent access remain equal', caption: [{ text: 'Agent-reviewed chart metadata' }] } },
    ],
  }

  const next = applyTransaction(document, transaction)
  const table = next.blocks.find(block => block.id === 'table-1')
  const chart = next.blocks.find(block => block.id === 'chart-1')
  assert.ok(table?.type === 'table')
  assert.ok(chart?.type === 'chart')
  const cell = table.rows.flat().find(candidate => candidate.id === 'cell-agent-source')
  assert.equal(cell?.content[0]?.text, 'Targeted structured transactions')
  assert.equal(cell?.provenance?.kind, 'agent')
  assert.equal(cell?.provenance?.sourceId, 'andoc-product-engineer')
  assert.equal(cell?.attrs?.lastEditedAt, transaction.timestamp)
  assert.equal(chart.alt, 'Human and agent access remain equal')
  assert.equal(chart.caption?.[0]?.text, 'Agent-reviewed chart metadata')
  assert.equal(chart.provenance?.kind, 'agent')
  const originalTable = document.blocks.find(block => block.id === 'table-1')
  assert.ok(originalTable?.type === 'table')
  assert.equal(originalTable.rows[2]?.[1]?.content[0]?.text, 'Structured blocks and transactions')
})

test('chart data enrichment is structured, evidence-bearing, and rendered for humans', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const originalChart = document.blocks.find(block => block.id === 'chart-1')
  assert.ok(originalChart?.type === 'chart')
  originalChart.provenance = { kind: 'imported', sourceId: 'fixture-chart', page: 1, confidence: 0.91 }
  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: 'tx-agent-chart-data-001',
    baseRevision: 0,
    actor: { type: 'agent', id: 'andoc-product-engineer' },
    timestamp: '2026-07-15T19:00:00.000Z',
    message: 'Attach verified structured values without replacing the chart block.',
    operations: [{
      op: 'updateChartData',
      targetId: 'chart-1',
      data: { columns: ['Surface', 'Score'], rows: [['Human', 1], ['Agent', 1]] },
      evidence: { method: 'agent-provided', source: 'controlled-fixture-labels', verified: true, confidence: 1, notes: 'Known fixture values.' },
    }],
  }

  const next = applyTransaction(document, transaction)
  const chart = next.blocks.find(block => block.id === 'chart-1')
  assert.ok(chart?.type === 'chart')
  assert.equal(chart.id, originalChart.id)
  assert.equal(chart.spec.schema, 'andoc.chart.v1')
  assert.equal(chart.spec.mark, 'bar', 'existing visual semantics are preserved')
  assert.deepEqual(chart.spec.data, { columns: ['Surface', 'Score'], rows: [['Human', 1], ['Agent', 1]] })
  assert.deepEqual(chart.attrs?.sourceProvenance, originalChart.provenance)
  assert.equal((chart.spec.extraction as Record<string, unknown>).status, 'verified-structured-data')
  assert.equal(chart.provenance?.kind, 'agent')
  assert.match(renderHtml(next), /Verified structured data/)
  assert.match(renderHtml(next), /controlled-fixture-labels/)
  assert.match(renderHtml(next), /<th scope="col">Surface<\/th>/)

  const invalid = structuredClone(transaction)
  invalid.operations = [{
    op: 'updateChartData',
    targetId: 'chart-1',
    data: { columns: ['Month', 'Value'], rows: [['January']] },
    evidence: { method: 'human-provided', source: 'local-human-editor', verified: false },
  }]
  const validation = validateTransaction(invalid)
  assert.equal(validation.ok, false)
  assert(validation.issues.some(issue => issue.code === 'invalid_chart_data' && /expected 2/.test(issue.message)))
})

test('derived views suppress duplicate titles and stale table snapshots', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const first = document.blocks[0]
  assert.ok(first?.type === 'heading')
  document.title = first.content.map(run => run.text).join('')
  const table = document.blocks.find(block => block.type === 'table')
  assert.ok(table?.type === 'table')
  table.provenance = { kind: 'imported', sourceId: 'fixture', page: 2, bbox: [10, 20, 300, 400] }
  document.assets['asset-table-snapshot'] = {
    id: 'asset-table-snapshot',
    packagePath: 'assets/table-snapshot.png',
    mediaType: 'image/png',
    sha256: '0'.repeat(64),
    size: 0,
  }
  document.blocks.push({
    id: 'image-table-snapshot',
    type: 'image',
    assetId: 'asset-table-snapshot',
    alt: 'Stale raster table snapshot',
    attrs: { pictureClassification: { className: 'table', confidence: 1 } },
    provenance: { kind: 'imported', sourceId: 'fixture', page: 2, bbox: [10, 20, 300, 400] },
  })

  const html = renderHtml(document)
  assert.doesNotMatch(html, new RegExp(`data-andoc-id="${first.id}"`))
  assert.match(html, new RegExp(`<h1 id="andoc-document-title">${document.title}</h1>`))
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1)
  assert.doesNotMatch(html, /image-table-snapshot/)
  assert.match(html, new RegExp(`data-andoc-id="${table.id}"`))
})

test('structural edits preserve stable nodes and produce an auditable inverse', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: 'tx-human-structural-001',
    baseRevision: 0,
    actor: { type: 'human', id: 'local-human-editor' },
    timestamp: '2026-07-15T21:30:00.000Z',
    message: 'Move a block, retain rich text, and expand the semantic table.',
    operations: [
      { op: 'moveBlock', targetId: 'chart-1', afterId: 'heading-1' },
      { op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Human ', marks: ['bold'] }, { text: 'and agent', href: 'https://andoc.dev' }] },
      {
        op: 'insertTableRow',
        tableId: 'table-1',
        afterRowIndex: 2,
        cells: [
          { id: 'cell-system', content: [{ text: 'System' }] },
          { id: 'cell-system-source', content: [{ text: 'Canonical operations' }] },
        ],
      },
      {
        op: 'insertTableColumn',
        tableId: 'table-1',
        afterColumnIndex: 1,
        cells: [
          { id: 'cell-status-header', header: true, content: [{ text: 'Status' }] },
          { id: 'cell-human-status', content: [{ text: 'Ready' }] },
          { id: 'cell-agent-status', content: [{ text: 'Ready' }] },
          { id: 'cell-system-status', content: [{ text: 'Ready' }] },
        ],
      },
    ],
  }

  const preview = previewTransaction(document, transaction)
  assert.equal(preview.document.revision, 1)
  assert.deepEqual(preview.document.blocks.map(block => block.id), ['heading-1', 'chart-1', 'paragraph-1', 'table-1'])
  const paragraph = preview.document.blocks.find(block => block.id === 'paragraph-1')
  assert.ok(paragraph?.type === 'paragraph')
  assert.deepEqual(paragraph.content, transaction.operations[1] && transaction.operations[1].op === 'updateTextBlock' ? transaction.operations[1].content : [])
  const table = preview.document.blocks.find(block => block.id === 'table-1')
  assert.ok(table?.type === 'table')
  assert.equal(table.rows.length, 4)
  assert(table.rows.every(row => row.length === 3))
  assert.equal(table.rows[3]?.[2]?.id, 'cell-system-status')
  assert.equal(preview.changes.length, 4)

  const undone = applyTransaction(preview.document, {
    schema: 'andoc.transaction.v1',
    id: 'tx-human-undo-001',
    baseRevision: 1,
    actor: { type: 'human', id: 'local-human-editor' },
    timestamp: '2026-07-15T21:31:00.000Z',
    message: 'Undo the structural edit.',
    operations: preview.inverseOperations,
  })
  assert.deepEqual(undone.blocks, document.blocks)
  assert.equal(undone.revision, 2)
})

test('table row and column removal is bounded and rejects spanned tables', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const removed = applyTransaction(document, {
    schema: 'andoc.transaction.v1',
    id: 'tx-agent-table-structure-001',
    baseRevision: 0,
    actor: { type: 'agent', id: 'andoc-product-engineer' },
    timestamp: '2026-07-15T21:32:00.000Z',
    operations: [
      { op: 'removeTableRow', tableId: 'table-1', rowIndex: 2 },
      { op: 'removeTableColumn', tableId: 'table-1', columnIndex: 1 },
    ],
  })
  const table = removed.blocks.find(block => block.id === 'table-1')
  assert.ok(table?.type === 'table')
  assert.equal(table.rows.length, 2)
  assert(table.rows.every(row => row.length === 1))

  const spanned = await fixture<AndocDocument>('sample.document.json')
  const spannedTable = spanned.blocks.find(block => block.id === 'table-1')
  assert.ok(spannedTable?.type === 'table')
  spannedTable.rows[0]![0]!.colspan = 2
  assert.throws(() => applyTransaction(spanned, {
    schema: 'andoc.transaction.v1',
    id: 'tx-agent-spanned-table-001',
    baseRevision: 0,
    actor: { type: 'agent', id: 'andoc-product-engineer' },
    timestamp: '2026-07-15T21:33:00.000Z',
    operations: [{ op: 'removeTableRow', tableId: 'table-1', rowIndex: 1 }],
  }), /spanned table cells/)
})

test('semantic validation rejects duplicate table-cell IDs', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const table = document.blocks.find(block => block.id === 'table-1')
  assert.ok(table?.type === 'table')
  table.rows[1]![1]!.id = table.rows[1]![0]!.id
  const result = validateDocument(document)
  assert.equal(result.ok, false)
  assert(result.issues.some(issue => issue.code === 'duplicate_cell_id'))
})

test('asset bytes, media type, and rendered package path stay aligned', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const bytes = strToU8('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  document.assets.logo = {
    id: 'logo',
    packagePath: 'assets/logo.svg',
    mediaType: 'image/svg+xml',
    sha256: sha256(bytes),
    size: bytes.length,
  }
  document.blocks.push({ id: 'image-logo', type: 'image', assetId: 'logo', alt: 'ANDoc logo' })
  const pkg = await readAndoc(await packAndoc({ document, assets: { logo: bytes } }))
  const html = new TextDecoder().decode(pkg.files['views/document.html'])
  assert.match(html, /src="\.\.\/assets\/logo\.svg"/)
  assert.equal(pkg.manifest.entries.find(entry => entry.path === 'assets/logo.svg')?.mediaType, 'image/svg+xml')
})

test('image assets and blocks are added atomically and remain undo-redo safe', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const before = await readAndoc(await packAndoc({ document }))
  const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
  const asset = createImageAsset(imageBytes, { mediaType: 'image/png', originalName: 'diagram.png', description: 'System diagram' })
  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: 'tx-human-add-image-001',
    baseRevision: 0,
    actor: { type: 'human', id: 'local-human-editor' },
    timestamp: '2026-07-15T22:00:00.000Z',
    operations: [
      { op: 'addAsset', asset },
      { op: 'insertBlocks', afterId: document.blocks.at(-1)?.id || null, blocks: [{ id: 'image-human-001', type: 'image', assetId: asset.id, alt: 'System diagram' }] },
    ],
  }
  const preview = previewTransaction(document, transaction)
  assert.deepEqual(preview.inverseOperations, [{ op: 'removeBlock', targetId: 'image-human-001' }])

  const added = await transactAndocPackage(before, transaction, { [asset.id]: imageBytes })
  const addedPackage = await readAndoc(added.packageBytes)
  assert.deepEqual(addedPackage.files[asset.packagePath], imageBytes)
  assert.equal(addedPackage.document.blocks.at(-1)?.id, 'image-human-001')

  const undone = await transactAndocPackage(addedPackage, {
    ...transaction,
    id: 'tx-human-undo-image-001',
    baseRevision: 1,
    timestamp: '2026-07-15T22:01:00.000Z',
    operations: preview.inverseOperations,
  })
  const undonePackage = await readAndoc(undone.packageBytes)
  assert.equal(undone.document.blocks.some(block => block.id === 'image-human-001'), false)
  assert.deepEqual(undonePackage.files[asset.packagePath], imageBytes, 'immutable orphan bytes are retained for redo')

  const redone = await transactAndocPackage(undonePackage, {
    ...transaction,
    id: 'tx-human-redo-image-001',
    baseRevision: 2,
    timestamp: '2026-07-15T22:02:00.000Z',
  })
  assert.equal(redone.document.blocks.at(-1)?.id, 'image-human-001')
})

test('tampering and unsafe package paths are reported', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const files = unzipSync(await packAndoc({ document }))
  files['views/document.html'] = strToU8('tampered')
  let result = await validateAndoc(zipSync(files))
  assert(result.issues.some(issue => issue.code === 'hash_mismatch'))

  files['../escape.txt'] = strToU8('blocked')
  result = await validateAndoc(zipSync(files))
  assert(result.issues.some(issue => issue.code === 'unsafe_path'))
})

test('ZIP preflight rejects oversized expansion declarations and encryption before decompression', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  const original = await packAndoc({ document })
  const centralOffset = findZipSignature(original, 0x02014b50)
  assert(centralOffset >= 0)

  const oversized = original.slice()
  new DataView(oversized.buffer, oversized.byteOffset, oversized.byteLength).setUint32(centralOffset + 24, 65 * 1024 * 1024, true)
  let result = await validateAndoc(oversized)
  assert(result.issues.some(issue => issue.code === 'invalid_zip' && /expanded entry limit/.test(issue.message)))

  const encrypted = original.slice()
  const encryptedView = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength)
  encryptedView.setUint16(centralOffset + 8, encryptedView.getUint16(centralOffset + 8, true) | 0x1, true)
  result = await validateAndoc(encrypted)
  assert(result.issues.some(issue => issue.code === 'invalid_zip' && /Encrypted ZIP entries/.test(issue.message)))
})

test('human HTML is accessible by construction and suppresses unsafe link schemes', async () => {
  const document = await fixture<AndocDocument>('sample.document.json')
  document.blocks.push({ id: 'paragraph-unsafe-link', type: 'paragraph', content: [{ text: 'Do not execute', href: 'javascript:alert(1)' }] })
  const html = renderHtml(document)
  assert.match(html, /<body role="document"/)
  assert.match(html, /<h1 id="andoc-document-title">/)
  assert.match(html, /<main aria-labelledby="andoc-document-title">/)
  assert.match(html, /<caption>Machine-readable table<\/caption>/)
  assert.doesNotMatch(html, /javascript:/)
  assert.match(html, />Do not execute</)

  document.blocks.push({ id: 'image-empty-alt', type: 'image', assetId: 'missing', alt: '' })
  const validation = validateDocument(document)
  assert(validation.issues.some(issue => issue.code === 'schema_minLength' && issue.path.endsWith('/alt')))
})

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function findZipSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset
  }
  return -1
}
