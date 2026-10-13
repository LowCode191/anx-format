import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { strFromU8, unzipSync } from 'fflate'
import { exportAnxDocx, exportAnxJsonl, exportAnxMarkdown, packAnx, readAnx, type AnxDocument } from '../src/index.js'

async function fixturePackage() {
  const document = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8')) as AnxDocument
  return readAnx(await packAnx({ document }))
}

test('Markdown and JSONL exits retain stable IDs, revision, tables, and chart semantics', async () => {
  const pkg = await fixturePackage()
  const markdown = strFromU8(exportAnxMarkdown(pkg).bytes)
  const jsonl = strFromU8(exportAnxJsonl(pkg).bytes).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

  assert.match(markdown, /ANX .* revision 0/)
  assert.match(markdown, /\|/)
  assert.equal(jsonl[0]?.recordType, 'document')
  assert(jsonl.some(record => record.recordType === 'block' && record.nodeId === 'table-1'))
  assert(jsonl.some(record => record.recordType === 'table-cell'))
})

test('DOCX exit is deterministic OOXML with explicit styles, numbering, fixed table geometry, and canonical content', async () => {
  const pkg = await fixturePackage()
  const first = exportAnxDocx(pkg)
  const second = exportAnxDocx(pkg)
  assert.deepEqual(first.bytes, second.bytes)
  const files = unzipSync(first.bytes)
  const documentXml = strFromU8(files['word/document.xml']!)
  const stylesXml = strFromU8(files['word/styles.xml']!)
  const numberingXml = strFromU8(files['word/numbering.xml']!)

  assert.match(documentXml, /<w:tblW w:w="9360" w:type="dxa"\/?>/)
  assert.match(documentXml, /<w:tblInd w:w="120" w:type="dxa"\/?>/)
  assert.match(documentXml, /AGN Sample/)
  assert.match(stylesXml, /w:styleId="Heading1"/)
  assert.match(stylesXml, /w:line="264"/)
  assert.match(numberingXml, /w:abstractNumId="1"/)
  assert.match(numberingXml, /w:numFmt w:val="bullet"/)
  assert.match(strFromU8(files['[Content_Types].xml']!), /wordprocessingml\.document\.main\+xml/)
})
