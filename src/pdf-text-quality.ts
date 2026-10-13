import { PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib'
import type { DoclingDocument } from './import-pdf.js'
import type { AndocPackage } from './package.js'
import { analyzePdfPageObjects, type PdfPageObjectAnalysis, type PdfPlacedImage } from './pdf-page-objects.js'

export const PDF_TEXT_QUALITY_SCHEMA = 'agn.pdf-text-quality.v1' as const

export type PdfTextQualityClass =
  | 'clean-native'
  | 'image-only'
  | 'corrupted-native'
  | 'mixed'
  | 'low-confidence'
  | 'blank'

export type PdfTextRoute = 'native' | 'ocr-full-page' | 'ocr-regions' | 'ocr-compare' | 'none'
export type PdfTextLegibilityState = 'native-clean' | 'native-suspect' | 'ocr' | 'derived' | 'unverified'

export interface PdfFontDiagnostic {
  resource: string
  objectRef: string | null
  baseFont: string | null
  subtype: string | null
  encoding: string | null
  hasToUnicode: boolean
  risk: 'none' | 'identity-cid-without-to-unicode' | 'composite-font-without-to-unicode'
}

export interface PdfNativeTextMetrics {
  characterCount: number
  asciiLetterCount: number
  tokenCount: number
  vowelRatio: number
  mixedTokenRatio: number
  vowellessTokenRatio: number
  controlCharacterCount: number
  stronglyCorrupted: boolean
}

export interface PdfRasterDiagnostic {
  resource: string
  objectRef: string | null
  width: number
  height: number
  pixels: number
  bitsPerComponent?: number | null
  imageMask?: boolean
  filter?: string | null
  pageAspectDelta?: number
  fullPageCandidateReason?: 'page-aspect-monochrome' | 'cropped-monochrome-stencil' | null
  fullPageCandidate: boolean
}

export interface PdfPageTextQuality {
  page: number
  classification: PdfTextQualityClass
  recommendedRoute: PdfTextRoute
  reasons: string[]
  nativeText: PdfNativeTextMetrics
  pictureCount: number
  fonts: PdfFontDiagnostic[]
  highRiskFontCount: number
  rasterImages: PdfRasterDiagnostic[]
  fullPageRasterImageCount: number
}

export interface PdfTextQualityReport {
  schema: typeof PDF_TEXT_QUALITY_SCHEMA
  analyzer: {
    id: 'agn-pdf-text-quality'
    version: '1.0.0'
    tiers: ['font-dictionary', 'native-text-plausibility', 'ocr-candidate-comparison']
  }
  pageCount: number
  summary: {
    cleanNativePages: number
    imageOnlyPages: number
    corruptedNativePages: number
    mixedPages: number
    lowConfidencePages: number
    blankPages: number
    pagesRequiringOcr: number
    pagesRequiringReview: number
  }
  pages: PdfPageTextQuality[]
}

const packageReportCache = new WeakMap<AndocPackage, Promise<PdfTextQualityReport | null>>()

const PDF_TEXT_CLASSES: PdfTextQualityClass[] = [
  'clean-native',
  'image-only',
  'corrupted-native',
  'mixed',
  'low-confidence',
  'blank',
]
const PDF_TEXT_ROUTES: PdfTextRoute[] = ['native', 'ocr-full-page', 'ocr-regions', 'ocr-compare', 'none']

/**
 * Stored diagnostics are cache evidence, not an authority boundary. Accept them
 * only when they describe every source page exactly once and their summary is
 * reproducible from those page records.
 */
export function validatedPdfTextQualityReport(
  value: unknown,
  expectedPageCount?: number,
): PdfTextQualityReport | null {
  const report = isRecord(value)
  if (!report || report.schema !== PDF_TEXT_QUALITY_SCHEMA) return null
  const analyzer = isRecord(report.analyzer)
  if (!analyzer
    || analyzer.id !== 'agn-pdf-text-quality'
    || analyzer.version !== '1.0.0'
    || !Array.isArray(analyzer.tiers)
    || analyzer.tiers.join('\u0000') !== 'font-dictionary\u0000native-text-plausibility\u0000ocr-candidate-comparison') return null

  const pageCount = report.pageCount
  if (!Number.isInteger(pageCount) || (pageCount as number) < 1) return null
  if (expectedPageCount !== undefined
    && (!Number.isInteger(expectedPageCount) || expectedPageCount < 1 || expectedPageCount !== pageCount)) return null
  if (!Array.isArray(report.pages) || report.pages.length !== pageCount) return null

  const pages: PdfPageTextQuality[] = []
  for (let index = 0; index < report.pages.length; index += 1) {
    const page = isRecord(report.pages[index])
    const nativeText = isRecord(page?.nativeText)
    if (!page
      || page.page !== index + 1
      || !PDF_TEXT_CLASSES.includes(page.classification as PdfTextQualityClass)
      || !PDF_TEXT_ROUTES.includes(page.recommendedRoute as PdfTextRoute)
      || !Array.isArray(page.reasons)
      || page.reasons.some((reason: unknown) => typeof reason !== 'string')
      || !nativeText
      || !validNativeTextMetrics(nativeText)
      || !nonNegativeInteger(page.pictureCount)
      || !Array.isArray(page.fonts)
      || !nonNegativeInteger(page.highRiskFontCount)
      || !Array.isArray(page.rasterImages)
      || !nonNegativeInteger(page.fullPageRasterImageCount)) return null
    pages.push(page as unknown as PdfPageTextQuality)
  }

  const summary = isRecord(report.summary)
  const expectedSummary: PdfTextQualityReport['summary'] = {
    cleanNativePages: countClass(pages, 'clean-native'),
    imageOnlyPages: countClass(pages, 'image-only'),
    corruptedNativePages: countClass(pages, 'corrupted-native'),
    mixedPages: countClass(pages, 'mixed'),
    lowConfidencePages: countClass(pages, 'low-confidence'),
    blankPages: countClass(pages, 'blank'),
    pagesRequiringOcr: pages.filter(page => page.recommendedRoute.startsWith('ocr-')).length,
    pagesRequiringReview: pages.filter(page => page.classification === 'low-confidence').length,
  }
  if (!summary || Object.entries(expectedSummary).some(([key, expected]) => summary[key] !== expected)) return null
  return report as unknown as PdfTextQualityReport
}

export async function packagePdfTextQuality(pkg: AndocPackage): Promise<PdfTextQualityReport | null> {
  const cached = packageReportCache.get(pkg)
  if (cached) return cached
  const pending = packagePdfTextQualityUncached(pkg)
  packageReportCache.set(pkg, pending)
  return pending
}

export function pdfTextLegibilityState(page: PdfPageTextQuality, ocrApplied = false): PdfTextLegibilityState {
  if (ocrApplied && page.recommendedRoute.startsWith('ocr-')) return 'ocr'
  if (page.classification === 'clean-native') return 'native-clean'
  if (page.classification === 'corrupted-native' || page.classification === 'mixed') return 'native-suspect'
  return 'unverified'
}

export interface PdfPageTextCandidate {
  page: number
  text: string
  pictureCount: number
  fonts: PdfFontDiagnostic[]
  rasterImages?: PdfRasterDiagnostic[]
  placedImages?: PdfPlacedImage[]
  placementAnalysisAvailable?: boolean
}

export async function analyzePdfTextQuality(
  pdfBytes: Uint8Array,
  docling: DoclingDocument,
  pageObjectAnalysis: PdfPageObjectAnalysis | null = null,
): Promise<PdfTextQualityReport> {
  const pdf = await PDFDocument.load(pdfBytes, { updateMetadata: false })
  const pageCount = pdf.getPageCount()
  const textByPage = textCandidatesByPage(docling, pageCount)
  const picturesByPage = doclingPicturesByPage(docling, pageCount)
  const pages = pdf.getPages().map((page, index) => {
    const resources = pageResourceDiagnostics(pdf, page.node.Resources(), page.getWidth() / page.getHeight())
    return classifyPdfPageTextQuality({
      page: index + 1,
      text: (textByPage.get(index + 1) || []).join(' '),
      pictureCount: picturesByPage.get(index + 1) || 0,
      fonts: resources.fonts,
      rasterImages: resources.rasterImages,
      placedImages: pageObjectAnalysis?.placedImages.filter(image => image.page === index + 1) || [],
      placementAnalysisAvailable: pageObjectAnalysis?.schema === 'anx.pdf-page-object-analysis.v1',
    })
  })
  return {
    schema: PDF_TEXT_QUALITY_SCHEMA,
    analyzer: {
      id: 'agn-pdf-text-quality',
      version: '1.0.0',
      tiers: ['font-dictionary', 'native-text-plausibility', 'ocr-candidate-comparison'],
    },
    pageCount,
    summary: {
      cleanNativePages: countClass(pages, 'clean-native'),
      imageOnlyPages: countClass(pages, 'image-only'),
      corruptedNativePages: countClass(pages, 'corrupted-native'),
      mixedPages: countClass(pages, 'mixed'),
      lowConfidencePages: countClass(pages, 'low-confidence'),
      blankPages: countClass(pages, 'blank'),
      pagesRequiringOcr: pages.filter(page => page.recommendedRoute.startsWith('ocr-')).length,
      pagesRequiringReview: pages.filter(page => page.classification === 'low-confidence').length,
    },
    pages,
  }
}

export function classifyPdfPageTextQuality(candidate: PdfPageTextCandidate): PdfPageTextQuality {
  const nativeText = analyzeNativeText(candidate.text)
  const highRiskFonts = candidate.fonts.filter(font => font.risk !== 'none')
  const safeFonts = candidate.fonts.filter(font => font.risk === 'none')
  const rasterImages = candidate.rasterImages || []
  const placedImages = candidate.placedImages || []
  const fullPagePlacedImages = placedImages.filter(image => image.areaRatio >= 0.7
    && placedDimensionRatio(image, 0) >= 0.75
    && placedDimensionRatio(image, 1) >= 0.75)
  const meaningfulRegionalImages = placedImages.filter(image => image.areaRatio >= 0.2)
  const intrinsicFullPageRasterImages = rasterImages.filter(image => image.fullPageCandidate && image.pixels >= 262_144)
  const fullPageRasterImageCount = candidate.placementAnalysisAvailable
    ? fullPagePlacedImages.length
    : intrinsicFullPageRasterImages.length
  const meaningfulRasterContent = candidate.placementAnalysisAvailable
    ? fullPagePlacedImages.length > 0 || meaningfulRegionalImages.length > 0
    : candidate.pictureCount > 0 || intrinsicFullPageRasterImages.length > 0
  const reasons: string[] = []
  let classification: PdfTextQualityClass
  let recommendedRoute: PdfTextRoute

  if (nativeText.characterCount === 0 && candidate.fonts.length === 0 && !meaningfulRasterContent) {
    classification = 'blank'
    recommendedRoute = 'none'
    reasons.push('No native text, font resources, or extracted pictures were detected on the page.')
  } else if (nativeText.characterCount < 20 && meaningfulRasterContent) {
    classification = 'image-only'
    recommendedRoute = fullPageRasterImageCount > 0 || candidate.placementAnalysisAvailable !== true ? 'ocr-full-page' : 'ocr-regions'
    reasons.push(fullPageRasterImageCount > 0
      ? 'The page has a source-placed full-page raster but no meaningful native text candidate.'
      : 'The page has meaningful regional raster content but no meaningful native text candidate.')
  } else if (nativeText.stronglyCorrupted || (highRiskFonts.length > 0 && nativeText.characterCount >= 20)) {
    const mixedSignals = safeFonts.length > 0 || meaningfulRasterContent
    classification = mixedSignals ? 'mixed' : 'corrupted-native'
    recommendedRoute = mixedSignals ? 'ocr-regions' : 'ocr-full-page'
    if (nativeText.stronglyCorrupted) reasons.push('Native text has strong deterministic corruption signals.')
    if (highRiskFonts.length) reasons.push(`${highRiskFonts.length} composite Identity/CID font resource(s) lack a ToUnicode mapping.`)
    if (mixedSignals) reasons.push('Clean and suspicious or raster regions coexist, so regional OCR is preferred.')
  } else if (fullPageRasterImageCount > 0 && nativeText.characterCount >= 20) {
    classification = 'mixed'
    recommendedRoute = 'ocr-compare'
    reasons.push(`${fullPageRasterImageCount} full-page raster candidate(s) coexist with an extracted text layer; compare fresh OCR without replacing the retained layer automatically.`)
  } else if (nativeText.characterCount < 40) {
    classification = 'low-confidence'
    recommendedRoute = 'ocr-compare'
    reasons.push('The native text candidate is too sparse for a confident clean-native decision.')
  } else {
    classification = 'clean-native'
    recommendedRoute = 'native'
    reasons.push('Native text is sufficiently populated and has no strong corruption or high-risk font signals.')
  }

  return {
    page: candidate.page,
    classification,
    recommendedRoute,
    reasons,
    nativeText,
    pictureCount: candidate.pictureCount,
    fonts: candidate.fonts,
    highRiskFontCount: highRiskFonts.length,
    rasterImages,
    fullPageRasterImageCount,
  }
}

export function analyzeNativeText(value: string): PdfNativeTextMetrics {
  const normalized = value.normalize('NFKC').trim()
  const asciiLetters = normalized.match(/[A-Za-z]/g) || []
  const tokens = normalized.match(/[A-Za-z0-9]{4,}/g) || []
  const controlCharacterCount = (normalized.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length
  const vowelRatio = ratio((normalized.match(/[AEIOUYaeiouy]/g) || []).length, asciiLetters.length)
  const mixedTokenRatio = ratio(tokens.filter(token => /[A-Za-z]/.test(token) && /\d/.test(token)).length, tokens.length)
  const vowellessTokenRatio = ratio(tokens.filter(token => {
    const letters = token.replace(/[^A-Za-z]/g, '')
    return letters.length >= 5 && !/[AEIOUYaeiouy]/.test(letters)
  }).length, tokens.length)
  const stronglyCorrupted = normalized.length >= 180
    && asciiLetters.length >= 120
    && tokens.length >= 20
    && (controlCharacterCount > 0
      || mixedTokenRatio > 0.45
      || (vowelRatio < 0.16 && (mixedTokenRatio > 0.12 || vowellessTokenRatio > 0.35)))
  return {
    characterCount: normalized.length,
    asciiLetterCount: asciiLetters.length,
    tokenCount: tokens.length,
    vowelRatio: rounded(vowelRatio),
    mixedTokenRatio: rounded(mixedTokenRatio),
    vowellessTokenRatio: rounded(vowellessTokenRatio),
    controlCharacterCount,
    stronglyCorrupted,
  }
}

export function suspiciousTextPagesFromBlocks(
  blocks: Array<{ type: string; provenance?: { page?: number }; [key: string]: unknown }>,
): number[] {
  const pageText = new Map<number, string[]>()
  for (const block of blocks) {
    const text = blockPlainText(block).trim()
    if (!text) continue
    const page = Math.max(1, block.provenance?.page || 1)
    pageText.set(page, [...(pageText.get(page) || []), text])
  }
  return [...pageText.entries()]
    .filter(([, values]) => analyzeNativeText(values.join(' ')).stronglyCorrupted)
    .map(([page]) => page)
    .sort((left, right) => left - right)
}

async function packagePdfTextQualityUncached(pkg: AndocPackage): Promise<PdfTextQualityReport | null> {
  const importer = pkg.document.metadata.importer as Record<string, unknown> | undefined
  const source = isRecord(pkg.document.metadata.source)
  const sourcePageCount = Number(source?.pageCount)
  const stored = validatedPdfTextQualityReport(
    importer?.textQuality,
    Number.isInteger(sourcePageCount) && sourcePageCount > 0 ? sourcePageCount : undefined,
  )
  const storedHasLegacyRasterBlank = stored?.schema === PDF_TEXT_QUALITY_SCHEMA
    && Array.isArray(stored.pages)
    && stored.pages.some(page => page.classification === 'blank' && (page.rasterImages?.length || 0) > 0)
  if (stored && !storedHasLegacyRasterBlank) return stored
  const sourceEntry = pkg.manifest.entries.find(entry => entry.path.startsWith('sources/original/') && entry.mediaType === 'application/pdf')
  if (!sourceEntry) return null
  const sourceBytes = pkg.files[sourceEntry.path]
  const doclingBytes = pkg.files['sources/docling/document.json']
  if (!sourceBytes || !doclingBytes) return null
  const docling = JSON.parse(new TextDecoder().decode(doclingBytes)) as DoclingDocument
  let pageObjectAnalysis: PdfPageObjectAnalysis | null = null
  try {
    pageObjectAnalysis = await analyzePdfPageObjects(sourceBytes)
  } catch {
    // Intrinsic raster diagnostics remain a conservative fallback for legacy packages.
  }
  return analyzePdfTextQuality(sourceBytes, docling, pageObjectAnalysis)
}

function isRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0
}

function finiteNonNegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validNativeTextMetrics(value: Record<string, unknown>): boolean {
  return nonNegativeInteger(value.characterCount)
    && nonNegativeInteger(value.asciiLetterCount)
    && nonNegativeInteger(value.tokenCount)
    && finiteNonNegative(value.vowelRatio)
    && finiteNonNegative(value.mixedTokenRatio)
    && finiteNonNegative(value.vowellessTokenRatio)
    && nonNegativeInteger(value.controlCharacterCount)
    && typeof value.stronglyCorrupted === 'boolean'
}

function placedDimensionRatio(image: PdfPlacedImage, axis: 0 | 1): number {
  const span = Math.abs(image.bbox[axis + 2]! - image.bbox[axis]!)
  const pageSpan = axis === 0 ? image.pageSize.width : image.pageSize.height
  return pageSpan > 0 ? span / pageSpan : 0
}

function pageResourceDiagnostics(
  pdf: PDFDocument,
  resources: PDFDict | undefined,
  pageAspectRatio: number,
): { fonts: PdfFontDiagnostic[]; rasterImages: PdfRasterDiagnostic[] } {
  const fonts: PdfFontDiagnostic[] = []
  const rasterImages: PdfRasterDiagnostic[] = []
  const visited = new Set<string>()
  collectResourceDiagnostics(pdf, resources, pageAspectRatio, '', visited, fonts, rasterImages)
  return {
    fonts: dedupeDiagnostics(fonts, value => `${value.objectRef || ''}:${value.resource}:${value.subtype || ''}`),
    rasterImages: dedupeDiagnostics(rasterImages, value => `${value.objectRef || ''}:${value.resource}:${value.width}x${value.height}`),
  }
}

function collectResourceDiagnostics(
  pdf: PDFDocument,
  resources: PDFDict | undefined,
  pageAspectRatio: number,
  prefix: string,
  visited: Set<string>,
  fonts: PdfFontDiagnostic[],
  rasterImages: PdfRasterDiagnostic[],
): void {
  if (!resources) return
  fonts.push(...fontDiagnostics(pdf, resources, prefix))
  const xObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict)
  if (!xObjects) return
  for (const [resource, value] of xObjects.entries()) {
    const reference = value instanceof PDFRef ? value.toString() : `${prefix}${cleanPdfName(resource)}`
    if (visited.has(reference)) continue
    visited.add(reference)
    const object = pdf.context.lookup(value)
    if (!(object instanceof PDFStream)) continue
    const subtype = cleanPdfObject(object.dict.get(PDFName.of('Subtype')))
    const resourceName = `${prefix}${cleanPdfName(resource)}`
    if (subtype === 'Image') {
      const width = object.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() || 0
      const height = object.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber() || 0
      const pixels = width * height
      const imageMask = object.dict.lookupMaybe(PDFName.of('ImageMask'), PDFBool)?.asBoolean() || false
      const bitsPerComponent = object.dict.lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber)?.asNumber() ?? (imageMask ? 1 : null)
      const filter = cleanPdfObject(object.dict.get(PDFName.of('Filter')))
      const imageAspectRatio = height ? width / height : 0
      const aspectDelta = pageAspectRatio ? Math.abs(imageAspectRatio - pageAspectRatio) / pageAspectRatio : 1
      const monochrome = imageMask || bitsPerComponent === 1
      const pageAspectMonochrome = pixels >= 1_000_000 && monochrome && aspectDelta <= 0.08
      const croppedMonochromeStencil = pixels >= 10_000_000
        && monochrome
        && aspectDelta <= 0.20
        && (imageMask || filter?.includes('JBIG2Decode') || filter?.includes('CCITTFaxDecode'))
      const fullPageCandidateReason: PdfRasterDiagnostic['fullPageCandidateReason'] = pageAspectMonochrome
        ? 'page-aspect-monochrome'
        : croppedMonochromeStencil
          ? 'cropped-monochrome-stencil'
          : null
      rasterImages.push({
        resource: resourceName,
        objectRef: value instanceof PDFRef ? value.toString() : null,
        width,
        height,
        pixels,
        bitsPerComponent,
        imageMask,
        filter,
        pageAspectDelta: rounded(aspectDelta),
        fullPageCandidateReason,
        fullPageCandidate: fullPageCandidateReason !== null,
      })
      continue
    }
    if (subtype === 'Form') {
      const nestedResources = object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)
      collectResourceDiagnostics(pdf, nestedResources, pageAspectRatio, `${resourceName}/`, visited, fonts, rasterImages)
    }
  }
}

function fontDiagnostics(pdf: PDFDocument, resources: PDFDict, prefix = ''): PdfFontDiagnostic[] {
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)
  if (!fonts) return []
  return fonts.entries().map(([resource, value]): PdfFontDiagnostic => {
    const font = pdf.context.lookup(value)
    if (!(font instanceof PDFDict)) {
      return {
        resource: `${prefix}${cleanPdfName(resource)}`,
        objectRef: value instanceof PDFRef ? value.toString() : null,
        baseFont: null,
        subtype: null,
        encoding: null,
        hasToUnicode: false,
        risk: 'none',
      }
    }
    const subtype = cleanPdfObject(font.get(PDFName.of('Subtype')))
    const encoding = cleanPdfObject(font.get(PDFName.of('Encoding')))
    const hasToUnicode = Boolean(font.get(PDFName.of('ToUnicode')))
    const composite = subtype === 'Type0'
    const identityEncoding = encoding === 'Identity-H' || encoding === 'Identity-V'
    const risk: PdfFontDiagnostic['risk'] = !hasToUnicode && composite && identityEncoding
      ? 'identity-cid-without-to-unicode'
      : !hasToUnicode && composite
        ? 'composite-font-without-to-unicode'
        : 'none'
    return {
      resource: `${prefix}${cleanPdfName(resource)}`,
      objectRef: value instanceof PDFRef ? value.toString() : null,
      baseFont: cleanPdfObject(font.get(PDFName.of('BaseFont'))),
      subtype,
      encoding,
      hasToUnicode,
      risk,
    }
  }).sort((left, right) => left.resource.localeCompare(right.resource))
}

function dedupeDiagnostics<T>(values: T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>()
  for (const value of values) if (!result.has(key(value))) result.set(key(value), value)
  return [...result.values()]
}

export function textCandidatesByPage(docling: DoclingDocument, pageCount: number): Map<number, string[]> {
  const result = new Map<number, string[]>()
  for (const candidate of orderedPageTextCandidates(docling)) addPageText(result, candidate.page, candidate.text)
  for (let page = 1; page <= pageCount; page += 1) if (!result.has(page)) result.set(page, [])
  return result
}

interface OrderedPageTextCandidate {
  reference: string
  kind: 'text' | 'table'
  page: number
  spatialOrder: number
  text: string
  parent?: string
  children: string[]
}

// Docling may expose one logical merged table cell at every covered grid
// coordinate. It may also retain those table descendants in `texts`. The
// canonical importer already collapses those physical duplicates; machine-text
// diagnostics must use the same logical reading surface or a clean page can be
// inflated several times before routing and candidate comparison.
function orderedPageTextCandidates(docling: DoclingDocument): OrderedPageTextCandidate[] {
  const tables = docling.tables || []
  const pictures = docling.pictures || []
  const captionReferences = new Set(pictures.flatMap(picture => (picture.captions || []).map(reference => reference.$ref).filter((value): value is string => Boolean(value))))
  const tableDescendants = new Set(tables.flatMap(table => (table.children || []).map(reference => reference.$ref).filter((value): value is string => Boolean(value))))
  const candidates: OrderedPageTextCandidate[] = []

  for (const [index, item] of (docling.texts || []).entries()) {
    const reference = item.self_ref || `#/texts/${index}`
    const text = String(item.text || item.orig || '').trim()
    if (!text || item.content_layer === 'furniture' || captionReferences.has(reference) || tableDescendants.has(reference) || textInsideAnyTable(item, tables)) continue
    candidates.push({
      reference,
      kind: 'text',
      page: sourcePage(item.prov),
      spatialOrder: provenanceSpatialOrder(item.prov),
      text,
      parent: item.parent?.$ref,
      children: (item.children || []).map(child => child.$ref).filter((value): value is string => Boolean(value)),
    })
  }
  for (const [index, table] of tables.entries()) {
    const text = logicalTableText(table.data?.grid || [])
    if (!text) continue
    candidates.push({
      reference: table.self_ref || `#/tables/${index}`,
      kind: 'table',
      page: sourcePage(table.prov),
      spatialOrder: provenanceSpatialOrder(table.prov),
      text,
      parent: table.parent?.$ref,
      children: (table.children || []).map(child => child.$ref).filter((value): value is string => Boolean(value)),
    })
  }

  const byReference = new Map(candidates.map(candidate => [candidate.reference, candidate]))
  const groups = docling.groups || []
  const groupByReference = new Map(groups.map((group, index) => [group.self_ref || `#/groups/${index}`, group]))
  const pictureByReference = new Map(pictures.map((picture, index) => [picture.self_ref || `#/pictures/${index}`, picture]))
  const seen = new Set<string>()
  const ordered: OrderedPageTextCandidate[] = []
  const consume = (reference: string): void => {
    if (seen.has(reference)) return
    seen.add(reference)
    const candidate = byReference.get(reference)
    if (candidate) for (const child of candidate.children) consume(child)
    const group = groupByReference.get(reference)
    if (group) for (const child of group.children || []) if (child.$ref) consume(child.$ref)
    const picture = pictureByReference.get(reference)
    if (picture) for (const child of picture.children || []) if (child.$ref) consume(child.$ref)
  }
  const visit = (reference: string): void => {
    if (seen.has(reference)) return
    const group = groupByReference.get(reference)
    if (group) {
      if (group.content_layer === 'furniture' || /^(?:page[ -])?(?:header|footer)$/i.test(String(group.name || '').trim())) {
        consume(reference)
        return
      }
      seen.add(reference)
      for (const child of group.children || []) if (child.$ref) visit(child.$ref)
      return
    }
    const picture = pictureByReference.get(reference)
    if (picture) {
      consume(reference)
      return
    }
    const candidate = byReference.get(reference)
    if (!candidate) {
      seen.add(reference)
      return
    }
    seen.add(reference)
    ordered.push(candidate)
    for (const child of candidate.children) consume(child)
  }

  for (const child of docling.furniture?.children || []) if (child.$ref) consume(child.$ref)
  for (const child of docling.body?.children || []) if (child.$ref) visit(child.$ref)
  for (const candidate of [...candidates].sort((left, right) => left.page - right.page || left.spatialOrder - right.spatialOrder || left.reference.localeCompare(right.reference, undefined, { numeric: true }))) {
    if (!seen.has(candidate.reference) && (!candidate.parent || candidate.parent === '#/body')) visit(candidate.reference)
  }
  return ordered
}

function logicalTableText(grid: Array<Array<any>>): string {
  const rows: string[] = []
  for (const [rowIndex, row] of grid.entries()) {
    const logical = row
      .map((cell, columnIndex) => ({ cell, columnIndex }))
      .filter(({ cell, columnIndex }) => {
        if (!cell) return false
        if (Number.isInteger(cell.start_row_offset_idx) && Number(cell.start_row_offset_idx) !== rowIndex) return false
        if (Number.isInteger(cell.start_col_offset_idx) && Number(cell.start_col_offset_idx) !== columnIndex) return false
        return Boolean(String(cell.text || '').trim())
      })
    if (logical.length > 1 && logical.every(({ cell }) => typeof cell.bbox?.l === 'number')) {
      logical.sort((left, right) => Number(left.cell.bbox.l) - Number(right.cell.bbox.l) || left.columnIndex - right.columnIndex)
    }
    const text = logical.map(({ cell }) => String(cell.text || '').trim()).filter(Boolean).join(' ')
    if (text) rows.push(text)
  }
  return rows.join(' ')
}

function textInsideAnyTable(item: any, tables: any[]): boolean {
  const box = item.prov?.[0]?.bbox
  if (!box || ![box.l, box.b, box.r, box.t].every((value: unknown) => typeof value === 'number')) return false
  const page = sourcePage(item.prov)
  return tables.some(table => {
    if (sourcePage(table.prov) !== page) return false
    const tableBox = table.prov?.[0]?.bbox
    if (!tableBox || ![tableBox.l, tableBox.b, tableBox.r, tableBox.t].every((value: unknown) => typeof value === 'number')) return false
    const tolerance = 2
    return box.l >= tableBox.l - tolerance
      && box.r <= tableBox.r + tolerance
      && Math.min(box.b, box.t) >= Math.min(tableBox.b, tableBox.t) - tolerance
      && Math.max(box.b, box.t) <= Math.max(tableBox.b, tableBox.t) + tolerance
  })
}

function provenanceSpatialOrder(provenance: Array<{ bbox?: { t?: number; coord_origin?: string } }> | undefined): number {
  const box = provenance?.[0]?.bbox
  const top = Number(box?.t || 0)
  return box?.coord_origin === 'TOPLEFT' ? top : -top
}

function doclingPicturesByPage(docling: DoclingDocument, pageCount: number): Map<number, number> {
  const result = new Map<number, number>()
  for (const picture of docling.pictures || []) {
    const page = sourcePage(picture.prov)
    result.set(page, (result.get(page) || 0) + 1)
  }
  for (let page = 1; page <= pageCount; page += 1) if (!result.has(page)) result.set(page, 0)
  return result
}

function sourcePage(provenance: Array<{ page_no?: number }> | undefined): number {
  return Math.max(1, provenance?.[0]?.page_no || 1)
}

function addPageText(target: Map<number, string[]>, page: number, value: string): void {
  const text = value.trim()
  if (text) target.set(page, [...(target.get(page) || []), text])
}

function blockPlainText(block: { type: string; [key: string]: unknown }): string {
  if (block.type === 'paragraph' || block.type === 'heading') {
    return Array.isArray(block.content) ? block.content.map(run => String((run as { text?: string }).text || '')).join('') : ''
  }
  if (block.type === 'list' && Array.isArray(block.items)) {
    const itemText = (items: unknown[]): string => items.flatMap(item => {
      const value = item as { content?: Array<{ text?: string }>; children?: unknown[] }
      return [
        ...(Array.isArray(value.content) ? value.content.map(run => String(run.text || '')) : []),
        ...(Array.isArray(value.children) ? [itemText(value.children)] : []),
      ]
    }).filter(Boolean).join(' ')
    return itemText(block.items)
  }
  if (block.type === 'footnote') {
    return `${String(block.label || '')} ${Array.isArray(block.content) ? block.content.map(run => String((run as { text?: string }).text || '')).join('') : ''}`.trim()
  }
  if (block.type === 'extension') {
    return Array.isArray(block.fallback) ? block.fallback.map(run => String((run as { text?: string }).text || '')).join('') : ''
  }
  if (block.type === 'table' && Array.isArray(block.rows)) {
    return block.rows.flat().flatMap(cell => Array.isArray((cell as { content?: unknown[] }).content)
      ? (cell as { content: Array<{ text?: string }> }).content.map(run => String(run.text || ''))
      : []).join(' ')
  }
  if (block.type === 'image' || block.type === 'chart') return String(block.alt || '')
  return ''
}

function cleanPdfName(value: PDFName): string {
  return value.toString().replace(/^\//, '')
}

function cleanPdfObject(value: unknown): string | null {
  if (!value || typeof (value as { toString?: unknown }).toString !== 'function') return null
  return String(value).replace(/^\//, '')
}

function countClass(pages: PdfPageTextQuality[], classification: PdfTextQualityClass): number {
  return pages.filter(page => page.classification === classification).length
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0
}

function rounded(value: number): number {
  return Number(value.toFixed(6))
}
