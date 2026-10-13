import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import {
  analyzeNativeText,
  analyzePdfTextQuality,
  classifyPdfPageTextQuality,
  packagePdfTextQuality,
  suspiciousTextPagesFromBlocks,
  textCandidatesByPage,
  validatedPdfTextQualityReport,
  type PdfFontDiagnostic,
} from '../src/pdf-text-quality.js'
import type { DoclingDocument } from '../src/import-pdf.js'

const cleanFont: PdfFontDiagnostic = {
  resource: 'F1',
  objectRef: '4 0 R',
  baseFont: 'Helvetica',
  subtype: 'Type1',
  encoding: 'WinAnsiEncoding',
  hasToUnicode: false,
  risk: 'none',
}

const unsafeIdentityFont: PdfFontDiagnostic = {
  resource: 'C0_0',
  objectRef: '404 0 R',
  baseFont: 'CIDFont',
  subtype: 'Type0',
  encoding: 'Identity-H',
  hasToUnicode: false,
  risk: 'identity-cid-without-to-unicode',
}

const readableType3Font: PdfFontDiagnostic = {
  resource: 'Plot/FigureLabels',
  objectRef: '88 0 R',
  baseFont: null,
  subtype: 'Type3',
  encoding: null,
  hasToUnicode: false,
  risk: 'none',
}

const cleanText = 'This page contains ordinary native text with readable words, stable spacing, and enough content for a deterministic quality decision.'
const corruptedText = Array.from({ length: 34 }, (_, index) => `TRM${index}QX9`).join(' ')

test('native-text metrics distinguish readable prose from deterministic corruption signals', () => {
  const clean = analyzeNativeText(cleanText.repeat(3))
  const corrupt = analyzeNativeText(corruptedText)
  assert.equal(clean.stronglyCorrupted, false)
  assert.equal(corrupt.stronglyCorrupted, true)
  assert.ok(corrupt.mixedTokenRatio > 0.9)
})

test('page-quality routing separates clean, image-only, mixed, and sparse candidates', () => {
  const clean = classifyPdfPageTextQuality({ page: 1, text: cleanText, pictureCount: 0, fonts: [cleanFont] })
  assert.equal(clean.classification, 'clean-native')
  assert.equal(clean.recommendedRoute, 'native')

  const image = classifyPdfPageTextQuality({ page: 2, text: '', pictureCount: 1, fonts: [] })
  assert.equal(image.classification, 'image-only')
  assert.equal(image.recommendedRoute, 'ocr-full-page')

  const mixed = classifyPdfPageTextQuality({ page: 3, text: corruptedText, pictureCount: 1, fonts: [cleanFont, unsafeIdentityFont] })
  assert.equal(mixed.classification, 'mixed')
  assert.equal(mixed.recommendedRoute, 'ocr-regions')

  const sparse = classifyPdfPageTextQuality({ page: 4, text: 'Short note', pictureCount: 0, fonts: [cleanFont] })
  assert.equal(sparse.classification, 'low-confidence')
  assert.equal(sparse.recommendedRoute, 'ocr-compare')
})

test('full-page legacy raster layers route to comparison while readable Type3 remains native', () => {
  const scanned = classifyPdfPageTextQuality({
    page: 1,
    text: '',
    pictureCount: 0,
    fonts: [],
    rasterImages: [{
      resource: 'ImScan',
      objectRef: '9 0 R',
      width: 2550,
      height: 3300,
      pixels: 8_415_000,
      bitsPerComponent: 1,
      imageMask: false,
      filter: 'CCITTFaxDecode',
      pageAspectDelta: 0.001,
      fullPageCandidateReason: 'page-aspect-monochrome',
      fullPageCandidate: true,
    }],
  })
  assert.equal(scanned.classification, 'image-only')
  assert.equal(scanned.recommendedRoute, 'ocr-full-page')
  assert.equal(scanned.fullPageRasterImageCount, 1)

  const legacy = classifyPdfPageTextQuality({
    page: 1,
    text: cleanText,
    pictureCount: 0,
    fonts: [cleanFont],
    rasterImages: [{
      resource: 'Im0',
      objectRef: '12 0 R',
      width: 2550,
      height: 3300,
      pixels: 8_415_000,
      bitsPerComponent: 1,
      imageMask: false,
      filter: 'CCITTFaxDecode',
      pageAspectDelta: 0.002,
      fullPageCandidateReason: 'page-aspect-monochrome',
      fullPageCandidate: true,
    }],
  })
  assert.equal(legacy.classification, 'mixed')
  assert.equal(legacy.recommendedRoute, 'ocr-compare')
  assert.equal(legacy.fullPageRasterImageCount, 1)

  const type3 = classifyPdfPageTextQuality({ page: 2, text: cleanText, pictureCount: 0, fonts: [readableType3Font] })
  assert.equal(type3.classification, 'clean-native')
  assert.equal(type3.recommendedRoute, 'native')
  assert.equal(type3.highRiskFontCount, 0)
})

test('placed-image coverage prevents tiny decorative rasters from triggering page-wide OCR', () => {
  const raster = {
    resource: 'Tiny', objectRef: '9 0 R', width: 1, height: 1, pixels: 1,
    fullPageCandidateReason: null, fullPageCandidate: false,
  } as const
  const tinyPlacement = {
    page: 1, sourceName: 'Tiny', pixelWidth: 1, pixelHeight: 1,
    bbox: [20, 20, 50, 50] as [number, number, number, number],
    pageSize: { width: 600, height: 800 }, areaRatio: 0.001875,
  }
  const tiny = classifyPdfPageTextQuality({
    page: 1, text: '', pictureCount: 1, fonts: [], rasterImages: [raster],
    placedImages: [tinyPlacement], placementAnalysisAvailable: true,
  })
  assert.equal(tiny.classification, 'blank')
  assert.equal(tiny.recommendedRoute, 'none')

  const fullPage = classifyPdfPageTextQuality({
    page: 1, text: '', pictureCount: 1, fonts: [], rasterImages: [raster],
    placedImages: [{ ...tinyPlacement, bbox: [0, 0, 600, 800], areaRatio: 1 }],
    placementAnalysisAvailable: true,
  })
  assert.equal(fullPage.classification, 'image-only')
  assert.equal(fullPage.recommendedRoute, 'ocr-full-page')

  const cleanWithLogo = classifyPdfPageTextQuality({
    page: 1, text: cleanText, pictureCount: 1, fonts: [cleanFont], rasterImages: [raster],
    placedImages: [tinyPlacement], placementAnalysisAvailable: true,
  })
  assert.equal(cleanWithLogo.classification, 'clean-native')
  assert.equal(cleanWithLogo.recommendedRoute, 'native')
})

test('PDF font inspection does not over-route a standard Type1 WinAnsi page', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText(cleanText, { x: 72, y: 700, size: 11, font })
  const bytes = await pdf.save()
  const docling = {
    pages: { '1': { size: { width: 612, height: 792 } } },
    texts: [{ text: cleanText, prov: [{ page_no: 1 }] }],
  } as unknown as DoclingDocument
  const report = await analyzePdfTextQuality(bytes, docling)
  assert.equal(report.schema, 'agn.pdf-text-quality.v1')
  assert.equal(report.pageCount, 1)
  assert.equal(report.pages[0]?.classification, 'clean-native')
  assert.equal(report.pages[0]?.recommendedRoute, 'native')
  assert.equal(report.pages[0]?.highRiskFontCount, 0)
  assert.equal(report.pages[0]?.fullPageRasterImageCount, 0)
  assert.equal(report.pages[0]?.fonts[0]?.subtype, 'Type1')
})

test('stored text-quality qualification rejects truncated, duplicate, mismatched, and internally inconsistent reports', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText(cleanText, { x: 72, y: 700, size: 11, font })
  const bytes = await pdf.save()
  const docling = {
    pages: { '1': { size: { width: 612, height: 792 } } },
    texts: [{ text: cleanText, prov: [{ page_no: 1 }] }],
  } as unknown as DoclingDocument
  const valid = await analyzePdfTextQuality(bytes, docling)

  assert.equal(validatedPdfTextQualityReport(valid, 1), valid)
  assert.equal(validatedPdfTextQualityReport({ ...valid, pages: [] }, 1), null)
  assert.equal(validatedPdfTextQualityReport({ ...valid, pageCount: 2, pages: [valid.pages[0], valid.pages[0]] }, 2), null)
  assert.equal(validatedPdfTextQualityReport(valid, 2), null)
  assert.equal(validatedPdfTextQualityReport({
    ...valid,
    summary: { ...valid.summary, pagesRequiringOcr: valid.summary.pagesRequiringOcr + 1 },
  }, 1), null)
})

test('legacy stored raster pages mislabeled blank are reanalyzed from retained evidence', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const pixel = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  page.drawImage(pixel, { x: 0, y: 0, width: 612, height: 792 })
  const pdfBytes = await pdf.save()
  const docling = {
    pages: { '1': { size: { width: 612, height: 792 } } },
    texts: [],
    pictures: [],
  } as unknown as DoclingDocument
  const staleReport = {
    schema: 'agn.pdf-text-quality.v1',
    pages: [{
      page: 1,
      classification: 'blank',
      recommendedRoute: 'none',
      rasterImages: [{ width: 612, height: 792 }],
    }],
  }
  const pkg = {
    document: { metadata: { importer: { textQuality: staleReport } } },
    manifest: { entries: [{ path: 'sources/original/legacy-scan.pdf', mediaType: 'application/pdf' }] },
    files: {
      'sources/original/legacy-scan.pdf': pdfBytes,
      'sources/docling/document.json': new TextEncoder().encode(JSON.stringify(docling)),
    },
  } as any

  const report = await packagePdfTextQuality(pkg)
  assert.equal(report?.pages[0]?.classification, 'image-only')
  assert.equal(report?.pages[0]?.recommendedRoute, 'ocr-full-page')
})

test('block diagnostics identify suspicious pages without changing canonical content', () => {
  const pages = suspiciousTextPagesFromBlocks([
    { id: 'clean', type: 'paragraph', content: [{ text: cleanText }], provenance: { page: 1 } },
    { id: 'corrupt', type: 'paragraph', content: [{ text: corruptedText }], provenance: { page: 2 } },
  ])
  assert.deepEqual(pages, [2])
})

test('diagnostic text follows body order and collapses physical duplicates of merged table cells', () => {
  const docling = {
    pages: { '1': { size: { width: 612, height: 792 } } },
    body: { children: [{ $ref: '#/texts/0' }, { $ref: '#/tables/0' }, { $ref: '#/texts/2' }] },
    furniture: { children: [] },
    groups: [],
    pictures: [],
    texts: [
      { self_ref: '#/texts/0', text: 'Before table', prov: [{ page_no: 1, bbox: { l: 72, b: 700, r: 200, t: 714, coord_origin: 'BOTTOMLEFT' } }] },
      { self_ref: '#/texts/1', text: 'Merged heading', parent: { $ref: '#/tables/0' }, prov: [{ page_no: 1, bbox: { l: 72, b: 500, r: 300, t: 520, coord_origin: 'BOTTOMLEFT' } }] },
      { self_ref: '#/texts/2', text: 'After table', prov: [{ page_no: 1, bbox: { l: 72, b: 350, r: 200, t: 364, coord_origin: 'BOTTOMLEFT' } }] },
    ],
    tables: [{
      self_ref: '#/tables/0',
      prov: [{ page_no: 1, bbox: { l: 72, b: 430, r: 500, t: 560, coord_origin: 'BOTTOMLEFT' } }],
      children: [{ $ref: '#/texts/1' }],
      data: { grid: [
        [
          { text: 'Merged heading', start_row_offset_idx: 0, start_col_offset_idx: 0 },
          { text: 'Merged heading', start_row_offset_idx: 0, start_col_offset_idx: 0 },
          { text: 'Merged heading', start_row_offset_idx: 0, start_col_offset_idx: 0 },
        ],
        [
          { text: 'Same', start_row_offset_idx: 1, start_col_offset_idx: 0 },
          { text: 'Same', start_row_offset_idx: 1, start_col_offset_idx: 1 },
        ],
      ] },
    }],
  } as unknown as DoclingDocument
  assert.deepEqual(textCandidatesByPage(docling, 1).get(1), [
    'Before table',
    'Merged heading Same Same',
    'After table',
  ])
})
