import { createHash } from 'node:crypto'
import {
  packageWithPdfOcrCandidates,
  type PdfOcrCandidatesReport,
} from '../../src/pdf-ocr.js'
import { analyzeNativeText } from '../../src/pdf-text-quality.js'
import { packAndoc, readAndoc } from '../../src/package.js'
import type { AndocDocument } from '../../src/types.js'

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

export async function ocrPageFixtureBytes(options: {
  text?: string
  numericReviewRequired?: boolean
  pages?: Array<{
    page: number
    text: string
    numericReviewRequired?: boolean
  }>
  pageCount?: number
  anchorPages?: number[]
} = {}): Promise<Uint8Array> {
  const sourcePath = 'sources/original/scanned-fixture.pdf'
  const sourceBytes = new TextEncoder().encode('%PDF-1.4\n% scanned OCR evidence fixture\n%%EOF\n')
  const sourceSha256 = sha256(sourceBytes)
  const ocrText = options.text || 'Table 2. Fault type | Angle Phi | Cotangent Phi | Movement of hanging wall.'
  const configuredPages = options.pages || [{
    page: 1,
    text: ocrText,
    numericReviewRequired: options.numericReviewRequired,
  }]
  const pageCount = options.pageCount || Math.max(...configuredPages.map(page => page.page))
  const anchorPages = options.anchorPages || [1]
  const document: AndocDocument = {
    schema: 'andoc.document.v1',
    documentId: 'pdf-scanned-ocr-fixture',
    revision: 0,
    title: 'Scanned OCR fixture',
    locale: 'en-US',
    createdAt: '2026-08-06T12:00:00.000Z',
    updatedAt: '2026-08-06T12:00:00.000Z',
    metadata: {
      source: {
        embeddedPath: sourcePath,
        fileName: 'scanned-fixture.pdf',
        mediaType: 'application/pdf',
        sha256: sourceSha256,
        size: sourceBytes.length,
        pageCount,
      },
    },
    assets: {},
    blocks: anchorPages.map(page => ({
      id: `page-break-scanned-${page}`,
      type: 'pageBreak' as const,
      provenance: { kind: 'imported' as const, sourceUri: 'scanned-fixture.pdf', page },
    })),
  }
  const report: PdfOcrCandidatesReport = {
    schema: 'agn.pdf-ocr-candidates.v1',
    sourceSha256,
    generatedAt: '2026-08-06T12:01:00.000Z',
    automaticCanonicalChange: false,
    routedPages: configuredPages.map(page => page.page),
    engine: {
      name: 'FixtureOCR',
      version: '1',
      runtime: 'test',
      policyId: 'fixture-policy',
      policySha256: 'a'.repeat(64),
      models: [{
        role: 'recognition',
        family: 'fixture',
        variant: 'fixture',
        file: 'fixture.onnx',
        sha256: 'b'.repeat(64),
        bytes: 1,
      }],
    },
    renderer: { name: 'fixture-renderer', version: '1', dpi: 200 },
    pages: configuredPages.map(configured => {
      const numericReviewRequired = configured.numericReviewRequired !== false
      return {
      page: configured.page,
      route: 'ocr-full-page',
      nativeCandidate: {
        text: '',
        sha256: sha256(''),
        metrics: analyzeNativeText(''),
      },
      ocrCandidate: {
        text: configured.text,
        sha256: sha256(configured.text),
        meanConfidence: 0.98,
        minimumConfidence: 0.91,
        lineCount: 1,
        lines: [{
          text: configured.text,
          confidence: 0.98,
          box: [[0, 0], [100, 0], [100, 20], [0, 20]],
        }],
      },
      comparison: {
        normalizedSimilarity: 0,
        tokenOverlap: 0,
        numericAgreement: numericReviewRequired
          ? {
              status: 'disagree',
              nativeTokens: [],
              ocrTokens: ['2'],
              sharedTokens: 0,
              nativeOnly: [],
              ocrOnly: ['2'],
            }
          : {
              status: 'unverifiable',
              nativeTokens: [],
              ocrTokens: [],
              sharedTokens: 0,
              nativeOnly: [],
              ocrOnly: [],
            },
        numericReviewRequired,
        recommendation: 'prefer-ocr-candidate',
        reasons: ['Fixture OCR is preferred over empty native text.'],
      },
      render: { widthPixels: 1200, heightPixels: 1600, dpi: 200 },
      timing: { engineElapsedMs: 1, wallElapsedMs: 1 },
    }}),
  }
  const base = await readAndoc(await packAndoc({
    document,
    sources: { [sourcePath]: sourceBytes },
  }))
  return packageWithPdfOcrCandidates(base, report)
}
