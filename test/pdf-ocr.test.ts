import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import {
  assertRequiredPdfOcrCoverage,
  comparePdfTextCandidates,
  packageWithPdfOcrCandidates,
  validatedPackagePdfOcrCandidates,
  type PdfOcrCandidatesReport,
} from '../src/pdf-ocr.js'
import { analyzeNativeText } from '../src/pdf-text-quality.js'
import { createProfiles } from '../src/profiles.js'
import { packAndoc, readAndoc, validateAndoc, type AndocPackage } from '../src/package.js'
import { registerSourceBaseline } from '../src/source-baseline.js'
import { applyTransaction } from '../src/transaction.js'
import type { AndocDocument, AndocLineage, AndocTransaction } from '../src/types.js'

const readable = 'This retained page contains stable native text and a reliable evidence trail for downstream agents.'
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

function retainedEvidenceFixture(): { pkg: AndocPackage; report: PdfOcrCandidatesReport } {
  const sourceBytes = new TextEncoder().encode('%PDF retained evidence fixture')
  const sourceSha256 = digest(sourceBytes)
  const nativeText = ''
  const ocrText = 'Recovered source-bound OCR text.'
  const report: PdfOcrCandidatesReport = {
    schema: 'agn.pdf-ocr-candidates.v1',
    sourceSha256,
    generatedAt: '2026-08-06T12:00:00.000Z',
    automaticCanonicalChange: false,
    routedPages: [1],
    engine: {
      name: 'FixtureOCR',
      version: '1',
      runtime: 'test',
      policyId: 'fixture',
      policySha256: 'a'.repeat(64),
      models: [{ role: 'recognition', family: 'fixture', variant: 'fixture', file: 'fixture.onnx', sha256: 'd'.repeat(64), bytes: 1 }],
    },
    renderer: { name: 'fixture', version: '1', dpi: 200 },
    pages: [{
      page: 1,
      route: 'ocr-full-page',
      nativeCandidate: { text: nativeText, sha256: digest(nativeText), metrics: analyzeNativeText(nativeText) },
      ocrCandidate: {
        text: ocrText,
        sha256: digest(ocrText),
        meanConfidence: 0.98,
        minimumConfidence: 0.9,
        lineCount: 1,
        lines: [{ text: ocrText, confidence: 0.98, box: [[0, 0], [1, 0], [1, 1], [0, 1]] }],
      },
      comparison: {
        normalizedSimilarity: 0,
        tokenOverlap: 0,
        numericAgreement: { status: 'unverifiable', nativeTokens: [], ocrTokens: [], sharedTokens: 0, nativeOnly: [], ocrOnly: [] },
        numericReviewRequired: false,
        recommendation: 'prefer-ocr-candidate',
        reasons: ['Fixture candidate.'],
      },
      render: { widthPixels: 1200, heightPixels: 1600, dpi: 200 },
      timing: { engineElapsedMs: 1, wallElapsedMs: 1 },
    }],
  }
  const sourcePath = 'sources/original/fixture.pdf'
  const pkg = {
    document: { metadata: { source: { embeddedPath: sourcePath, mediaType: 'application/pdf', sha256: sourceSha256, pageCount: 1 } } },
    manifest: { entries: [{ path: sourcePath, role: 'source', mediaType: 'application/pdf', sha256: sourceSha256, size: sourceBytes.length }] },
    files: {
      [sourcePath]: sourceBytes,
      'sources/ocr/candidates.json': new TextEncoder().encode(JSON.stringify(report)),
    },
    transactions: [],
    finalizations: [],
  } as unknown as AndocPackage
  return { pkg, report }
}

function replaceReport(pkg: AndocPackage, report: PdfOcrCandidatesReport): AndocPackage {
  return { ...pkg, files: { ...pkg.files, 'sources/ocr/candidates.json': new TextEncoder().encode(JSON.stringify(report)) } }
}

async function packagePreservationFixture(): Promise<{ pkg: AndocPackage; report: PdfOcrCandidatesReport }> {
  const sourcePath = 'sources/original/protected-fixture.pdf'
  const sourceBytes = new TextEncoder().encode('%PDF-1.7\nprotected evidence fixture\n%%EOF\n')
  const sourceSha256 = digest(sourceBytes)
  const baseline: AndocDocument = {
    schema: 'andoc.document.v1',
    documentId: 'pdf-protected-evidence-fixture',
    revision: 0,
    title: 'Protected evidence fixture',
    locale: 'en-US',
    createdAt: '2026-08-06T12:00:00.000Z',
    updatedAt: '2026-08-06T12:00:00.000Z',
    metadata: {
      source: {
        embeddedPath: sourcePath,
        fileName: 'protected-fixture.pdf',
        mediaType: 'application/pdf',
        sha256: sourceSha256,
        size: sourceBytes.length,
        pageCount: 1,
      },
    },
    assets: {},
    blocks: [{ id: 'paragraph-1', type: 'paragraph', content: [{ text: 'Baseline text.' }] }],
  }
  const baseBytes = await packAndoc({ document: baseline, sources: { [sourcePath]: sourceBytes } })
  const { privateKey } = generateKeyPairSync('ed25519')
  const registered = await registerSourceBaseline(baseBytes, {
    actor: { type: 'human', id: 'records-owner' },
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    keyId: 'source-baseline-key',
    role: 'source-baseline-registrar',
    registeredAt: '2026-08-06T12:01:00.000Z',
    title: baseline.title,
    acquisitionMethod: 'scanned',
  })
  const registeredPackage = await readAndoc(registered.packageBytes)
  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: 'tx-protected-evidence-fixture',
    baseRevision: 0,
    actor: { type: 'human', id: 'editor' },
    timestamp: '2026-08-06T12:02:00.000Z',
    operations: [{ op: 'updateTextBlock', targetId: 'paragraph-1', content: [{ text: 'Working text.' }] }],
  }
  const document = applyTransaction(registeredPackage.document, transaction)
  const profiles = createProfiles()
  const lineage: AndocLineage = {
    schema: 'andoc.lineage.v1',
    documentId: document.documentId,
    derivedRevision: 1,
    derivedAt: '2026-08-06T12:02:00.000Z',
    actor: { type: 'human', id: 'editor' },
    parent: {
      finalizationId: 'parent-finalization',
      documentId: document.documentId,
      revision: 0,
      packageSha256: 'b'.repeat(64),
      protectedEntryRootSha256: 'c'.repeat(64),
      mode: 'reference',
      uri: 'urn:anx:test:parent',
    },
  }
  const bytes = await packAndoc({
    document,
    versionBaseline: registeredPackage.document,
    transactions: [transaction],
    sources: { [sourcePath]: sourceBytes },
    profiles,
    lineage,
    sourceBaselines: registeredPackage.sourceBaselines,
  })
  const pkg = await readAndoc(bytes)
  const report = structuredClone(retainedEvidenceFixture().report)
  report.sourceSha256 = sourceSha256
  return { pkg, report }
}

test('candidate comparison retains agreeing native text without an automatic canonical change', () => {
  const result = comparePdfTextCandidates(readable, readable, 0.98, {
    recommendedRoute: 'ocr-compare',
    nativeText: analyzeNativeText(readable),
  })
  assert.equal(result.recommendation, 'retain-native')
  assert.equal(result.normalizedSimilarity, 1)
  assert.equal(result.tokenOverlap, 1)
  assert.match(result.reasons.at(-1) || '', /never changes canonical/i)
})

test('candidate comparison prefers confident OCR when native text is absent', () => {
  const result = comparePdfTextCandidates('', readable, 0.96, {
    recommendedRoute: 'ocr-full-page',
    nativeText: analyzeNativeText(''),
  })
  assert.equal(result.recommendation, 'prefer-ocr-candidate')
})

test('candidate comparison holds material disagreement for review', () => {
  const result = comparePdfTextCandidates(readable, 'Entirely different candidate content with unrelated evidence and wording.', 0.96, {
    recommendedRoute: 'ocr-compare',
    nativeText: analyzeNativeText(readable),
  })
  assert.equal(result.recommendation, 'human-review')
})

test('candidate comparison reports exact numeric-token agreement', () => {
  const text = 'Availability was 96.2%, output was 412 MW, and heat rate was 10,420 Btu/kWh.'
  const result = comparePdfTextCandidates(text, text, 0.99, {
    recommendedRoute: 'ocr-compare',
    nativeText: analyzeNativeText(text),
  })
  assert.equal(result.numericAgreement.status, 'agree')
  assert.deepEqual(result.numericAgreement.nativeTokens, ['96.2%', '412', '10,420'])
  assert.equal(result.numericReviewRequired, false)
})

test('candidate comparison raises a numeric review signal without silently merging candidates', () => {
  const native = 'Net output was 412 MW and availability was 96.2%.'
  const ocr = 'Net output was 472 MW and availability was 96.2%.'
  const result = comparePdfTextCandidates(native, ocr, 0.99, {
    recommendedRoute: 'ocr-compare',
    nativeText: analyzeNativeText(native),
  })
  assert.equal(result.numericAgreement.status, 'disagree')
  assert.deepEqual(result.numericAgreement.nativeOnly, ['412'])
  assert.deepEqual(result.numericAgreement.ocrOnly, ['472'])
  assert.equal(result.numericReviewRequired, true)
  assert.match(result.reasons.join(' '), /numeric fields require explicit review/i)
})

test('candidate comparison labels pages without numeric evidence as unverifiable but not review-required', () => {
  const result = comparePdfTextCandidates(readable, readable, 0.99, {
    recommendedRoute: 'ocr-compare',
    nativeText: analyzeNativeText(readable),
  })
  assert.equal(result.numericAgreement.status, 'unverifiable')
  assert.equal(result.numericReviewRequired, false)
})

test('Studio accepts only source-bound, range-safe, hash-valid OCR evidence', () => {
  const { pkg, report } = retainedEvidenceFixture()
  assert.ok(validatedPackagePdfOcrCandidates(pkg))

  const wrongSource = structuredClone(report)
  wrongSource.sourceSha256 = 'f'.repeat(64)
  assert.equal(validatedPackagePdfOcrCandidates(replaceReport(pkg, wrongSource)), null)

  const staleTextHash = structuredClone(report)
  staleTextHash.pages[0]!.ocrCandidate.text = 'tampered text'
  assert.equal(validatedPackagePdfOcrCandidates(replaceReport(pkg, staleTextHash)), null)

  const outOfRange = structuredClone(report)
  outOfRange.routedPages = [2]
  outOfRange.pages[0]!.page = 2
  assert.equal(validatedPackagePdfOcrCandidates(replaceReport(pkg, outOfRange)), null)

  const canonicalMutation = structuredClone(report) as PdfOcrCandidatesReport & { automaticCanonicalChange: boolean }
  canonicalMutation.automaticCanonicalChange = true
  assert.equal(validatedPackagePdfOcrCandidates(replaceReport(pkg, canonicalMutation as PdfOcrCandidatesReport)), null)
})

test('required selective OCR rejects missing coverage but accepts an exact completed empty-page result', () => {
  const { report } = retainedEvidenceFixture()
  const quality = {
    pages: [{ page: 1, recommendedRoute: 'ocr-full-page' }],
  } as any
  assert.doesNotThrow(() => assertRequiredPdfOcrCoverage(report, quality))

  const missing = structuredClone(report)
  missing.routedPages = []
  missing.pages = []
  assert.throws(() => assertRequiredPdfOcrCoverage(missing, quality), /coverage mismatch/)

  const empty = structuredClone(report)
  empty.pages[0]!.ocrCandidate.text = ''
  empty.pages[0]!.ocrCandidate.sha256 = digest('')
  empty.pages[0]!.ocrCandidate.meanConfidence = 0
  empty.pages[0]!.ocrCandidate.minimumConfidence = 0
  empty.pages[0]!.ocrCandidate.lineCount = 0
  empty.pages[0]!.ocrCandidate.lines = []
  empty.pages[0]!.comparison.recommendation = 'human-review'
  assert.doesNotThrow(() => assertRequiredPdfOcrCoverage(empty, quality))

  const { pkg } = retainedEvidenceFixture()
  assert.ok(validatedPackagePdfOcrCandidates(replaceReport(pkg, empty)), 'source-bound empty evidence remains a completed page result')

  const brokenEngine = structuredClone(empty)
  brokenEngine.engine.name = ''
  assert.throws(() => assertRequiredPdfOcrCoverage(brokenEngine, quality), /structurally invalid/)
  assert.equal(validatedPackagePdfOcrCandidates(replaceReport(pkg, brokenEngine)), null)
})

test('evidence-only OCR attachment preserves every pre-existing package entry byte-for-byte', async () => {
  const { pkg, report } = await packagePreservationFixture()
  const files = { ...pkg.files }
  const reformattedJsonPaths = [
    'document.json',
    'versions/baseline.document.json',
    'profiles/declaration.json',
    'lineage/record.json',
    'sources/provenance/source-baselines.json',
  ]
  for (const entryPath of reformattedJsonPaths) {
    const value = JSON.parse(new TextDecoder().decode(files[entryPath]!))
    files[entryPath] = new TextEncoder().encode(`${JSON.stringify(value, null, 4)}\n`)
  }
  files['revisions/transactions.jsonl'] = new TextEncoder().encode(
    `${new TextDecoder().decode(files['revisions/transactions.jsonl']!).trim()}\r\n\r\n`,
  )

  const manifest = structuredClone(pkg.manifest)
  manifest.entries = manifest.entries.map(entry => {
    const bytes = files[entry.path]
    return bytes ? { ...entry, sha256: digest(bytes), size: bytes.length } : entry
  })
  const rawByteVariant: AndocPackage = { ...pkg, manifest, files }
  const attachedBytes = await packageWithPdfOcrCandidates(rawByteVariant, report)
  const validation = await validateAndoc(attachedBytes)
  assert.equal(validation.ok, true, validation.issues.map(issue => `${issue.code}:${issue.path}`).join(', '))

  const attached = await readAndoc(attachedBytes)
  for (const [entryPath, before] of Object.entries(files)) {
    if (entryPath === 'manifest.json' || entryPath === 'sources/ocr/candidates.json') continue
    assert.deepEqual(attached.files[entryPath], before, `${entryPath} must remain byte-identical`)
  }
  assert.deepEqual(attached.files['sources/original/protected-fixture.pdf'], files['sources/original/protected-fixture.pdf'])
  assert.ok(validatedPackagePdfOcrCandidates(attached))
})
