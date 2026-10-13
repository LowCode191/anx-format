import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderSemanticDiffMarkdown, semanticDiff } from '../src/semantic-diff.js'
import type { AndocDocument } from '../src/types.js'

function doc(revision: number, blocks: AndocDocument['blocks']): AndocDocument {
  return {
    schema: 'andoc.document.v1',
    documentId: 'doc-diff',
    revision,
    title: 'Diff fixture',
    locale: 'en',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    metadata: {},
    assets: {},
    blocks,
  } as AndocDocument
}

const before = doc(1, [
  { id: 'h-1', type: 'heading', level: 1, content: [{ text: 'Report' }] },
  { id: 'p-1', type: 'paragraph', content: [{ text: 'Revenue was $100.' }] },
  { id: 'p-2', type: 'paragraph', content: [{ text: 'To be removed.' }] },
  { id: 't-1', type: 'table', rows: [[{ id: 'c-1', content: [{ text: '1' }] }, { id: 'c-2', content: [{ text: '2' }] }]] },
  { id: 'p-3', type: 'paragraph', content: [{ text: 'Tail paragraph.' }] },
] as AndocDocument['blocks'])

const after = doc(2, [
  { id: 'h-1', type: 'heading', level: 2, content: [{ text: 'Report' }] },
  { id: 'p-3', type: 'paragraph', content: [{ text: 'Tail paragraph.' }] },
  { id: 'p-1', type: 'paragraph', content: [{ text: 'Revenue was $120.' }] },
  { id: 't-1', type: 'table', rows: [[{ id: 'c-1', content: [{ text: '1' }] }, { id: 'c-2', content: [{ text: '99' }] }]] },
  { id: 'p-4', type: 'paragraph', content: [{ text: 'Brand new.' }] },
] as AndocDocument['blocks'])

test('semantic diff reports typed node-level changes with stable IDs', () => {
  const diff = semanticDiff(before, after)
  const kinds = new Map(diff.entries.map(entry => [`${entry.kind}:${entry.id}`, entry]))
  assert.ok(kinds.has('removed:p-2'))
  assert.ok(kinds.has('added:p-4'))
  assert.ok(kinds.has('moved:p-3'))
  assert.ok(kinds.has('level-changed:h-1'))
  assert.match(kinds.get('text-changed:p-1')!.detail!, /\$100.*\$120/)
  assert.match(kinds.get('table-changed:t-1')!.detail!, /1 cell\(s\) changed/)
  assert.equal(diff.sameDocumentLineage, true)
  assert.equal(diff.changeCount, diff.entries.length)
})

test('semantic diff is empty for identical documents and renders markdown deterministically', () => {
  assert.equal(semanticDiff(before, before).changeCount, 0)
  const markdown = renderSemanticDiffMarkdown(semanticDiff(before, after))
  assert.match(markdown, /## ANX semantic diff/)
  assert.match(markdown, /r1 → r2/)
  assert.match(markdown, /`~` \*\*text-changed\*\* paragraph `p-1`/)
  assert.equal(markdown, renderSemanticDiffMarkdown(semanticDiff(before, after)))
})
