import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib'
import { decodePDFRawStream } from 'pdf-lib/cjs/core/streams/decode.js'
import {
  applyTransaction,
  exportAndocPdf,
  packAndoc,
  renderAndocPdf,
  type AndocDocument,
  type AndocTransaction,
} from '../src/index.js'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures')

async function sampleDocument(): Promise<AndocDocument> {
  return JSON.parse(await readFile(path.join(fixtureRoot, 'sample.document.json'), 'utf8')) as AndocDocument
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodedPageContent(document: PDFDocument, pageIndex: number): string {
  const contents = document.getPages()[pageIndex]?.node.Contents()
  assert(contents instanceof PDFArray)
  return contents.asArray().map(reference => {
    const stream = document.context.lookup(reference)
    assert(stream instanceof PDFRawStream)
    return new TextDecoder().decode(decodePDFRawStream(stream).decode())
  }).join('\n')
}

test('PDF export is deterministic and derived from the current canonical revision', async () => {
  const document = await sampleDocument()
  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: 'tx-export-chart-data-001',
    baseRevision: 0,
    actor: { type: 'agent', id: 'andoc-product-engineer' },
    timestamp: '2026-07-15T19:10:00.000Z',
    operations: [{
      op: 'updateChartData',
      targetId: 'chart-1',
      data: { columns: ['Surface', 'Score'], rows: [['Human', 1], ['Agent', 1]] },
      evidence: { method: 'agent-provided', source: 'controlled-fixture-labels', verified: true, confidence: 1 },
    }],
  }
  const next = applyTransaction(document, transaction)
  const packageBytes = await packAndoc({ document: next, transactions: [transaction] })
  const first = await exportAndocPdf(packageBytes)
  const second = await exportAndocPdf(packageBytes)
  const direct = await renderAndocPdf({ document: next })

  assert.equal(hash(first.bytes), hash(second.bytes))
  assert.equal(new TextDecoder().decode(first.bytes.slice(0, 8)), '%PDF-1.7')
  assert.equal(first.revision, 1)
  assert(first.pageCount >= 1)
  assert.equal((await PDFDocument.load(first.bytes)).getPageCount(), first.pageCount)
  assert.equal(direct.revision, 1)
})

test('PDF tables stay together when compact and repeat their header when continued', async () => {
  const base: Omit<AndocDocument, 'documentId' | 'title' | 'blocks'> = {
    schema: 'andoc.document.v1',
    revision: 4,
    locale: 'en-US',
    createdAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:00:00.000Z',
    metadata: {},
    assets: {},
  }
  const rows = (count: number) => [
    ['Metric', 'Baseline', 'Review status'].map((text, index) => ({ id: `header-${index}`, header: true, content: [{ text }] })),
    ...Array.from({ length: count }, (_, row) => [
      { id: `metric-${row}`, content: [{ text: `Metric ${row + 1}` }] },
      { id: `value-${row}`, content: [{ text: `Value ${row + 1}` }] },
      { id: `status-${row}`, content: [{ text: row % 2 ? 'Agent reviewed' : 'Ready' }] },
    ]),
  ]
  const compact = await renderAndocPdf({ document: {
    ...base,
    documentId: 'compact-table-pagination',
    title: 'Compact Table Pagination',
    blocks: [
      ...Array.from({ length: 22 }, (_, index) => ({ id: `paragraph-${index}`, type: 'paragraph' as const, content: [{ text: `Controlled introductory line ${index + 1}.` }] })),
      { id: 'compact-table', type: 'table', rows: rows(3) },
    ],
  } })
  const compactPdf = await PDFDocument.load(compact.bytes)
  assert.equal(compact.pageCount, 2)
  assert.doesNotMatch(decodedPageContent(compactPdf, 0), /<4D6574726963>/)
  assert.match(decodedPageContent(compactPdf, 1), /<4D6574726963>/)

  const long = await renderAndocPdf({ document: {
    ...base,
    documentId: 'long-table-pagination',
    title: 'Long Table Pagination',
    blocks: [{ id: 'long-table', type: 'table', rows: rows(70) }],
  } })
  const longPdf = await PDFDocument.load(long.bytes)
  assert(long.pageCount >= 3)
  for (let pageIndex = 0; pageIndex < long.pageCount; pageIndex += 1) {
    assert.match(decodedPageContent(longPdf, pageIndex), /<4D6574726963>/, `page ${pageIndex + 1} should repeat the table header`)
  }
})
