import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { strToU8, zipSync } from 'fflate'
import { canonicalJson } from './hash.js'
import type { DoclingDocument } from './import-pdf.js'
import { ANX_PACKAGE_LIMITS, validateAndoc, type AndocPackage } from './package.js'
import { analyzeNativeText, type PdfPageTextQuality, type PdfTextQualityReport, textCandidatesByPage } from './pdf-text-quality.js'
import type { ManifestEntry } from './types.js'

const execFileAsync = promisify(execFile)
export const PDF_OCR_CANDIDATES_SCHEMA = 'agn.pdf-ocr-candidates.v1' as const
const OCR_CANDIDATES_PATH = 'sources/ocr/candidates.json'
const FIXED_ZIP_TIME = new Date('1980-01-02T00:00:00.000Z')

export interface PdfOcrLine {
  text: string
  confidence: number
  box: Array<[number, number]>
  fragments?: Array<{ text: string; confidence: number; box: Array<[number, number]> }>
}

export interface PdfOcrPageCandidate {
  page: number
  route: PdfPageTextQuality['recommendedRoute']
  nativeCandidate: {
    text: string
    sha256: string
    metrics: ReturnType<typeof analyzeNativeText>
  }
  ocrCandidate: {
    text: string
    sha256: string
    meanConfidence: number
    minimumConfidence: number
    lineCount: number
    rawLineCount?: number
    lines: PdfOcrLine[]
  }
  comparison: {
    normalizedSimilarity: number
    tokenOverlap: number
    numericAgreement: {
      status: 'agree' | 'disagree' | 'unverifiable'
      nativeTokens: string[]
      ocrTokens: string[]
      sharedTokens: number
      nativeOnly: string[]
      ocrOnly: string[]
    }
    numericReviewRequired: boolean
    recommendation: 'retain-native' | 'prefer-ocr-candidate' | 'human-review'
    reasons: string[]
  }
  render: {
    widthPixels: number
    heightPixels: number
    dpi: number
  }
  resolution?: {
    escalated: boolean
    reason: string | null
    fragmentationRatio: number
    variants: Array<{ dpi: number; rawLineCount: number; lineCount: number; fragmentationRatio: number; meanConfidence: number }>
  }
  timing: {
    engineElapsedMs: number
    wallElapsedMs: number
  }
}

export interface PdfOcrCandidatesReport {
  schema: typeof PDF_OCR_CANDIDATES_SCHEMA
  sourceSha256: string
  generatedAt: string
  automaticCanonicalChange: false
  routedPages: number[]
  engine: RapidOcrBridgeOutput['engine']
  renderer: RapidOcrBridgeOutput['renderer']
  pages: PdfOcrPageCandidate[]
}

export interface GeneratePdfOcrCandidatesOptions {
  pythonCommand?: string
  bridgePath?: string
  policyPath?: string
  dpi?: number
  pageBatchSize?: number
  timeoutSeconds?: number
  generatedAt?: string
  signal?: AbortSignal
  onProgress?: (event: {
    phase: 'primary' | 'adaptive'
    completedPages: number
    totalPages: number
    message: string
  }) => void
}

export function packagePdfOcrCandidates(pkg: AndocPackage): PdfOcrCandidatesReport | null {
  const bytes = pkg.files[OCR_CANDIDATES_PATH]
  if (!bytes) return null
  try {
    const report = JSON.parse(new TextDecoder().decode(bytes)) as PdfOcrCandidatesReport
    return report.schema === PDF_OCR_CANDIDATES_SCHEMA && Array.isArray(report.pages) ? report : null
  } catch {
    return null
  }
}

/**
 * Returns OCR evidence only when it is safe to expose in Studio. The raw
 * parser above intentionally remains permissive so transaction validation can
 * continue to report precise evidence-binding errors.
 */
export function validatedPackagePdfOcrCandidates(pkg: AndocPackage): PdfOcrCandidatesReport | null {
  const report = packagePdfOcrCandidates(pkg)
  return report && validPdfOcrCandidatesForPackage(pkg, report) ? report : null
}

function validPdfOcrCandidatesForPackage(pkg: AndocPackage, report: PdfOcrCandidatesReport): boolean {
  if (!validPdfOcrCandidatesStructure(report)) return false

  const source = objectRecord(pkg.document.metadata.source)
  const sourcePath = typeof source?.embeddedPath === 'string' ? source.embeddedPath : ''
  const pageCount = Number(source?.pageCount)
  const sourceEntry = pkg.manifest.entries.find(entry => entry.path === sourcePath)
  const sourceBytes = sourcePath ? pkg.files[sourcePath] : undefined
  if (!sourceEntry
    || sourceEntry.role !== 'source'
    || sourceEntry.mediaType !== 'application/pdf'
    || !sourceBytes
    || sha256(sourceBytes) !== sourceEntry.sha256
    || source?.sha256 !== sourceEntry.sha256
    || report.sourceSha256 !== sourceEntry.sha256
    || !Number.isInteger(pageCount)
    || pageCount < 1) return false

  const routedPages = report.routedPages
  if (routedPages.length !== report.pages.length) return false
  const seen = new Set<number>()
  for (let index = 0; index < report.pages.length; index += 1) {
    const page = report.pages[index]
    const pageNumber = page?.page
    if (!page
      || typeof pageNumber !== 'number'
      || !Number.isInteger(pageNumber)
      || pageNumber < 1
      || pageNumber > pageCount
      || seen.has(pageNumber)
      || routedPages[index] !== pageNumber
      || sha256Text(page.nativeCandidate.text) !== page.nativeCandidate.sha256
      || sha256Text(page.ocrCandidate.text) !== page.ocrCandidate.sha256) return false
    seen.add(pageNumber)
  }
  return true
}

function validPdfOcrCandidatesStructure(report: PdfOcrCandidatesReport): boolean {
  if (!report
    || report.schema !== PDF_OCR_CANDIDATES_SCHEMA
    || report.automaticCanonicalChange !== false
    || !isSha256(report.sourceSha256)
    || typeof report.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(report.generatedAt))
    || !Array.isArray(report.routedPages)
    || !Array.isArray(report.pages)
    || !objectRecord(report.engine)
    || typeof report.engine.name !== 'string'
    || !report.engine.name.trim()
    || typeof report.engine.version !== 'string'
    || !report.engine.version.trim()
    || typeof report.engine.runtime !== 'string'
    || !report.engine.runtime.trim()
    || typeof report.engine.policyId !== 'string'
    || !report.engine.policyId.trim()
    || !Array.isArray(report.engine.models)
    || !objectRecord(report.renderer)
    || typeof report.renderer.name !== 'string'
    || !report.renderer.name.trim()
    || typeof report.renderer.version !== 'string'
    || !report.renderer.version.trim()
    || !positiveFinite(report.renderer.dpi)) return false

  const invoked = report.pages.length > 0
  if (invoked && (!isSha256(report.engine.policySha256) || report.engine.models.length < 1)) return false
  if (!invoked && report.engine.policySha256 !== '' && !isSha256(report.engine.policySha256)) return false

  return report.pages.every(page => {
    if (!page
      || !Number.isInteger(page.page)
      || page.page < 1
      || typeof page.route !== 'string'
      || !page.route.startsWith('ocr-')
      || typeof page.nativeCandidate?.text !== 'string'
      || !isSha256(page.nativeCandidate?.sha256)
      || typeof page.ocrCandidate?.text !== 'string'
      || !isSha256(page.ocrCandidate?.sha256)
      || !finiteProbability(page.ocrCandidate?.meanConfidence)
      || !finiteProbability(page.ocrCandidate?.minimumConfidence)
      || !Number.isInteger(page.ocrCandidate?.lineCount)
      || page.ocrCandidate.lineCount < 0
      || !Array.isArray(page.ocrCandidate?.lines)
      || page.ocrCandidate.lines.length !== page.ocrCandidate.lineCount
      || !objectRecord(page.comparison)
      || !['retain-native', 'prefer-ocr-candidate', 'human-review'].includes(page.comparison.recommendation)
      || !objectRecord(page.render)
      || !positiveFinite(page.render.widthPixels)
      || !positiveFinite(page.render.heightPixels)
      || !positiveFinite(page.render.dpi)
      || !objectRecord(page.timing)
      || !nonNegativeFinite(page.timing.engineElapsedMs)
      || !nonNegativeFinite(page.timing.wallElapsedMs)) return false

    const hasText = Boolean(page.ocrCandidate.text.trim())
    if (hasText !== (page.ocrCandidate.lineCount > 0)) return false
    return true
  })
}

export function missingRequiredPdfOcrPages(
  report: PdfOcrCandidatesReport | null,
  requiredPages: number[],
): number[] {
  const covered = new Set((report?.pages || []).map(page => page.page))
  return [...new Set(requiredPages)].filter(page => !covered.has(page)).sort((left, right) => left - right)
}

export function assertRequiredPdfOcrCoverage(
  report: PdfOcrCandidatesReport,
  textQuality: PdfTextQualityReport,
): void {
  if (!validPdfOcrCandidatesStructure(report)) {
    throw new Error('Required selective OCR report is structurally invalid')
  }
  const expected = textQuality.pages.filter(page => page.recommendedRoute.startsWith('ocr-')).map(page => page.page)
  const returned = report.pages.map(page => page.page)
  if (report.routedPages.length !== expected.length
    || report.routedPages.some((page, index) => page !== expected[index])
    || returned.length !== expected.length
    || returned.some((page, index) => page !== expected[index])) {
    throw new Error(`Required selective OCR coverage mismatch: expected [${expected.join(',')}], routed [${report.routedPages.join(',')}], candidates [${returned.join(',')}]`)
  }
  if (report.pages.some((page, index) => page.route !== textQuality.pages.find(candidate => candidate.page === expected[index])?.recommendedRoute)) {
    throw new Error('Required selective OCR route evidence does not match the deterministic text-quality decision')
  }
}

/** Attach derived OCR evidence while byte-preserving every existing package entry. */
export async function packageWithPdfOcrCandidates(
  pkg: AndocPackage,
  report: PdfOcrCandidatesReport,
): Promise<Uint8Array> {
  if (pkg.finalizations.length) throw new Error('Cannot attach candidate evidence to a finalized package; derive a draft first')
  if (!validPdfOcrCandidatesForPackage(pkg, report)) throw new Error('Cannot attach invalid or source-unbound OCR candidate evidence')
  const source = objectRecord(pkg.document.metadata.source)
  const sourcePath = typeof source?.embeddedPath === 'string' ? source.embeddedPath : ''
  const sourceEntry = pkg.manifest.entries.find(entry => entry.path === sourcePath)
  if (!sourceEntry || sourceEntry.role !== 'source' || sourceEntry.mediaType !== 'application/pdf' || report.sourceSha256 !== sourceEntry.sha256) {
    throw new Error('Cannot attach candidate evidence because its source hash does not match the retained PDF')
  }
  const files = Object.fromEntries(Object.entries(pkg.files).map(([entryPath, bytes]) => [entryPath, new Uint8Array(bytes)]))
  const candidateBytes = strToU8(`${JSON.stringify(report, null, 2)}\n`)
  files[OCR_CANDIDATES_PATH] = candidateBytes

  const candidateEntry: ManifestEntry = {
    path: OCR_CANDIDATES_PATH,
    mediaType: 'application/json',
    sha256: sha256(candidateBytes),
    size: candidateBytes.length,
    role: 'source',
  }
  const manifest = structuredClone(pkg.manifest)
  manifest.entries = manifest.entries
    .filter(entry => entry.path !== OCR_CANDIDATES_PATH)
    .concat(candidateEntry)
    .sort((left, right) => left.path.localeCompare(right.path))
  files['manifest.json'] = strToU8(canonicalJson(manifest))
  assertEvidencePackageLimits(files)

  const ordered = Object.fromEntries(Object.entries(files).sort(([left], [right]) => packageOrder(left) - packageOrder(right) || left.localeCompare(right)))
  const packageBytes = zipSync(ordered, { level: 6, mtime: FIXED_ZIP_TIME })
  const validation = await validateAndoc(packageBytes)
  if (!validation.ok) {
    throw new Error(`Cannot attach OCR candidate evidence without changing package integrity: ${validation.issues.map(issue => `${issue.code} ${issue.path}`).join('; ')}`)
  }
  return packageBytes
}

function assertEvidencePackageLimits(files: Record<string, Uint8Array>): void {
  const entries = Object.entries(files)
  if (entries.length > ANX_PACKAGE_LIMITS.maximumEntries) throw new Error('OCR evidence attachment exceeds the ANX entry-count limit')
  let expandedBytes = 0
  for (const [entryPath, bytes] of entries) {
    if (bytes.length > ANX_PACKAGE_LIMITS.maximumEntryBytes) throw new Error(`OCR evidence attachment entry exceeds the ANX size limit: ${entryPath}`)
    expandedBytes += bytes.length
    if (expandedBytes > ANX_PACKAGE_LIMITS.maximumExpandedBytes) throw new Error('OCR evidence attachment exceeds the ANX expanded-size limit')
  }
}

function packageOrder(entryPath: string): number {
  if (entryPath === 'mimetype') return 0
  if (entryPath === 'manifest.json') return 1
  if (entryPath === 'document.json') return 2
  return 3
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

interface RapidOcrBridgePage {
  page: number
  widthPixels: number
  heightPixels: number
  text: string
  meanConfidence: number
  minimumConfidence: number
  lineCount: number
  rawLineCount?: number
  fragmentationRatio?: number
  renderDpi?: number
  resolutionEscalated?: boolean
  resolutionEscalationReason?: string | null
  resolutionVariants?: Array<{ dpi: number; rawLineCount: number; lineCount: number; fragmentationRatio: number; meanConfidence: number }>
  lines: PdfOcrLine[]
  engineElapsedMs: number
  wallElapsedMs: number
}

interface RapidOcrBridgeOutput {
  schema: 'agn.rapidocr-bridge-output.v1'
  engine: {
    name: string
    version: string
    runtime: string
    policyId: string
    policySha256: string
    processPeakRssBytes?: number
    pageBatchSize?: number
    batchCount?: number
    models: Array<{ role: string; family: string; variant: string; file: string; sha256: string; bytes: number }>
  }
  renderer: { name: string; version: string; dpi: number; adaptiveDpi?: number | null; fragmentationRatioThreshold?: number | null }
  pdfSha256: string
  pages: RapidOcrBridgePage[]
}

export async function generatePdfOcrCandidates(
  pdfBytes: Uint8Array,
  docling: DoclingDocument,
  textQuality: PdfTextQualityReport,
  options: GeneratePdfOcrCandidatesOptions = {},
): Promise<PdfOcrCandidatesReport> {
  const routed = textQuality.pages.filter(page => page.recommendedRoute.startsWith('ocr-'))
  const routedPages = routed.map(page => page.page)
  const sourceSha256 = sha256(pdfBytes)
  if (!routedPages.length) {
    return {
      schema: PDF_OCR_CANDIDATES_SCHEMA,
      sourceSha256,
      generatedAt: options.generatedAt || new Date().toISOString(),
      automaticCanonicalChange: false,
      routedPages: [],
      engine: { name: 'RapidOCR', version: 'not-invoked', runtime: 'onnxruntime', policyId: 'not-invoked', policySha256: '', processPeakRssBytes: 0, pageBatchSize: normalizedBatchSize(options.pageBatchSize), batchCount: 0, models: [] },
      renderer: { name: 'pypdfium2', version: 'not-invoked', dpi: options.dpi || 200 },
      pages: [],
    }
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agn-selective-ocr-'))
  const pdfPath = path.join(tempRoot, 'source.pdf')
  try {
    await writeFile(pdfPath, pdfBytes)
    const pythonCommand = await resolvePythonCommand(options.pythonCommand)
    const bridgePath = options.bridgePath || await resolveWorkspaceFile('scripts/rapidocr_bridge.py')
    const policyPath = options.policyPath || await resolveWorkspaceFile('config/rapidocr-ppocrv5-en.json')
    const pageBatchSize = normalizedBatchSize(options.pageBatchSize)
    const outputs: RapidOcrBridgeOutput[] = []
    let completedPages = 0
    for (const batch of pageBatches(routedPages, pageBatchSize)) {
      throwIfAborted(options.signal)
      const { stdout } = await execFileAsync(pythonCommand, [
        bridgePath,
        '--pdf', pdfPath,
        '--pages', batch.join(','),
        '--policy', policyPath,
        '--disable-adaptive',
        ...(options.dpi ? ['--dpi', String(options.dpi)] : []),
      ], {
        timeout: Math.max(30, Math.min(options.timeoutSeconds || 600, 1800)) * 1000,
        maxBuffer: 128 * 1024 * 1024,
        encoding: 'utf8',
        signal: options.signal,
      })
      const output = JSON.parse(stdout) as RapidOcrBridgeOutput
      validateBridgeOutput(output, sourceSha256, batch)
      outputs.push(output)
      completedPages += batch.length
      options.onProgress?.({
        phase: 'primary',
        completedPages,
        totalPages: routedPages.length,
        message: `Prepared source-bound OCR evidence for ${completedPages} of ${routedPages.length} page${routedPages.length === 1 ? '' : 's'}.`,
      })
    }
    let bridge = mergeBridgeOutputs(outputs, routedPages, pageBatchSize)
    const adaptiveDpi = Number(bridge.renderer.adaptiveDpi || 0)
    const fragmentationThreshold = Number(bridge.renderer.fragmentationRatioThreshold || 0)
    const escalationOutputs: RapidOcrBridgeOutput[] = []
    if (adaptiveDpi && fragmentationThreshold) {
      for (const candidate of bridge.pages.filter(page => Number(page.fragmentationRatio || 0) > fragmentationThreshold)) {
        throwIfAborted(options.signal)
        options.onProgress?.({
          phase: 'adaptive',
          completedPages: routedPages.length,
          totalPages: routedPages.length,
          message: `Refining fragmented OCR evidence on page ${candidate.page}.`,
        })
        const { stdout } = await execFileAsync(pythonCommand, [
          bridgePath,
          '--pdf', pdfPath,
          '--pages', String(candidate.page),
          '--policy', policyPath,
          '--dpi', String(adaptiveDpi),
          '--disable-adaptive',
        ], {
          timeout: Math.max(30, Math.min(options.timeoutSeconds || 600, 1800)) * 1000,
          maxBuffer: 128 * 1024 * 1024,
          encoding: 'utf8',
          signal: options.signal,
        })
        const output = JSON.parse(stdout) as RapidOcrBridgeOutput
        validateBridgeOutput(output, sourceSha256, [candidate.page])
        escalationOutputs.push(output)
      }
      bridge = applyResolutionEscalations(bridge, escalationOutputs, fragmentationThreshold)
    }

    const nativeByPage = textCandidatesByPage(docling, textQuality.pageCount)
    const qualityByPage = new Map(routed.map(page => [page.page, page]))
    const pages = bridge.pages.map(candidate => {
      const quality = qualityByPage.get(candidate.page)
      if (!quality) throw new Error(`Selective OCR returned unrouted page ${candidate.page}`)
      const nativeText = nativeByPage.get(candidate.page)?.join(' ') || ''
      const comparison = comparePdfTextCandidates(nativeText, candidate.text, candidate.meanConfidence, quality)
      return {
        page: candidate.page,
        route: quality.recommendedRoute,
        nativeCandidate: { text: nativeText, sha256: sha256Text(nativeText), metrics: analyzeNativeText(nativeText) },
        ocrCandidate: {
          text: candidate.text,
          sha256: sha256Text(candidate.text),
          meanConfidence: candidate.meanConfidence,
          minimumConfidence: candidate.minimumConfidence,
          lineCount: candidate.lineCount,
          ...(candidate.rawLineCount !== undefined ? { rawLineCount: candidate.rawLineCount } : {}),
          lines: candidate.lines,
        },
        comparison,
        render: { widthPixels: candidate.widthPixels, heightPixels: candidate.heightPixels, dpi: candidate.renderDpi || bridge.renderer.dpi },
        ...(candidate.resolutionEscalated !== undefined ? {
          resolution: {
            escalated: candidate.resolutionEscalated,
            reason: candidate.resolutionEscalationReason || null,
            fragmentationRatio: candidate.fragmentationRatio || 0,
            variants: candidate.resolutionVariants || [],
          },
        } : {}),
        timing: { engineElapsedMs: candidate.engineElapsedMs, wallElapsedMs: candidate.wallElapsedMs },
      }
    })
    return {
      schema: PDF_OCR_CANDIDATES_SCHEMA,
      sourceSha256,
      generatedAt: options.generatedAt || new Date().toISOString(),
      automaticCanonicalChange: false,
      routedPages,
      engine: bridge.engine,
      renderer: bridge.renderer,
      pages,
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('OCR candidate generation was cancelled')
  error.name = 'AbortError'
  throw error
}

export function comparePdfTextCandidates(
  nativeText: string,
  ocrText: string,
  ocrConfidence: number,
  quality: Pick<PdfPageTextQuality, 'recommendedRoute' | 'nativeText'>,
): PdfOcrPageCandidate['comparison'] {
  const nativeNormalized = normalizedText(nativeText)
  const ocrNormalized = normalizedText(ocrText)
  const normalizedSimilarity = diceCoefficient(nativeNormalized, ocrNormalized)
  const tokenOverlap = jaccard(tokens(nativeNormalized), tokens(ocrNormalized))
  const numericAgreement = compareNumericTokens(nativeText, ocrText)
  const numericReviewRequired = numericAgreement.status !== 'agree' && (numericAgreement.nativeTokens.length > 0 || numericAgreement.ocrTokens.length > 0)
  const reasons: string[] = []
  let recommendation: PdfOcrPageCandidate['comparison']['recommendation']

  if (!ocrNormalized || ocrConfidence < 0.6) {
    recommendation = nativeNormalized ? 'retain-native' : 'human-review'
    reasons.push('The fresh OCR candidate is empty or below the minimum confidence floor.')
  } else if (!nativeNormalized || quality.recommendedRoute === 'ocr-full-page' || quality.nativeText.stronglyCorrupted) {
    recommendation = 'prefer-ocr-candidate'
    reasons.push('The native candidate is absent or deterministically suspect and the OCR candidate clears the confidence floor.')
  } else if (quality.recommendedRoute === 'ocr-regions') {
    recommendation = 'human-review'
    reasons.push('Regional disagreement cannot be resolved safely from page-level text alone.')
  } else if (normalizedSimilarity >= 0.92 && tokenOverlap >= 0.85) {
    recommendation = 'retain-native'
    reasons.push('The retained text layer and fresh OCR substantially agree; retaining native text preserves existing structure and citations.')
  } else {
    recommendation = 'human-review'
    reasons.push('The retained text layer and fresh OCR materially disagree, so neither candidate is promoted automatically.')
  }
  if (numericReviewRequired) reasons.push('Numeric tokens differ between the retained and OCR candidates; numeric fields require explicit review before promotion.')
  reasons.push('Candidate comparison never changes canonical ANX content automatically.')
  return { normalizedSimilarity: rounded(normalizedSimilarity), tokenOverlap: rounded(tokenOverlap), numericAgreement, numericReviewRequired, recommendation, reasons }
}

function compareNumericTokens(nativeText: string, ocrText: string): PdfOcrPageCandidate['comparison']['numericAgreement'] {
  const nativeTokens = extractNumericTokens(nativeText)
  const ocrTokens = extractNumericTokens(ocrText)
  const ocrRemaining = [...ocrTokens]
  const shared: string[] = []
  const nativeOnly: string[] = []
  for (const token of nativeTokens) {
    const index = ocrRemaining.indexOf(token)
    if (index >= 0) {
      shared.push(token)
      ocrRemaining.splice(index, 1)
    } else {
      nativeOnly.push(token)
    }
  }
  const status = !nativeTokens.length && !ocrTokens.length
    ? 'unverifiable'
    : nativeOnly.length || ocrRemaining.length
      ? 'disagree'
      : 'agree'
  return { status, nativeTokens, ocrTokens, sharedTokens: shared.length, nativeOnly, ocrOnly: ocrRemaining }
}

function extractNumericTokens(value: string): string[] {
  return value.normalize('NFKC').match(/[-+]?[$€£]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|[-+]?[$€£]?\d+(?:\.\d+)?%?/g) || []
}

function normalizedBatchSize(value?: number): number {
  const configured = value ?? Number(process.env.ANX_OCR_PAGE_BATCH_SIZE || process.env.AGN_OCR_PAGE_BATCH_SIZE || 4)
  if (!Number.isFinite(configured)) return 4
  return Math.max(1, Math.min(32, Math.trunc(configured)))
}

function pageBatches(pages: number[], size: number): number[][] {
  const batches: number[][] = []
  for (let index = 0; index < pages.length; index += size) batches.push(pages.slice(index, index + size))
  return batches
}

function validateBridgeOutput(output: RapidOcrBridgeOutput, sourceSha256: string, requestedPages: number[]): void {
  if (output.schema !== 'agn.rapidocr-bridge-output.v1') throw new Error('Selective OCR bridge returned an unsupported schema')
  if (output.pdfSha256 !== sourceSha256) throw new Error('Selective OCR bridge source hash does not match the retained PDF')
  const returnedPages = output.pages.map(page => page.page)
  if (returnedPages.length !== requestedPages.length || returnedPages.some((page, index) => page !== requestedPages[index])) {
    throw new Error(`Selective OCR produced pages [${returnedPages.join(',')}], expected [${requestedPages.join(',')}]`)
  }
}

function mergeBridgeOutputs(outputs: RapidOcrBridgeOutput[], routedPages: number[], pageBatchSize: number): RapidOcrBridgeOutput {
  const first = outputs[0]
  if (!first) throw new Error('Selective OCR produced no bridge output')
  const identity = bridgeIdentity(first)
  for (const output of outputs.slice(1)) {
    if (bridgeIdentity(output) !== identity) throw new Error('Selective OCR bridge identity changed between page batches')
  }
  const byPage = new Map(outputs.flatMap(output => output.pages).map(page => [page.page, page]))
  const pages = routedPages.map(page => {
    const candidate = byPage.get(page)
    if (!candidate) throw new Error(`Selective OCR did not return routed page ${page}`)
    return candidate
  })
  return {
    ...first,
    engine: {
      ...first.engine,
      processPeakRssBytes: Math.max(...outputs.map(output => Number(output.engine.processPeakRssBytes || 0))),
      pageBatchSize,
      batchCount: outputs.length,
    },
    pages,
  }
}

function applyResolutionEscalations(base: RapidOcrBridgeOutput, escalations: RapidOcrBridgeOutput[], threshold: number): RapidOcrBridgeOutput {
  const escalatedByPage = new Map(escalations.flatMap(output => output.pages).map(page => [page.page, page]))
  const pages = base.pages.map(page => {
    const escalated = escalatedByPage.get(page.page)
    if (!escalated) return page
    return {
      ...escalated,
      engineElapsedMs: rounded(Number(page.engineElapsedMs || 0) + Number(escalated.engineElapsedMs || 0)),
      wallElapsedMs: rounded(Number(page.wallElapsedMs || 0) + Number(escalated.wallElapsedMs || 0)),
      resolutionEscalated: true,
      resolutionEscalationReason: `base fragmentation ratio ${page.fragmentationRatio || 0} exceeded ${threshold}`,
      resolutionVariants: [...(page.resolutionVariants || []), ...(escalated.resolutionVariants || [])],
    }
  })
  return {
    ...base,
    engine: {
      ...base.engine,
      processPeakRssBytes: Math.max(Number(base.engine.processPeakRssBytes || 0), ...escalations.map(output => Number(output.engine.processPeakRssBytes || 0))),
    },
    pages,
  }
}

function bridgeIdentity(output: RapidOcrBridgeOutput): string {
  return JSON.stringify({
    source: output.pdfSha256,
    engine: {
      name: output.engine.name,
      version: output.engine.version,
      runtime: output.engine.runtime,
      policyId: output.engine.policyId,
      policySha256: output.engine.policySha256,
      models: output.engine.models,
    },
    renderer: output.renderer,
  })
}

async function resolvePythonCommand(explicit?: string): Promise<string> {
  const candidates = [explicit, process.env.ANX_OCR_PYTHON, process.env.AGN_OCR_PYTHON, '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3', 'python3'].filter(Boolean) as string[]
  for (const candidate of candidates) {
    if (!candidate.includes(path.sep)) return candidate
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to the next local runtime candidate.
    }
  }
  throw new Error('No Python runtime with RapidOCR was found. Set ANX_OCR_PYTHON (legacy AGN_OCR_PYTHON is also accepted).')
}

async function resolveWorkspaceFile(relativePath: string): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(process.cwd(), '..', relativePath),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK)
      return candidate
    } catch {
      // Continue.
    }
  }
  throw new Error(`Could not resolve ${relativePath} from the current workspace`)
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function tokens(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(Boolean))
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
  const leftPairs = bigrams(left)
  const rightPairs = bigrams(right)
  let overlap = 0
  const remaining = new Map(rightPairs)
  for (const [pair, count] of leftPairs) {
    const matched = Math.min(count, remaining.get(pair) || 0)
    overlap += matched
    remaining.set(pair, (remaining.get(pair) || 0) - matched)
  }
  return (2 * overlap) / ([...leftPairs.values()].reduce((sum, value) => sum + value, 0) + [...rightPairs.values()].reduce((sum, value) => sum + value, 0))
}

function bigrams(value: string): Map<string, number> {
  const result = new Map<string, number>()
  for (let index = 0; index < value.length - 1; index += 1) {
    const pair = value.slice(index, index + 2)
    result.set(pair, (result.get(pair) || 0) + 1)
  }
  return result
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1
  const intersection = [...left].filter(value => right.has(value)).length
  return intersection / new Set([...left, ...right]).size
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function finiteProbability(value: unknown): value is number {
  return nonNegativeFinite(value) && value <= 1
}

function rounded(value: number): number {
  return Number(value.toFixed(6))
}
