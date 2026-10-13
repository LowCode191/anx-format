import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { andocOcrCandidates } from '../src/agent-tools.js'
import { packAndoc, readAndoc } from '../src/package.js'
import { transactAndocPackage } from '../src/revision.js'
import type { AndocOperation, AndocTransaction } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(here, '..', 'examples', 'pdf-media-fixture-live-edited.andoc')
const STUB_BRIDGE = path.join(here, 'fixtures', 'stub_rapidocr_bridge.py')
const STUB = { pythonCommand: 'python3', bridgePath: STUB_BRIDGE }

async function fileSha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

test('ocr-candidates router mode reports no pages for a clean-native package', async () => {
  const result = (await andocOcrCandidates(FIXTURE)) as Record<string, any>
  assert.equal(result.automaticCanonicalChange, false)
  assert.equal(result.returnedPages, 0)
  assert.match(String(result.note), /No pages selected/)
})

test('ocr-candidates explicit page selection generates evidence without touching the package', async () => {
  const before = await fileSha256(FIXTURE)
  const result = (await andocOcrCandidates(FIXTURE, { pages: [1], includeText: true, ...STUB })) as Record<string, any>
  const after = await fileSha256(FIXTURE)
  assert.equal(before, after)
  assert.equal(result.automaticCanonicalChange, false)
  assert.equal(result.returnedPages, 1)
  const page = result.pages[0]
  assert.equal(page.page, 1)
  assert.match(String(page.ocrText), /STUB OCR PAGE 1/)
  assert.equal(String(page.candidateSha256).length, 64)
  assert.ok(Array.isArray(page.ocrLines) && page.ocrLines[0].box.length === 4)
  assert.ok(['ocr', 'native', null].includes(page.agentRead.preferredSource))
  assert.equal(page.agentRead.canonicalChange, false)
  assert.match(String(page.agentRead.guidance), /evidence|source canvas/)
  assert.equal(result.agentReadSummary.canonicalChange, false)
  assert.equal(result.agentReadSummary.ocrPreferredPages + result.agentReadSummary.nativePreferredPages + result.agentReadSummary.comparisonRequiredPages, 1)
  assert.equal(result.engine.name, 'StubOCR')
  assert.equal(result.engine.models[0].sha256, '0'.repeat(64))
})

test('ocr-candidates all mode forces a verification compare on every page', async () => {
  const result = (await andocOcrCandidates(FIXTURE, { mode: 'all', ...STUB })) as Record<string, any>
  assert.ok(result.returnedPages >= 1)
  for (const page of result.pages) {
    assert.ok(String(page.route).startsWith('ocr-'))
    assert.ok(page.recommendation)
    assert.ok(page.agentRead.evidenceState)
    if (page.numericReviewRequired) assert.equal(page.agentRead.unattendedUse, 'review-required')
  }
})

test('ocr-candidates runs bounded worker batches and preserves routed page order', async () => {
  const result = (await andocOcrCandidates(FIXTURE, { mode: 'all', pageBatchSize: 1, ...STUB })) as Record<string, any>
  assert.equal(result.engine.pageBatchSize, 1)
  assert.equal(result.engine.batchCount, result.returnedPages)
  assert.deepEqual(result.routedPages, result.pages.map((page: Record<string, unknown>) => page.page))
  assert.equal(result.engine.processPeakRssBytes, 1024)
})

test('ocr-candidates rejects out-of-range page selections', async () => {
  await assert.rejects(andocOcrCandidates(FIXTURE, { pages: [9999], ...STUB }), /out of range/)
})

test('applyTextCandidate binds to attached package evidence and rejects unresolved candidates', async () => {
  const tmp = path.join(os.tmpdir(), `agn-evidence-binding-${process.pid}.agn`)
  await copyFile(FIXTURE, tmp)
  try {
    const generated = (await andocOcrCandidates(tmp, { pages: [1], includeText: true, ...STUB, attachTo: tmp })) as Record<string, any>
    assert.equal(generated.attachedEntry, 'sources/ocr/candidates.json')
    assert.equal(generated.canonicalRevisionUnchanged, true)

    const pkg = await readAndoc(await readFile(tmp))
    const original = await readAndoc(await readFile(FIXTURE))
    assert.equal(pkg.document.revision, original.document.revision)
    assert.equal(pkg.transactions.length, original.transactions.length)

    const target = pkg.document.blocks.find(block => block.type === 'paragraph' || block.type === 'heading')!
    const currentText = (target as { content: Array<{ text: string }> }).content.map(run => run.text).join('')
    const promote = (id: string, sha: string, content = String(generated.pages[0].ocrText)): AndocTransaction => ({
      schema: 'andoc.transaction.v1',
      id,
      baseRevision: pkg.document.revision,
      actor: { type: 'human', id: 'binding-tester' },
      timestamp: '2026-07-18T12:00:00.000Z',
      operations: [{
        op: 'applyTextCandidate',
        targetId: target.id,
        expectedCurrentText: currentText,
        content: [{ text: content }],
        reason: 'evidence-binding test',
        candidate: { kind: 'ocr', candidateSha256: sha, engine: 'StubOCR', engineVersion: '0.0.1', page: 1 },
      } satisfies AndocOperation],
    })

    const result = await transactAndocPackage(pkg, promote('bind-ok', generated.pages[0].candidateSha256))
    assert.equal(result.document.revision, pkg.document.revision + 1)

    await assert.rejects(
      transactAndocPackage(pkg, promote('bind-bad-content', generated.pages[0].candidateSha256, 'UNRELATED SUBSTITUTE TEXT')),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'CANDIDATE_CONTENT_MISMATCH')
        assert.match(String((error as Error).message), new RegExp(`page 1.*${generated.pages[0].candidateSha256}`))
        assert.match(String((error as Error).message), /proposed content hashes to [a-f0-9]{64}/)
        return true
      },
    )

    const evidence = JSON.parse(new TextDecoder().decode(pkg.files['sources/ocr/candidates.json']))
    evidence.sourceSha256 = 'f'.repeat(64)
    const mismatchedBytes = await packAndoc({
      document: pkg.document,
      assets: Object.fromEntries(Object.values(pkg.document.assets).map(asset => [asset.id, pkg.files[asset.packagePath]!])),
      sources: {
        ...Object.fromEntries(Object.entries(pkg.files).filter(([entryPath]) => entryPath.startsWith('sources/'))),
        'sources/ocr/candidates.json': new TextEncoder().encode(JSON.stringify(evidence, null, 2) + '\n'),
      },
      transactions: pkg.transactions,
      ...(pkg.profiles ? { profiles: pkg.profiles } : {}),
      ...(pkg.lineage ? { lineage: pkg.lineage } : {}),
    })
    const mismatched = await readAndoc(mismatchedBytes)
    await assert.rejects(
      transactAndocPackage(mismatched, promote('bind-bad-source', generated.pages[0].candidateSha256)),
      /source hash does not match the retained PDF/,
    )

    await assert.rejects(
      transactAndocPackage(pkg, promote('bind-bad-sha', 'b'.repeat(64))),
      /does not match retained evidence/,
    )
    await assert.rejects(
      transactAndocPackage(original, promote('bind-no-evidence', generated.pages[0].candidateSha256)),
      /requires retained candidate evidence/,
    )
  } finally {
    await rm(tmp, { force: true })
  }
})

test('ocr-candidates refuses to attach evidence if the retained PDF changes during generation', async () => {
  const tmp = path.join(os.tmpdir(), `agn-evidence-race-${process.pid}.agn`)
  const bridge = path.join(os.tmpdir(), `agn-evidence-race-bridge-${process.pid}.py`)
  const replacement = path.join(here, '..', 'examples', 'pdf-table-media-fixture.andoc')
  await copyFile(FIXTURE, tmp)
  await writeFile(bridge, `#!/usr/bin/env python3
import argparse, hashlib, json, shutil
p=argparse.ArgumentParser(); p.add_argument('--pdf'); p.add_argument('--pages'); p.add_argument('--policy'); p.add_argument('--dpi', default='200'); p.add_argument('--disable-adaptive', action='store_true'); a=p.parse_args()
with open(a.pdf, 'rb') as f: pdf_sha=hashlib.sha256(f.read()).hexdigest()
shutil.copyfile(${JSON.stringify(replacement)}, ${JSON.stringify(tmp)})
pages=[]
for page in [int(v) for v in a.pages.split(',')]:
 text=f'STUB OCR PAGE {page}'; pages.append({'page':page,'text':text,'widthPixels':850,'heightPixels':1100,'meanConfidence':0.91,'minimumConfidence':0.88,'lineCount':1,'lines':[{'text':text,'confidence':0.91,'box':[10,10,800,40]}],'engineElapsedMs':5.0,'wallElapsedMs':6.0})
print(json.dumps({'schema':'agn.rapidocr-bridge-output.v1','engine':{'name':'StubOCR','version':'0.0.1','runtime':'stub','policyId':'stub-policy','policySha256':'0'*64,'models':[]},'renderer':{'name':'stub-renderer','version':'0.0.1','dpi':int(a.dpi)},'pdfSha256':pdf_sha,'pages':pages}))
`)
  try {
    await assert.rejects(
      andocOcrCandidates(tmp, { pages: [1], pythonCommand: 'python3', bridgePath: bridge, attachTo: tmp }),
      /retained PDF changed during OCR candidate generation/,
    )
    const current = await readAndoc(tmp)
    assert.equal(current.files['sources/ocr/candidates.json'], undefined)
  } finally {
    await rm(tmp, { force: true })
    await rm(bridge, { force: true })
  }
})
