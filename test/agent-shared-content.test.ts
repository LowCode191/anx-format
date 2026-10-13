import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ANDOC_DOCUMENT_SCHEMA,
  agentContentProjection,
  agentSharedContentIndex,
  andocGet,
  andocQuery,
  andocReadAdaptive,
  andocSearch,
  andocSharedContent,
  normalizeDoclingDocument,
  packAndoc,
  type AndocDocument,
  type AnxSharedContentIndex,
  type DoclingDocument,
} from '../src/index.js'

const disclaimer = 'CONFIDENTIAL — This report is provided solely for the authorized recipient and may not be redistributed without written permission.'
const disclaimerVariant = 'CONFIDENTIAL — This report is provided solely for the authorized recipient and may be redistributed with written permission.'

function repeatedDocument(): AndocDocument {
  const blocks: AndocDocument['blocks'] = [{
    id: 'heading-main',
    type: 'heading',
    level: 1,
    content: [{ text: 'Quarterly analysis' }],
    provenance: { kind: 'imported', page: 1, sourceUri: 'sources/original/report.pdf' },
  }]
  for (let page = 1; page <= 5; page += 1) {
    blocks.push({
      id: `disclaimer-${page}`,
      type: 'paragraph',
      content: [{ text: page === 3 ? disclaimer.replace('report is', 'report\nis') : disclaimer }],
      provenance: {
        kind: 'imported',
        page,
        sourceUri: 'sources/original/report.pdf',
        bbox: [40, 20, 560, 45],
      },
    })
    blocks.push({
      id: `body-${page}`,
      type: 'paragraph',
      content: [{ text: `Unique operating result for page ${page}: ${page * 17} units.` }],
      provenance: { kind: 'imported', page, sourceUri: 'sources/original/report.pdf' },
    })
  }
  blocks.push({
    id: 'disclaimer-variant',
    type: 'paragraph',
    content: [{ text: disclaimerVariant }],
    provenance: { kind: 'imported', page: 6, sourceUri: 'sources/original/report.pdf' },
  })
  return {
    schema: ANDOC_DOCUMENT_SCHEMA,
    documentId: 'pdf-shared-content-test',
    revision: 0,
    title: 'Quarterly analysis',
    locale: 'en-US',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    metadata: {},
    assets: {},
    blocks,
  }
}

test('agent projection stores exact repeated canonical text once while preserving every canonical occurrence', async () => {
  const document = repeatedDocument()
  const original = structuredClone(document)
  const index = agentSharedContentIndex(document, { expandOccurrences: true })
  assert.equal(index.groups.length, 1)
  assert.equal(index.groups[0]?.text, disclaimer)
  assert.equal(index.groups[0]?.occurrenceCount, 5)
  assert.deepEqual(index.groups[0]?.pageRanges, ['1-5'])
  assert.deepEqual(index.groups[0]?.occurrences?.map(occurrence => occurrence.nodeId), [
    'disclaimer-1',
    'disclaimer-2',
    'disclaimer-3',
    'disclaimer-4',
    'disclaimer-5',
  ])
  assert.equal(index.groups[0]?.matchPolicy, 'whitespace-normalized-exact')
  assert.equal(index.groups.some(group => group.text === disclaimerVariant), false)
  assert.deepEqual(document, original, 'projection must never rewrite canonical blocks')

  const projection = agentContentProjection(document)
  assert.equal(projection.sharedContentGroupCount, 1)
  assert.equal(projection.compactedOccurrenceCount, 5)
  assert.equal(projection.nodes.some(node => node.nodeId.startsWith('disclaimer-') && node.nodeId !== 'disclaimer-variant'), false)
  assert.equal(projection.nodes.some(node => node.nodeId === 'disclaimer-variant'), true)

  const root = await mkdtemp(path.join(tmpdir(), 'anx-shared-content-'))
  const documentPath = path.join(root, 'shared-content.anx')
  await writeFile(documentPath, await packAndoc({ document }))
  const read = await andocReadAdaptive(documentPath, { maximumTokens: 100_000 }) as {
    strategy: string
    budget: { estimatedCanonicalTokens: number; estimatedProjectedTokens: number; estimatedTokenSavings: number }
    canonicalBlocks: number
    returnedBlocks: number
    sharedContent: Array<{ id: string; text: string; occurrenceCount: number }>
    nodes: Array<{ nodeId: string }>
  }
  assert.equal(read.strategy, 'full-structured-deduplicated')
  assert.equal(read.canonicalBlocks, document.blocks.length)
  assert.equal(read.returnedBlocks, document.blocks.length - 5)
  assert.equal(read.sharedContent[0]?.text, disclaimer)
  assert.equal(read.sharedContent[0]?.occurrenceCount, 5)
  assert.ok(read.budget.estimatedProjectedTokens < read.budget.estimatedCanonicalTokens)
  assert.ok(read.budget.estimatedTokenSavings > 0)
  assert.equal(read.nodes.some(node => node.nodeId === 'disclaimer-4'), false)

  const exact = await andocGet(documentPath, 'disclaimer-4') as { block: { content: Array<{ text: string }> } }
  assert.equal(exact.block.content[0]?.text, disclaimer)
})

test('shared-content tool expands exact page citations only on demand and query paths collapse duplicate answers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'anx-shared-content-tools-'))
  const documentPath = path.join(root, 'shared-content.anx')
  await writeFile(documentPath, await packAndoc({ document: repeatedDocument() }))

  const compact = await andocSharedContent(documentPath) as {
    groups: Array<{ id: string; occurrences?: unknown[]; occurrenceCount: number; citation: { uri: string } }>
  }
  assert.equal(compact.groups.length, 1)
  assert.equal(compact.groups[0]?.occurrenceCount, 5)
  assert.equal(compact.groups[0]?.occurrences, undefined)
  assert.match(compact.groups[0]!.citation.uri, /\/shared-content\/shared-/)

  const expanded = await andocSharedContent(documentPath, compact.groups[0]!.id, true) as {
    summary: { expanded: boolean }
    groups: Array<{ occurrences: Array<{ nodeId: string; page: number; citation: string }> }>
  }
  assert.equal(expanded.summary.expanded, true)
  assert.deepEqual(expanded.groups[0]?.occurrences.map(occurrence => occurrence.page), [1, 2, 3, 4, 5])
  assert.ok(expanded.groups[0]?.occurrences.every(occurrence => occurrence.citation.startsWith('anx://')))

  const query = await andocQuery(documentPath, 'authorized recipient redistributed written permission', { limit: 10 }) as {
    matches: Array<{ evidence: Array<{ nodeId: string }>; sharedContent?: { occurrenceCount: number } }>
  }
  assert.equal(query.matches.filter(match => match.sharedContent?.occurrenceCount === 5).length, 1)
  assert.equal(query.matches.flatMap(match => match.evidence).filter(node => /^disclaimer-[1-5]$/.test(node.nodeId)).length, 1)

  const search = await andocSearch(documentPath, 'authorized recipient redistributed written permission', 10) as {
    matches: Array<{ nodeId: string; sharedContent?: { occurrenceCount: number } }>
  }
  assert.equal(search.matches.filter(match => match.sharedContent?.occurrenceCount === 5).length, 1)
  assert.equal(search.matches.filter(match => /^disclaimer-[1-5]$/.test(match.nodeId)).length, 1)
})

test('PDF import indexes recurring furniture once without dropping source occurrences or merging a legal variant', () => {
  const texts: NonNullable<DoclingDocument['texts']> = []
  for (let page = 1; page <= 4; page += 1) {
    texts.push({
      self_ref: `#/texts/disclaimer-${page}`,
      text: disclaimer,
      prov: [{ page_no: page, bbox: { l: 40, b: 20, r: 560, t: 45, coord_origin: 'BOTTOMLEFT' } }],
      parent: { $ref: '#/furniture' },
    })
  }
  texts.push({
    self_ref: '#/texts/disclaimer-variant',
    text: disclaimerVariant,
    prov: [{ page_no: 5, bbox: { l: 40, b: 20, r: 560, t: 45, coord_origin: 'BOTTOMLEFT' } }],
    parent: { $ref: '#/furniture' },
  })
  texts.push({
    self_ref: '#/texts/body-1',
    text: 'Unique source body content remains canonical.',
    prov: [{ page_no: 1, bbox: { l: 40, b: 600, r: 560, t: 640, coord_origin: 'BOTTOMLEFT' } }],
    parent: { $ref: '#/body' },
  })
  const docling: DoclingDocument = {
    name: 'Recurring disclaimer fixture',
    texts,
    groups: [],
    body: { self_ref: '#/body', children: [{ $ref: '#/texts/body-1' }] },
    furniture: {
      self_ref: '#/furniture',
      content_layer: 'furniture',
      children: texts.slice(0, 5).map(item => ({ $ref: item.self_ref })),
    },
    pages: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
      String(index + 1),
      { page_no: index + 1, size: { width: 612, height: 792 } },
    ])),
  }
  const source = new TextEncoder().encode('%PDF-1.7\nshared-content-fixture')
  const normalized = normalizeDoclingDocument(docling, source, 'fixture.pdf', '2026-07-25T00:00:00.000Z', false)
  const index = normalized.document.metadata.anxSharedContent as AnxSharedContentIndex
  assert.equal(index.schema, 'anx.shared-content.v1')
  assert.equal(index.groups.length, 1)
  assert.equal(index.groups[0]?.kind, 'recurring-furniture')
  assert.equal(index.groups[0]?.sourceOnly, true)
  assert.equal(index.groups[0]?.occurrenceCount, 4)
  assert.deepEqual(index.groups[0]?.pageRanges, ['1-4'])
  assert.equal(index.groups[0]?.occurrences?.length, 4)
  assert.equal(index.groups[0]?.occurrences?.every(occurrence => occurrence.sourceUri === 'sources/original/fixture.pdf'), true)
  assert.equal(normalized.document.blocks.some(block => block.type === 'paragraph' && block.content[0]?.text === disclaimer), false)
  assert.equal(normalized.document.blocks.some(block => block.type === 'paragraph' && block.content[0]?.text.includes('Unique source body')), true)
  assert.deepEqual(normalized.sources['sources/original/fixture.pdf'], source)
})
