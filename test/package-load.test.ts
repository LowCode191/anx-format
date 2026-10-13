import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { packAndoc, readAndoc, type AndocDocument } from '../src/index.js'

test('concurrent path reads share one in-flight package decode without creating a long-lived mutable cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-inflight-read-'))
  const documentPath = path.join(root, 'shared.agn')
  const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8')) as AndocDocument
  await writeFile(documentPath, await packAndoc({ document: fixture }))
  const concurrent = await Promise.all(Array.from({ length: 32 }, () => readAndoc(documentPath)))
  assert.ok(concurrent.every(pkg => pkg === concurrent[0]))
  const later = await readAndoc(documentPath)
  assert.notEqual(later, concurrent[0])
  assert.deepEqual(later.document, concurrent[0]?.document)
})
