import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { importedSharedContentIndex } from './agent-shared-content.js'
import { canonicalJson, sha256 } from './hash.js'
import { packAndoc } from './package.js'
import {
  analyzePdfPageObjects,
  mergePdfPageObjectEvidence,
  type PdfPageObjectAnalysis,
  type PdfSourceRegionDraft,
  type PdfTextGeometry,
} from './pdf-page-objects.js'
import { assertRequiredPdfOcrCoverage, generatePdfOcrCandidates, type PdfOcrCandidatesReport } from './pdf-ocr.js'
import { analyzePdfTextQuality, type PdfTextQualityReport } from './pdf-text-quality.js'
import {
  ANDOC_DOCUMENT_SCHEMA,
  type AndocAsset,
  type AndocBlock,
  type AndocDocument,
  type Provenance,
  type TableCell,
  type TextRun,
} from './types.js'

const execFileAsync = promisify(execFile)

export type DocumentImportFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx'
export type DocumentVisualAssetPolicy = 'embedded' | 'source-backed'
export type DocumentImportProgressStage =
  | 'source-staged'
  | 'docling-running'
  | 'docling-complete'
  | 'text-quality'
  | 'selective-ocr'
  | 'visual-evidence'
  | 'normalizing'
  | 'packaging'
  | 'complete'

export interface DocumentImportProgress {
  stage: DocumentImportProgressStage
  progress: number
  message: string
}

export interface DocumentImportIdentity {
  format: DocumentImportFormat
  safeName: string
  sourceHash: string
  documentId: string
  mediaType: string
}

export class DocumentImportError extends Error {
  readonly code = 'DOCUMENT_IMPORT_FAILED'

  constructor(
    public readonly format: DocumentImportFormat,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${format.toUpperCase()} import failed: ${message}`, options)
    this.name = 'DocumentImportError'
  }
}

const sourceMediaTypes: Record<DocumentImportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

interface DoclingBoundingBox {
  l?: number
  t?: number
  r?: number
  b?: number
  coord_origin?: string
}

interface DoclingProvenance {
  page_no?: number
  bbox?: DoclingBoundingBox
}

interface DoclingReference {
  $ref?: string
}

interface DoclingTextItem {
  self_ref?: string
  label?: string
  text?: string
  orig?: string
  level?: number
  prov?: DoclingProvenance[]
  parent?: DoclingReference
  children?: DoclingReference[]
  content_layer?: string
}

interface DoclingGroupItem {
  self_ref?: string
  label?: string
  name?: string
  parent?: DoclingReference
  children?: DoclingReference[]
  content_layer?: string
}

interface DoclingTableCell {
  text?: string
  row_span?: number
  col_span?: number
  column_header?: boolean
  row_header?: boolean
  bbox?: DoclingBoundingBox
  start_col_offset_idx?: number
  start_row_offset_idx?: number
}

interface DoclingTableItem {
  self_ref?: string
  label?: string
  prov?: DoclingProvenance[]
  parent?: DoclingReference
  children?: DoclingReference[]
  captions?: DoclingReference[]
  footnotes?: DoclingReference[]
  content_layer?: string
  data?: {
    grid?: Array<Array<DoclingTableCell | null>>
  }
}

interface DoclingPicturePrediction {
  class_name?: string
  confidence?: number
}

interface DoclingPictureItem {
  self_ref?: string
  label?: string
  prov?: DoclingProvenance[]
  parent?: DoclingReference
  children?: DoclingReference[]
  content_layer?: string
  captions?: DoclingReference[]
  image?: {
    mimetype?: string
    uri?: string
    dpi?: number
    size?: { width?: number; height?: number }
  }
  meta?: {
    description?: { text?: string; created_by?: string }
    classification?: { predictions?: DoclingPicturePrediction[] }
    tabular_chart?: { title?: string; chart_data?: unknown }
    [key: string]: unknown
  }
  annotations?: Array<Record<string, unknown>>
}

interface DoclingPageInfo {
  page_no?: number
  size?: { width?: number; height?: number }
  [key: string]: unknown
}

interface PageFurnitureMetadata {
  role: 'header-logo' | 'footer-logo'
  recurring: true
  occurrence: number
  occurrenceCount: number
  sourceBand: 'top' | 'bottom'
}

type DoclingLayoutItem =
  | { kind: 'text'; item: DoclingTextItem; index: number; page: number; top: number }
  | { kind: 'table'; item: DoclingTableItem; index: number; page: number; top: number }
  | { kind: 'picture'; item: DoclingPictureItem; index: number; page: number; top: number }

export interface DoclingDocument {
  schema_name?: string
  version?: string
  name?: string
  origin?: Record<string, unknown>
  texts?: DoclingTextItem[]
  tables?: DoclingTableItem[]
  pictures?: DoclingPictureItem[]
  groups?: DoclingGroupItem[]
  body?: DoclingGroupItem
  furniture?: DoclingGroupItem
  pages?: Record<string, DoclingPageInfo>
  [key: string]: unknown
}

export interface DoclingPicturePayload {
  bytes: Uint8Array
  mediaType: string
}

export interface PdfImportStats {
  sourceFormat: DocumentImportFormat
  pageCount: number
  headingBlocks: number
  paragraphBlocks: number
  tableBlocks: number
  imageBlocks: number
  chartBlocks: number
  chartBlocksWithData: number
  pictureItems: number
  pictureItemsNotYetMapped: number
  textQualityPagesRequiringOcr: number
  textQualityCorruptedPages: number
  selectiveOcrCandidatePages: number
  sourceBytes: number
  importTelemetry: ImportTelemetry
}

export interface ImportTelemetry {
  schema: 'agn.import-telemetry.v2'
  measurementScope: 'node-importer-and-child-processes'
  childMemoryMetric: 'sum-rss-descendant-process-tree'
  childPeakRssBytes: number | null
  samplingIntervalMs: number
  stages: Array<{ stage: string; rssBytes: number; elapsedMs: number }>
  doclingRuns: Array<{ ocr: boolean; forceOcr: boolean; classifyPictures: boolean; pageBatchSize: number; threads: number; durationMs: number; childPeakRssBytes: number | null }>
}

export interface NormalizedPdfImport {
  document: AndocDocument
  assets: Record<string, Uint8Array>
  sources: Record<string, Uint8Array>
  stats: PdfImportStats
  sourcePath: string
}

export interface PdfImportResult extends NormalizedPdfImport {
  packageBytes: Uint8Array
  doclingVersion: string | null
  doclingCliVersion: string | null
}

export interface PdfImportOptions {
  importedAt?: string
  ocr?: boolean
  forceOcr?: boolean
  ocrEngine?: 'rapidocr' | 'tesseract' | 'tesserocr' | 'easyocr' | 'ocrmac' | 'auto'
  selectiveOcr?: boolean
  requireSelectiveOcr?: boolean
  selectiveOcrDpi?: number
  selectiveOcrPython?: string
  classifyPictures?: boolean
  timeoutSeconds?: number
  doclingCommand?: string
  doclingPageBatchSize?: number
  doclingThreads?: number
  visualAssetPolicy?: DocumentVisualAssetPolicy
  signal?: AbortSignal
  onProgress?: (event: DocumentImportProgress) => void
}

export interface DocumentImportOptions extends PdfImportOptions {
  format?: DocumentImportFormat
}

interface ImportDetails {
  pictureClassificationRequested?: boolean
  pictureClassificationApplied?: boolean
  pictureClassificationWarning?: string | null
  textQuality?: PdfTextQualityReport | null
  textQualityWarning?: string | null
  ocrEngine?: string | null
  forceOcr?: boolean
  doclingCliVersion?: string | null
  importTelemetry?: ImportTelemetry
  visualAssetPolicy?: DocumentVisualAssetPolicy
  pageObjectAnalysis?: PdfPageObjectAnalysis | null
  pageObjectAnalysisWarning?: string | null
}

export async function importPdfToAndoc(
  pdfBytes: Uint8Array,
  fileName: string,
  options: PdfImportOptions = {},
): Promise<PdfImportResult> {
  assertPdf(pdfBytes)
  return importDocumentToAndoc(pdfBytes, fileName, { ...options, format: 'pdf' })
}

export function documentImportIdentity(
  sourceBytes: Uint8Array,
  fileName: string,
  requestedFormat?: DocumentImportFormat,
): DocumentImportIdentity {
  const format = requestedFormat || sourceFormatFromName(fileName)
  assertSource(sourceBytes, format)
  const safeName = safeSourceName(fileName, format)
  const sourceHash = sha256(sourceBytes)
  return {
    format,
    safeName,
    sourceHash,
    documentId: `${format}-${sourceHash.slice(0, 24)}`,
    mediaType: sourceMediaTypes[format],
  }
}

export async function importDocumentToAndoc(
  sourceBytes: Uint8Array,
  fileName: string,
  options: DocumentImportOptions = {},
): Promise<PdfImportResult> {
  const identity = documentImportIdentity(sourceBytes, fileName, options.format)
  const { format, safeName } = identity
  const importedAt = options.importedAt || new Date().toISOString()
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'andoc-docling-'))
  const inputPath = path.join(tempRoot, safeName)
  const outputDirectory = path.join(tempRoot, 'output')
  const visualAssetPolicy = options.visualAssetPolicy || 'embedded'
  const progress = (stage: DocumentImportProgressStage, percentage: number, message: string): void => {
    options.onProgress?.({ stage, progress: percentage, message })
  }

  try {
    throwIfImportAborted(options.signal)
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(inputPath, sourceBytes)
    progress('source-staged', 8, 'Source retained and ready for immediate viewing.')
    const timeoutSeconds = Math.max(30, Math.min(options.timeoutSeconds || 240, 600))
    const doclingCommand = await resolveDoclingCommand(options.doclingCommand || process.env.ANX_DOCLING_BIN || process.env.AGN_DOCLING_BIN || process.env.ANDOC_DOCLING_BIN)
    const doclingCliVersion = await resolveDoclingCliVersion(doclingCommand)
    const doclingPageBatchSize = boundedInteger(options.doclingPageBatchSize ?? Number(process.env.ANX_DOCLING_PAGE_BATCH_SIZE || process.env.AGN_DOCLING_PAGE_BATCH_SIZE || 4), 1, 32, 4)
    const doclingThreads = boundedInteger(options.doclingThreads ?? Number(process.env.ANX_DOCLING_THREADS || process.env.AGN_DOCLING_THREADS || 2), 1, 32, 2)
    const ocrEngine = options.ocrEngine || process.env.ANX_OCR_ENGINE || process.env.AGN_OCR_ENGINE || process.env.ANDOC_OCR_ENGINE || 'rapidocr'
    const classifyPictures = options.classifyPictures !== false
    const importStartedAt = performance.now()
    const importTelemetry: ImportTelemetry = {
      schema: 'agn.import-telemetry.v2',
      measurementScope: 'node-importer-and-child-processes',
      childMemoryMetric: 'sum-rss-descendant-process-tree',
      childPeakRssBytes: null,
      samplingIntervalMs: 250,
      stages: [{ stage: 'source-staged', rssBytes: process.memoryUsage().rss, elapsedMs: 0 }],
      doclingRuns: [],
    }
    const recordDoclingRun = async (ocr: boolean, force: boolean, classify: boolean): Promise<void> => {
      throwIfImportAborted(options.signal)
      progress('docling-running', 18, 'Docling is extracting document structure.')
      const startedAt = performance.now()
      const run = await runDocling(doclingCommand, inputPath, outputDirectory, timeoutSeconds, format, ocr, force, ocrEngine, classify, doclingPageBatchSize, doclingThreads, visualAssetPolicy, options.signal)
      importTelemetry.doclingRuns.push({ ocr, forceOcr: force, classifyPictures: classify, pageBatchSize: doclingPageBatchSize, threads: doclingThreads, durationMs: roundedMilliseconds(performance.now() - startedAt), childPeakRssBytes: run.childPeakRssBytes })
      importTelemetry.childPeakRssBytes = maximumNullable(importTelemetry.childPeakRssBytes, run.childPeakRssBytes)
    }
    const executePipeline = async (ocr: boolean, forceOcr = false): Promise<{ classificationApplied: boolean; classificationWarning: string | null }> => {
      if (!classifyPictures) {
        await recordDoclingRun(ocr, forceOcr, false)
        return { classificationApplied: false, classificationWarning: null }
      }
      try {
        await recordDoclingRun(ocr, forceOcr, true)
        return { classificationApplied: true, classificationWarning: null }
      } catch (error) {
        const classificationWarning = `Picture classification was unavailable; visuals were retained as images. ${errorMessage(error)}`
        await resetOutputDirectory(outputDirectory)
        await recordDoclingRun(ocr, forceOcr, false)
        return { classificationApplied: false, classificationWarning }
      }
    }

    let ocrApplied = format === 'pdf' && options.ocr === true
    const forceOcr = ocrApplied && options.forceOcr === true
    let pipeline = await executePipeline(ocrApplied, forceOcr)
    let docling = await readDoclingOutput(outputDirectory)
    progress('docling-complete', 68, 'Document structure extraction is complete.')
    importTelemetry.stages.push({ stage: 'initial-docling-complete', rssBytes: process.memoryUsage().rss, elapsedMs: roundedMilliseconds(performance.now() - importStartedAt) })
    let textQuality: PdfTextQualityReport | null = null
    let textQualityWarning: string | null = null
    let pageObjectAnalysis: PdfPageObjectAnalysis | null = null
    let pageObjectAnalysisWarning: string | null = null
    if (format === 'pdf') {
      try {
        pageObjectAnalysis = await analyzePdfPageObjects(sourceBytes)
      } catch (error) {
        pageObjectAnalysisWarning = `PDF page-object geometry diagnostics were unavailable. ${errorMessage(error)}`
      }
      try {
        textQuality = await analyzePdfTextQuality(sourceBytes, docling, pageObjectAnalysis)
      } catch (error) {
        textQualityWarning = `PDF text-quality diagnostics were unavailable. ${errorMessage(error)}`
      }
    }
    progress('text-quality', 74, 'Text quality and source evidence were analyzed.')
    if (format === 'pdf' && options.selectiveOcr === true && !ocrApplied && options.requireSelectiveOcr === true && !textQuality) {
      throw new Error(textQualityWarning || 'Required PDF text-quality diagnostics were unavailable')
    }
    if (format === 'pdf' && options.ocr === undefined && options.selectiveOcr !== true && !hasExtractableText(docling)) {
      await resetOutputDirectory(outputDirectory)
      ocrApplied = true
      pipeline = await executePipeline(true, false)
      docling = await readDoclingOutput(outputDirectory)
      importTelemetry.stages.push({ stage: 'ocr-retry-complete', rssBytes: process.memoryUsage().rss, elapsedMs: roundedMilliseconds(performance.now() - importStartedAt) })
    }
    let selectiveOcr: PdfOcrCandidatesReport | null = null
    let selectiveOcrWarning: string | null = null
    if (format === 'pdf' && options.selectiveOcr === true && !ocrApplied && textQuality) {
      try {
        const routedPages = textQuality.pages.filter(page => page.recommendedRoute.startsWith('ocr-')).length
        progress('selective-ocr', 75, routedPages
          ? `Preparing source-bound OCR evidence for ${routedPages} page${routedPages === 1 ? '' : 's'}. Canonical content will not change.`
          : 'No pages require alternate OCR evidence.')
        selectiveOcr = await generatePdfOcrCandidates(sourceBytes, docling, textQuality, {
          pythonCommand: options.selectiveOcrPython,
          dpi: options.selectiveOcrDpi,
          timeoutSeconds,
          generatedAt: importedAt,
          signal: options.signal,
          onProgress: event => {
            const ratio = event.totalPages ? event.completedPages / event.totalPages : 1
            progress('selective-ocr', Math.min(81, 75 + Math.round(ratio * 6)), event.message)
          },
        })
        if (options.requireSelectiveOcr === true) assertRequiredPdfOcrCoverage(selectiveOcr, textQuality)
        importTelemetry.childPeakRssBytes = maximumNullable(importTelemetry.childPeakRssBytes, selectiveOcr.engine.processPeakRssBytes || null)
        importTelemetry.stages.push({ stage: 'selective-ocr-complete', rssBytes: process.memoryUsage().rss, elapsedMs: roundedMilliseconds(performance.now() - importStartedAt) })
      } catch (error) {
        if (options.signal?.aborted || options.requireSelectiveOcr === true) throw error
        selectiveOcrWarning = `Selective OCR candidates were unavailable; the retained source and deterministic routing remain available. ${errorMessage(error)}`
      }
    }
    throwIfImportAborted(options.signal)
    const picturePayloads = await readPicturePayloads(docling, outputDirectory)
    progress('visual-evidence', 82, visualAssetPolicy === 'source-backed'
      ? 'Visual regions were retained by source coordinates without duplicate raster assets.'
      : 'Visual assets were collected for portable reflow rendering.')
    progress('normalizing', 88, 'Stable blocks, IDs, provenance, and regions are being normalized.')
    const normalized = normalizeDoclingDocument(
      docling,
      sourceBytes,
      safeName,
      importedAt,
      ocrApplied,
      picturePayloads,
      {
        pictureClassificationRequested: classifyPictures,
        pictureClassificationApplied: pipeline.classificationApplied,
        pictureClassificationWarning: pipeline.classificationWarning,
        textQuality,
        textQualityWarning,
        ocrEngine: ocrApplied ? ocrEngine : null,
        forceOcr,
        doclingCliVersion,
        importTelemetry,
        visualAssetPolicy,
        pageObjectAnalysis,
        pageObjectAnalysisWarning,
      },
      format,
    )
    if (selectiveOcr) {
      normalized.sources['sources/ocr/candidates.json'] = strToU8(canonicalJson(selectiveOcr))
      const importer = normalized.document.metadata.importer as Record<string, unknown>
      importer.selectiveOcr = {
        schema: selectiveOcr.schema,
        evidencePath: 'sources/ocr/candidates.json',
        routedPages: selectiveOcr.routedPages,
        candidatePages: selectiveOcr.pages.length,
        automaticCanonicalChange: selectiveOcr.automaticCanonicalChange,
        engine: selectiveOcr.engine,
        renderer: selectiveOcr.renderer,
      }
      normalized.stats.selectiveOcrCandidatePages = selectiveOcr.pages.length
    }
    if (selectiveOcrWarning) {
      const warnings = normalized.document.metadata.importWarnings as string[]
      warnings.push(selectiveOcrWarning)
    }
    throwIfImportAborted(options.signal)
    progress('packaging', 94, 'The canonical ANX package is being assembled and validated.')
    const packageBytes = await packAndoc({ document: normalized.document, assets: normalized.assets, sources: normalized.sources })
    progress('complete', 100, 'ANX conversion is complete.')
    return { ...normalized, packageBytes, doclingVersion: docling.version || null, doclingCliVersion }
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    const message = cause?.code === 'ENOENT'
      ? 'Docling executable was not found. Install the local Docling CLI or set ANX_DOCLING_BIN (legacy AGN_DOCLING_BIN and ANDOC_DOCLING_BIN are also accepted).'
      : errorMessage(error)
    throw new DocumentImportError(format, message, { cause: error })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function resetOutputDirectory(outputDirectory: string): Promise<void> {
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
}

async function readDoclingOutput(outputDirectory: string): Promise<DoclingDocument> {
  const outputNames = await readdir(outputDirectory)
  const jsonName = outputNames.find(name => name.toLowerCase().endsWith('.json'))
  if (!jsonName) throw new Error('Docling did not produce a JSON document')
  return JSON.parse(await readFile(path.join(outputDirectory, jsonName), 'utf8')) as DoclingDocument
}

function hasExtractableText(docling: DoclingDocument): boolean {
  return (docling.texts || []).some(item => String(item.text || item.orig || '').trim().length > 0)
}

async function runDocling(
  command: string,
  inputPath: string,
  outputDirectory: string,
  timeoutSeconds: number,
  format: DocumentImportFormat,
  ocr: boolean,
  forceOcr: boolean,
  ocrEngine: string,
  classifyPictures: boolean,
  pageBatchSize: number,
  threads: number,
  visualAssetPolicy: DocumentVisualAssetPolicy,
  signal?: AbortSignal,
): Promise<{ childPeakRssBytes: number | null }> {
  const args = [
    inputPath,
    '--from', format,
    '--to', 'json',
    '--image-export-mode', visualAssetPolicy === 'source-backed' ? 'placeholder' : 'referenced',
    ocr ? '--ocr' : '--no-ocr',
    forceOcr ? '--force-ocr' : '--no-force-ocr',
    ...(ocr ? ['--ocr-engine', ocrEngine] : []),
    '--tables',
    '--table-mode', 'accurate',
    classifyPictures ? '--enrich-picture-classes' : '--no-enrich-picture-classes',
    '--device', 'cpu',
    '--num-threads', String(threads),
    '--page-batch-size', String(pageBatchSize),
    '--document-timeout', String(timeoutSeconds),
    '--abort-on-error',
    '--output', outputDirectory,
  ]
  return runMeasuredChild(command, args, {
    timeoutMs: (timeoutSeconds + 30) * 1000,
    maxBufferBytes: 8 * 1024 * 1024,
    sampleIntervalMs: 250,
    env: { ...process.env, TORCHDYNAMO_DISABLE: process.env.TORCHDYNAMO_DISABLE || '1' },
    signal,
  })
}

async function runMeasuredChild(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBufferBytes: number; sampleIntervalMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ childPeakRssBytes: number | null }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(importAbortError())
      return
    }
    const child = spawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let peakRssBytes: number | null = null
    let timedOut = false
    let outputExceeded = false
    let closed = false
    let aborted = false

    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length
      if (outputBytes > options.maxBufferBytes) {
        outputExceeded = true
        child.kill('SIGTERM')
        return
      }
      target.push(chunk)
    }
    child.stdout?.on('data', chunk => capture(stdout, Buffer.from(chunk)))
    child.stderr?.on('data', chunk => capture(stderr, Buffer.from(chunk)))

    const sample = async (): Promise<void> => {
      if (!child.pid || closed) return
      const rss = await processTreeRssBytes(child.pid)
      peakRssBytes = maximumNullable(peakRssBytes, rss)
    }
    void sample()
    const sampler = setInterval(() => void sample(), options.sampleIntervalMs)
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 2_000)
      hardKill.unref()
    }, options.timeoutMs)
    const abort = (): void => {
      aborted = true
      child.kill('SIGTERM')
      const hardKill = setTimeout(() => child.kill('SIGKILL'), 2_000)
      hardKill.unref()
    }
    options.signal?.addEventListener('abort', abort, { once: true })

    child.once('error', error => {
      closed = true
      clearInterval(sampler)
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code, signal) => {
      closed = true
      clearInterval(sampler)
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      const stdoutText = Buffer.concat(stdout).toString('utf8')
      const stderrText = Buffer.concat(stderr).toString('utf8')
      if (aborted) {
        reject(importAbortError())
        return
      }
      if (timedOut) {
        reject(new Error(`Docling timed out after ${options.timeoutMs} ms${stderrText ? `: ${stderrText.trim()}` : ''}`))
        return
      }
      if (outputExceeded) {
        reject(new Error(`Docling output exceeded ${options.maxBufferBytes} bytes`))
        return
      }
      if (code !== 0) {
        reject(new Error(`Docling exited with ${code ?? signal ?? 'unknown status'}${stderrText ? `: ${stderrText.trim()}` : stdoutText ? `: ${stdoutText.trim()}` : ''}`))
        return
      }
      resolve({ childPeakRssBytes: peakRssBytes })
    })
  })
}

function throwIfImportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw importAbortError()
}

function importAbortError(): Error {
  const error = new Error('Document import was cancelled')
  error.name = 'AbortError'
  return error
}

async function processTreeRssBytes(rootPid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 2_000, maxBuffer: 8 * 1024 * 1024 })
    const rows = stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number)).filter(parts => parts.length === 3 && parts.every(Number.isFinite))
    const descendants = new Set([rootPid])
    let changed = true
    while (changed) {
      changed = false
      for (const [pid, parentPid] of rows) {
        if (!descendants.has(pid!) && descendants.has(parentPid!)) {
          descendants.add(pid!)
          changed = true
        }
      }
    }
    const rssKilobytes = rows.filter(([pid]) => descendants.has(pid!)).reduce((sum, [, , rss]) => sum + (rss || 0), 0)
    return rssKilobytes > 0 ? rssKilobytes * 1024 : null
  } catch {
    return null
  }
}

function maximumNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.max(left, right)
}

async function resolveDoclingCommand(explicit?: string): Promise<string> {
  if (explicit) return explicit
  const candidates = [
    '/Library/Frameworks/Python.framework/Versions/Current/bin/docling',
    '/opt/homebrew/bin/docling',
    '/usr/local/bin/docling',
  ]
  try {
    const versionsRoot = '/Library/Frameworks/Python.framework/Versions'
    const versions = (await readdir(versionsRoot)).sort().reverse()
    candidates.push(...versions.map(version => path.join(versionsRoot, version, 'bin/docling')))
  } catch {
    // Non-macOS environments normally resolve Docling through PATH below.
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next known local installation path.
    }
  }
  return 'docling'
}

async function resolveDoclingCliVersion(command: string): Promise<string | null> {
  const explicit = process.env.ANX_DOCLING_VERSION || process.env.AGN_DOCLING_VERSION || process.env.ANDOC_DOCLING_VERSION
  if (explicit?.trim()) return explicit.trim()
  try {
    const executable = path.isAbsolute(command)
      ? command
      : (await execFileAsync('which', [command], { timeout: 5_000 })).stdout.trim()
    const shebang = (await readFile(executable, 'utf8')).split(/\r?\n/, 1)[0] || ''
    const python = shebang.match(/^#!([^\s]+python(?:3(?:\.\d+)?)?)/)?.[1]
    if (!python) return null
    const result = await execFileAsync(python, ['-c', 'import importlib.metadata; print(importlib.metadata.version("docling"))'], { timeout: 5_000 })
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

async function readPicturePayloads(
  docling: DoclingDocument,
  outputDirectory: string,
): Promise<Record<string, DoclingPicturePayload>> {
  const result: Record<string, DoclingPicturePayload> = {}
  for (const [index, picture] of (docling.pictures || []).entries()) {
    const reference = picture.self_ref || `#/pictures/${index}`
    const uri = picture.image?.uri
    if (!uri) continue
    const embedded = decodeDataUri(uri)
    if (embedded) {
      result[reference] = { bytes: embedded.bytes, mediaType: picture.image?.mimetype || embedded.mediaType }
      continue
    }
    const filePath = await resolvePicturePath(uri, outputDirectory)
    if (!filePath) continue
    result[reference] = {
      bytes: new Uint8Array(await readFile(filePath)),
      mediaType: picture.image?.mimetype || mediaTypeFromPath(filePath),
    }
  }
  return result
}

async function resolvePicturePath(uri: string, outputDirectory: string): Promise<string | null> {
  let value = uri
  if (uri.startsWith('file://')) {
    try {
      value = fileURLToPath(uri)
    } catch {
      return null
    }
  }
  const candidates = path.isAbsolute(value)
    ? [value]
    : [
        path.resolve(outputDirectory, value),
        path.resolve(path.dirname(outputDirectory), value),
        path.resolve(process.cwd(), value),
      ]
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK)
      return candidate
    } catch {
      // Continue until the referenced artifact is found.
    }
  }
  return null
}

function decodeDataUri(value: string): DoclingPicturePayload | null {
  const match = value.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
  if (!match) return null
  const mediaType = match[1] || 'application/octet-stream'
  const bytes = match[2]
    ? new Uint8Array(Buffer.from(match[3] || '', 'base64'))
    : strToU8(decodeURIComponent(match[3] || ''))
  return { bytes, mediaType }
}

export function normalizeDoclingDocument(
  docling: DoclingDocument,
  sourceBytes: Uint8Array,
  fileName: string,
  importedAt = new Date().toISOString(),
  ocrRequested = true,
  picturePayloads: Record<string, DoclingPicturePayload> = {},
  importDetails: ImportDetails = {},
  format: DocumentImportFormat = 'pdf',
): NormalizedPdfImport {
  assertSource(sourceBytes, format)
  const safeName = safeSourceName(fileName, format)
  const sourceHash = sha256(sourceBytes)
  const sourcePath = `sources/original/${safeName}`
  const sourceId = `${format}-${sourceHash.slice(0, 24)}`
  const texts = docling.texts || []
  const tables = docling.tables || []
  const pictures = docling.pictures || []
  const sourcePageSizes = doclingPageSizes(docling)
  const furnitureReferences = doclingFurnitureReferences(docling)
  const pictureFurniture = recurringPictureFurniture(pictures, picturePayloads, sourcePageSizes)
  const textByReference = new Map(texts.map((item, index) => [item.self_ref || `#/texts/${index}`, item]))
  const nativeDocxPages = format === 'docx' ? docxTextPageAssignments(sourceBytes, texts) : new Map<string, number>()
  const captionReferences = new Set([
    ...pictures.flatMap(picture => (picture.captions || []).map(reference => reference.$ref).filter((value): value is string => Boolean(value))),
    ...tables.flatMap(table => (table.captions || []).map(reference => reference.$ref).filter((value): value is string => Boolean(value))),
  ])
  const officeFurnitureText = format === 'docx' ? docxFurnitureText(sourceBytes) : new Set<string>()
  const spatialLayoutItems: DoclingLayoutItem[] = [
    ...texts
      .map((item, index) => ({ kind: 'text' as const, item, index }))
      .filter(candidate => !captionReferences.has(candidate.item.self_ref || `#/texts/${candidate.index}`))
      .filter(candidate => isNoteTextItem(candidate.item) || !isTextInsideTable(candidate.item, tables)),
    ...tables.map((item, index) => ({ kind: 'table' as const, item, index })),
    ...pictures.map((item, index) => ({ kind: 'picture' as const, item, index })),
  ].map(candidate => ({
    ...candidate,
    page: candidate.kind === 'text'
      ? nativeDocxPages.get(candidate.item.self_ref || `#/texts/${candidate.index}`) || pageNumber(candidate.item)
      : pageNumber(candidate.item),
    top: candidate.item.prov?.[0]?.bbox?.t ?? 0,
  })).sort((left, right) => left.page - right.page || right.top - left.top || layoutKindOrder(left.kind) - layoutKindOrder(right.kind) || left.index - right.index)
  const layoutItems = orderedDoclingLayout(docling, spatialLayoutItems, captionReferences, officeFurnitureText)
  const officeTitleReference = inferredOfficeTitleReference(layoutItems, format)

  const blocks: AndocBlock[] = []
  const assets: Record<string, Uint8Array> = {}
  const assetMetadata: Record<string, AndocAsset> = {}
  let sourceBackedRegions: PdfSourceRegionDraft[] = []
  const warnings: string[] = []
  if (importDetails.pictureClassificationWarning) warnings.push(importDetails.pictureClassificationWarning)
  if (importDetails.textQualityWarning) warnings.push(importDetails.textQualityWarning)
  if (importDetails.pageObjectAnalysisWarning) warnings.push(importDetails.pageObjectAnalysisWarning)
  if (format === 'pdf' && importDetails.textQuality?.summary.pagesRequiringOcr && !ocrRequested) {
    warnings.push(`${importDetails.textQuality.summary.pagesRequiringOcr} PDF page(s) require selective OCR or candidate comparison according to deterministic text/font diagnostics.`)
  }
  if ([...nativeDocxPages.values()].some(page => page > 1)) warnings.push('Native Word page-break markers were used to recover page provenance because Docling did not provide page numbers for matched paragraphs.')
  let currentPage: number | null = null
  let headingCount = 0
  let missingPictures = 0
  let reconciledTablePictures = 0
  let suppressedDecorativePictures = 0
  let chartBlocksWithData = 0
  let inferredNumberedHeadings = 0

  for (const [layoutIndex, candidate] of layoutItems.entries()) {
    if (currentPage !== null && candidate.page !== currentPage) {
      blocks.push({
        id: stableId('page-break', sourceHash, `after-page-${currentPage}`),
        type: 'pageBreak',
        provenance: {
          kind: 'imported',
          sourceId,
          sourceUri: sourcePath,
          page: currentPage,
          capturedAt: importedAt,
        },
      })
    }
    currentPage = candidate.page

    if (candidate.kind === 'text') {
      const text = String(candidate.item.text || candidate.item.orig || '').trim()
      if (!text) continue
      const reference = candidate.item.self_ref || `text-${candidate.index}`
      const provenance = toProvenance(candidate.item, sourceId, sourcePath, importedAt, candidate.page)
      const label = candidate.item.label || 'text'
      const inferredOfficeTitle = reference === officeTitleReference && label !== 'title' && label !== 'section_header'
      const inferredNumberedHeading = numberedSectionHeading(text, label)
      if (isNoteTextItem(candidate.item)) {
        const note = splitNoteMarker(text)
        blocks.push({
          id: stableId('footnote', sourceHash, reference),
          type: 'footnote',
          label: note.marker,
          content: [{ text: note.content }],
          noteKind: normalizedNoteKind(label),
          anchorStatus: 'uncertain',
          provenance,
          attrs: doclingAttrs(candidate.item, reference, label),
        })
      } else if (label === 'title' || label === 'section_header' || inferredOfficeTitle || inferredNumberedHeading) {
        const level = inferredNumberedHeading?.level || (headingCount === 0 ? 1 : clampHeadingLevel((candidate.item.level || 1) + 1))
        headingCount += 1
        if (inferredNumberedHeading) inferredNumberedHeadings += 1
        if (inferredOfficeTitle) warnings.push(format === 'pptx'
          ? 'The most prominent page-one presentation paragraph was promoted to the document title because Docling did not label its visual title style.'
          : 'The first Office paragraph was promoted to the document title because Docling did not label its visual title style.')
        blocks.push({
          id: stableId('heading', sourceHash, reference),
          type: 'heading',
          level,
          content: [{ text }],
          provenance,
          attrs: {
            ...doclingAttrs(candidate.item, reference, label),
            ...(inferredOfficeTitle ? { inferredRole: 'document-title' } : {}),
            ...(inferredNumberedHeading ? {
              sectionNumber: inferredNumberedHeading.sectionNumber,
              headingDetection: 'deterministic-numbered-heading',
            } : {}),
          },
        })
      } else {
        blocks.push({
          id: stableId('paragraph', sourceHash, reference),
          type: 'paragraph',
          content: [{ text }],
          provenance,
          attrs: doclingAttrs(candidate.item, reference, label),
        })
      }
      continue
    }

    if (candidate.kind === 'table') {
      const reference = candidate.item.self_ref || `table-${candidate.index}`
      const blockId = stableId('table', sourceHash, reference)
      const grid = candidate.item.data?.grid || []
      const provenance = toProvenance(candidate.item, sourceId, sourcePath, importedAt, candidate.page)
      const captionText = tableCaption(candidate.item, textByReference)
      const rows = grid.map((row, rowIndex) => orderedTableRow(row, rowIndex).map(({ cell, sourceGridColumn }, columnIndex) => tableCell(
        cell,
        rowIndex,
        columnIndex,
        sourceGridColumn,
        sourceHash,
        reference,
        provenance,
      ))).filter(row => row.length > 0)
      if (!rows.length) continue
      blocks.push({
        id: blockId,
        type: 'table',
        rows,
        ...(captionText ? { caption: [{ text: captionText }] } : {}),
        provenance,
        attrs: doclingAttrs(candidate.item, reference, candidate.item.label || 'table'),
      })
      sourceBackedRegions.push(...captionSourceRegions(
        candidate.item.captions,
        textByReference,
        sourceHash,
        sourcePath,
        importedAt,
        `region-${blockId}`,
        'table',
        blockId,
      ))
      continue
    }

    const reference = candidate.item.self_ref || `#/pictures/${candidate.index}`
    const payload = picturePayloads[reference]
    const captionText = pictureCaption(candidate.item, textByReference)
    const classification = primaryPictureClassification(candidate.item)
    const description = pictureDescription(candidate.item)
    const alt = description || captionText || `${classification?.className || 'Imported visual'} from page ${candidate.page}`
    const caption = captionText ? [{ text: captionText }] satisfies TextRun[] : undefined
    const chartData = extractedChartData(candidate.item)
    const chart = isChartPicture(candidate.item, classification, chartData, `${captionText} ${description}`)
    const provenance = toProvenance(candidate.item, sourceId, sourcePath, importedAt, candidate.page, classification?.confidence ?? undefined)
    const regionKind = sourceRegionKind(classification?.className || '', `${captionText} ${description}`, chart, classification?.confidence ?? null)
    const decorativePicture = decorativeSourcePicture(classification?.className || '', classification?.confidence ?? null, captionText, provenance.bbox, sourcePageSizes[String(candidate.page)])
    const duplicateCanonicalTable = regionKind === 'table' && Boolean(provenance.bbox) && blocks.some(block =>
      block.type === 'table'
      && block.provenance?.page === candidate.page
      && Boolean(block.provenance.bbox)
      && bboxOverlapRatio(block.provenance!.bbox!, provenance.bbox!) >= 0.85
    )
    const attrs = {
      ...doclingAttrs(candidate.item, reference, candidate.item.label || 'picture'),
      pictureClassification: classification || null,
      imageDpi: candidate.item.image?.dpi || null,
      imageSize: candidate.item.image?.size || null,
      regionKind,
      ...(pictureFurniture.get(reference) ? { pageFurniture: pictureFurniture.get(reference) } : {}),
    }
    let assetId: string | undefined
    if (payload?.bytes.length) {
      const payloadHash = sha256(payload.bytes)
      assetId = stableId('asset', payloadHash, payload.mediaType)
      const extension = extensionForMediaType(payload.mediaType)
      const packagePath = `assets/${format}/${assetId}.${extension}` as const
      if (!assetMetadata[assetId]) {
        assetMetadata[assetId] = {
          id: assetId,
          packagePath,
          mediaType: payload.mediaType,
          sha256: payloadHash,
          size: payload.bytes.length,
          originalName: path.basename(String(candidate.item.image?.uri || `${assetId}.${extension}`)),
          description: alt,
        }
        assets[assetId] = payload.bytes
      }
    } else {
      missingPictures += 1
    }

    if (chart) {
      if (chartData !== null) chartBlocksWithData += 1
      const blockId = stableId('chart', sourceHash, reference)
      blocks.push({
        id: blockId,
        type: 'chart',
        alt,
        ...(assetId ? { fallbackAssetId: assetId } : {}),
        caption,
        spec: {
          schema: 'andoc.chart.v1',
          chartType: normalizeChartType(classification?.className || 'chart'),
          data: chartData,
          extraction: {
            status: chartData === null
              ? assetId ? 'classified-fallback-only' : 'classified-source-region-only'
              : assetId ? 'structured-data-and-fallback' : 'structured-data-and-source-region',
            source: 'docling',
            classification: classification || null,
          },
        },
        provenance,
        attrs,
      })
      sourceBackedRegions.push(...captionSourceRegions(
        candidate.item.captions,
        textByReference,
        sourceHash,
        sourcePath,
        importedAt,
        `region-${blockId}`,
        'chart',
        blockId,
      ))
    } else if (assetId) {
      const blockId = stableId('image', sourceHash, reference)
      blocks.push({
        id: blockId,
        type: 'image',
        assetId,
        alt,
        caption,
        provenance,
        attrs,
      })
      sourceBackedRegions.push(...captionSourceRegions(
        candidate.item.captions,
        textByReference,
        sourceHash,
        sourcePath,
        importedAt,
        `region-${blockId}`,
        regionKind,
        blockId,
      ))
    } else if (duplicateCanonicalTable) {
      reconciledTablePictures += 1
    } else {
      if (decorativePicture) suppressedDecorativePictures += 1
      const parentRegionId = `region-${stableId('picture', sourceHash, reference)}`
      sourceBackedRegions.push({
        id: parentRegionId,
        kind: decorativePicture ? 'other' : regionKind,
        page: candidate.page,
        bbox: provenance.bbox || null,
        coordinateOrigin: String(candidate.item.prov?.[0]?.bbox?.coord_origin || '').toUpperCase() === 'TOPLEFT' ? 'TOPLEFT' : 'BOTTOMLEFT',
        status: 'observed',
        description: alt,
        structuredData: {
          regionRole: decorativePicture ? 'decorative-source-visual' : 'docling-source-visual',
          semanticLevel: decorativePicture ? 'decoration' : 'object',
          defaultVisibility: decorativePicture ? 'evidence-only' : 'visible',
          pictureReference: reference,
          rawVisualClass: classification?.className || null,
          rawVisualConfidence: classification?.confidence ?? null,
          ...(classification?.className && regionKind === 'figure' && /screenshot/i.test(classification.className)
            ? { visualType: 'screenshot-candidate' }
            : {}),
          ...(regionKind === 'visualization' ? { visualType: 'visualization', visualSubtype: 'simulation' } : {}),
          ...(regionKind === 'logo' ? { visualType: 'logo' } : {}),
          ...(regionKind === 'qrCode' ? {
            visualType: 'qr-code',
            machineReadableCode: { symbology: 'QR', decodeStatus: 'not-decoded', payload: null },
          } : {}),
        },
        provenance: {
          method: 'imported',
          source: sourcePath,
          verified: false,
          sourceSha256: sourceHash,
          ...(classification?.confidence !== null && classification?.confidence !== undefined ? { confidence: classification.confidence } : {}),
          capturedAt: importedAt,
          notes: classification ? `Docling classification: ${classification.className}` : 'Docling picture region without embedded raster duplication.',
        },
      })
      sourceBackedRegions.push(...captionSourceRegions(
        candidate.item.captions,
        textByReference,
        sourceHash,
        sourcePath,
        importedAt,
        parentRegionId,
        regionKind,
      ))
    }
  }

  let pageObjectMerge: ReturnType<typeof mergePdfPageObjectEvidence> | null = null
  if (format === 'pdf' && importDetails.pageObjectAnalysis) {
    const textGeometry = texts.flatMap((item, index): PdfTextGeometry[] => {
      const bbox = item.prov?.[0]?.bbox
      if (!bbox || !finiteBbox(bbox)) return []
      return [{
        reference: item.self_ref || `#/texts/${index}`,
        page: pageNumber(item),
        label: item.label || 'text',
        text: String(item.text || item.orig || '').trim(),
        bbox: [bbox.l!, bbox.b!, bbox.r!, bbox.t!],
      }]
    })
    pageObjectMerge = mergePdfPageObjectEvidence(
      importDetails.pageObjectAnalysis,
      sourceBackedRegions,
      textGeometry,
      { sourcePath, sourceSha256: sourceHash, capturedAt: importedAt },
    )
    sourceBackedRegions = pageObjectMerge.regions
  }

  const captionAnchoredFigureRecovery = format === 'pdf'
    ? recoverCaptionAnchoredFigures(
        texts,
        tables,
        blocks,
        sourceBackedRegions,
        sourcePageSizes,
        sourceHash,
        sourcePath,
        importedAt,
      )
    : null
  if (captionAnchoredFigureRecovery) sourceBackedRegions = captionAnchoredFigureRecovery.regions

  const existingChartCount = blocks.filter(block => block.type === 'chart').length
  const nativeOfficeCharts = extractNativeOfficeCharts(sourceBytes, format, sourceHash, sourceId, sourcePath, importedAt)
  for (const chart of nativeOfficeCharts.slice(existingChartCount)) {
    blocks.push(chart)
    if (chart.spec.data !== null) chartBlocksWithData += 1
  }

  const unresolvedPictures = Math.max(0, missingPictures - reconciledTablePictures - suppressedDecorativePictures)
  if (unresolvedPictures > 0) warnings.push(importDetails.visualAssetPolicy === 'source-backed'
    ? `${unresolvedPictures} visual item(s) are represented as typed source regions without duplicate raster assets; source pages remain the visual authority.`
    : `${unresolvedPictures} Docling picture item(s) could not be resolved to exported image bytes.`)
  if (reconciledTablePictures > 0) warnings.push(`${reconciledTablePictures} duplicate table picture detection(s) were reconciled to canonical structured table blocks.`)
  if (suppressedDecorativePictures > 0) warnings.push(`${suppressedDecorativePictures} small uncaptained decorative region(s) were retained as evidence-only source parts and suppressed from the default semantic page-object overlay.`)
  if (pageObjectMerge) {
    const added = pageObjectMerge.imageRegionsAdded
      + pageObjectMerge.panelRegionsAdded
      + pageObjectMerge.parentRegionsAdded
      + pageObjectMerge.vectorTableCandidatesAdded
      + pageObjectMerge.infographicCandidatesAdded
    if (added > 0 || pageObjectMerge.expandedRegions > 0) {
      warnings.push(`PDF source geometry reconciled ${pageObjectMerge.expandedRegions} visual boundary/boundaries and added ${added} reviewable page-object region(s) without OCR or automatic canonical changes.`)
    }
  }
  if (captionAnchoredFigureRecovery
    && (captionAnchoredFigureRecovery.figuresAdded > 0 || captionAnchoredFigureRecovery.figuresReclassified > 0)) {
    warnings.push(`Caption-anchored PDF recovery added ${captionAnchoredFigureRecovery.figuresAdded} reviewable figure candidate(s), reclassified ${captionAnchoredFigureRecovery.figuresReclassified} retained source visual(s), and resolved ${captionAnchoredFigureRecovery.captionLinksResolved} figure-caption link(s) without OCR or automatic canonical changes.`)
  }
  if (pictureFurniture.size > 0) warnings.push(`${pictureFurniture.size} recurring page-furniture picture occurrence(s) were classified for Page and Reflow rendering.`)
  const chartsWithoutData = blocks.filter(block => block.type === 'chart').length - chartBlocksWithData
  if (chartsWithoutData > 0) warnings.push(`${chartsWithoutData} chart(s) were classified but Docling did not provide structured chart data; inspect the retained source region before use.`)
  if (inferredNumberedHeadings > 0) warnings.push(`${inferredNumberedHeadings} short numbered section heading(s) were promoted from generic text using conservative deterministic title-case rules.`)

  if (!blocks.length) {
    blocks.push({
      id: stableId('paragraph', sourceHash, 'empty-document'),
      type: 'paragraph',
      content: [{ text: `No extractable text, table, or visual content was found in the source ${format.toUpperCase()} document.` }],
      provenance: { kind: 'imported', sourceId, sourceUri: sourcePath, page: 1, capturedAt: importedAt },
      attrs: { importWarning: 'empty-extraction' },
    })
  }

  const firstHeading = blocks.find(block => block.type === 'heading')
  const spreadsheetTitle = format === 'xlsx' ? firstTableTitle(blocks) : null
  if (spreadsheetTitle) warnings.push('The first non-empty spreadsheet cell was used as the document title because the source has no paragraph title layer.')
  const pageCount = Math.max(Object.keys(docling.pages || {}).length, ...layoutItems.map(item => item.page), 1)
  const canonicalNodeByDoclingRef = new Map(blocks.flatMap(block => {
    const reference = block.attrs?.doclingRef
    return typeof reference === 'string' ? [[reference, block.id] as const] : []
  }))
  const tableAnchorByNoteRef = new Map<string, string>()
  for (const [index, table] of tables.entries()) {
    const tableRef = table.self_ref || `#/tables/${index}`
    for (const footnote of table.footnotes || []) {
      if (footnote.$ref) tableAnchorByNoteRef.set(footnote.$ref, tableRef)
    }
  }
  const parentByDoclingRef = new Map<string, string>()
  for (const [index, item] of texts.entries()) {
    const parent = item.parent?.$ref
    if (parent) parentByDoclingRef.set(item.self_ref || `#/texts/${index}`, parent)
  }
  for (const [index, item] of tables.entries()) {
    const parent = item.parent?.$ref
    if (parent) parentByDoclingRef.set(item.self_ref || `#/tables/${index}`, parent)
  }
  for (const [index, item] of pictures.entries()) {
    const parent = item.parent?.$ref
    if (parent) parentByDoclingRef.set(item.self_ref || `#/pictures/${index}`, parent)
  }
  for (const [index, group] of (docling.groups || []).entries()) {
    const parent = group.parent?.$ref
    if (parent) parentByDoclingRef.set(group.self_ref || `#/groups/${index}`, parent)
  }
  for (const block of blocks) {
    if (block.type !== 'footnote') continue
    const noteRef = typeof block.attrs?.doclingRef === 'string' ? block.attrs.doclingRef : ''
    const anchorId = resolveNoteAnchor(noteRef, tableAnchorByNoteRef, parentByDoclingRef, canonicalNodeByDoclingRef, block.id)
    if (anchorId) {
      block.anchorIds = [anchorId]
      block.anchorStatus = 'resolved'
    } else {
      block.anchorStatus = parentByDoclingRef.has(noteRef) || tableAnchorByNoteRef.has(noteRef) ? 'uncertain' : 'unanchored'
    }
  }
  const resolvedNotes = blocks.filter(block => block.type === 'footnote' && block.anchorStatus === 'resolved').length
  const unresolvedNotes = blocks.filter(block => block.type === 'footnote' && block.anchorStatus !== 'resolved').length
  if (resolvedNotes > 0) warnings.push(`${resolvedNotes} imported footnote/endnote link(s) were deterministically bound to stable document anchors.`)
  if (unresolvedNotes > 0) warnings.push(`${unresolvedNotes} imported footnote/endnote marker relationship(s) remain review-required because no deterministic stable anchor was available.`)
  const sharedContent = importedSharedContentIndex(texts.map((item, index) => {
    const sourceRef = item.self_ref || `#/texts/${index}`
    const bbox = item.prov?.[0]?.bbox
    return {
      text: String(item.text || item.orig || ''),
      sourceRef,
      sourceUri: sourcePath,
      page: pageNumber(item),
      ...(bbox && [bbox.l, bbox.b, bbox.r, bbox.t].every(value => typeof value === 'number')
        ? { bbox: [bbox.l!, bbox.b!, bbox.r!, bbox.t!] as [number, number, number, number] }
        : {}),
      ...(bbox?.coord_origin ? { coordinateOrigin: bbox.coord_origin } : {}),
      ...(item.content_layer === 'furniture' || furnitureReferences.has(sourceRef)
        ? { contentLayer: 'furniture' }
        : item.content_layer ? { contentLayer: item.content_layer } : {}),
      ...(canonicalNodeByDoclingRef.get(sourceRef) ? { nodeId: canonicalNodeByDoclingRef.get(sourceRef)! } : {}),
    }
  }))
  if (sharedContent.groups.length) {
    warnings.push(`${sharedContent.groups.length} recurring text group(s) were indexed once with page-scoped source occurrences for token-efficient agent access.`)
  }
  const document: AndocDocument = {
    schema: ANDOC_DOCUMENT_SCHEMA,
    documentId: sourceId,
    revision: 0,
    title: firstHeading?.type === 'heading' ? firstHeading.content.map(run => run.text).join('') : (spreadsheetTitle || docling.name || safeName.replace(new RegExp(`\\.${format}$`, 'i'), '')),
    locale: 'en-US',
    createdAt: importedAt,
    updatedAt: importedAt,
    metadata: {
      source: {
        fileName: safeName,
        format,
        mediaType: sourceMediaTypes[format],
        sha256: sourceHash,
        embeddedPath: sourcePath,
        pageCount,
      },
      layout: {
        defaultView: 'page',
        availableViews: ['page', 'reflow', 'original'],
        sourcePageSizes,
        sourceLayout: 'provenance-page-geometry',
      },
      importer: {
        id: 'docling',
        cliVersion: importDetails.doclingCliVersion ?? null,
        documentSchema: docling.schema_name || null,
        documentSchemaVersion: docling.version || null,
        ocrRequested,
        ocrEngine: importDetails.ocrEngine ?? null,
        forceOcr: importDetails.forceOcr ?? false,
        textQuality: importDetails.textQuality ?? null,
        importTelemetry: importDetails.importTelemetry ?? emptyImportTelemetry(),
        tablesRequested: true,
        pictureClassificationRequested: importDetails.pictureClassificationRequested ?? false,
        pictureClassificationApplied: importDetails.pictureClassificationApplied ?? false,
        visualAssetPolicy: importDetails.visualAssetPolicy || 'embedded',
        visualAuthority: importDetails.visualAssetPolicy === 'source-backed' ? 'retained-source-pages' : 'embedded-derived-assets',
        pageObjectAnalysis: pageObjectMerge ? {
          schema: importDetails.pageObjectAnalysis?.schema,
          engine: 'pdfjs-dist',
          placedImageCount: importDetails.pageObjectAnalysis?.placedImages.length || 0,
          vectorTableCandidateCount: importDetails.pageObjectAnalysis?.vectorTableCandidates.length || 0,
          expandedRegions: pageObjectMerge.expandedRegions,
          imageRegionsAdded: pageObjectMerge.imageRegionsAdded,
          panelRegionsAdded: pageObjectMerge.panelRegionsAdded,
          parentRegionsAdded: pageObjectMerge.parentRegionsAdded,
          vectorTableCandidatesAdded: pageObjectMerge.vectorTableCandidatesAdded,
          infographicCandidatesAdded: pageObjectMerge.infographicCandidatesAdded,
          automaticCanonicalChange: false,
        } : null,
        captionAnchoredFigureRecovery: captionAnchoredFigureRecovery ? {
          method: 'deterministic-caption-geometry-and-retained-text',
          figuresAdded: captionAnchoredFigureRecovery.figuresAdded,
          figuresReclassified: captionAnchoredFigureRecovery.figuresReclassified,
          captionLinksResolved: captionAnchoredFigureRecovery.captionLinksResolved,
          canonicalTableCaptionsDetached: captionAnchoredFigureRecovery.canonicalTableCaptionsDetached,
          automaticCanonicalChange: false,
        } : null,
        docxNativePageMap: format === 'docx' ? {
          method: 'native-explicit-page-breaks',
          matchedTextItems: nativeDocxPages.size,
          maximumRecoveredPage: Math.max(...nativeDocxPages.values(), 1),
        } : null,
      },
      importWarnings: warnings,
      ...(sharedContent.groups.length ? { anxSharedContent: sharedContent } : {}),
      ...(sourceBackedRegions.length ? {
        anxRegionEvidence: {
          schema: 'anx.region-evidence.v1',
          regions: sourceBackedRegions,
        },
      } : {}),
    },
    assets: assetMetadata,
    blocks,
  }

  const compactDocling = compactDoclingJson(docling)
  const sources: Record<string, Uint8Array> = {
    [sourcePath]: sourceBytes,
    'sources/docling/document.json': strToU8(canonicalJson(compactDocling)),
  }
  const stats: PdfImportStats = {
    sourceFormat: format,
    pageCount,
    headingBlocks: blocks.filter(block => block.type === 'heading').length,
    paragraphBlocks: blocks.filter(block => block.type === 'paragraph').length,
    tableBlocks: blocks.filter(block => block.type === 'table').length,
    imageBlocks: blocks.filter(block => block.type === 'image').length,
    chartBlocks: blocks.filter(block => block.type === 'chart').length,
    chartBlocksWithData,
    pictureItems: pictures.length,
    pictureItemsNotYetMapped: unresolvedPictures,
    textQualityPagesRequiringOcr: importDetails.textQuality?.summary.pagesRequiringOcr || 0,
    textQualityCorruptedPages: (importDetails.textQuality?.summary.corruptedNativePages || 0) + (importDetails.textQuality?.summary.mixedPages || 0),
    selectiveOcrCandidatePages: 0,
    sourceBytes: sourceBytes.length,
    importTelemetry: importDetails.importTelemetry || emptyImportTelemetry(),
  }
  return { document, assets, sources, stats, sourcePath }
}

function doclingFurnitureReferences(docling: DoclingDocument): Set<string> {
  const groups = docling.groups || []
  const groupByReference = new Map(groups.map((group, index) => [group.self_ref || `#/groups/${index}`, group]))
  const itemChildren = new Map<string, DoclingReference[]>()
  for (const [index, item] of (docling.texts || []).entries()) itemChildren.set(item.self_ref || `#/texts/${index}`, item.children || [])
  for (const [index, item] of (docling.tables || []).entries()) itemChildren.set(item.self_ref || `#/tables/${index}`, item.children || [])
  for (const [index, item] of (docling.pictures || []).entries()) itemChildren.set(item.self_ref || `#/pictures/${index}`, item.children || [])
  const references = new Set<string>()
  const visit = (reference: string): void => {
    if (references.has(reference)) return
    references.add(reference)
    const children = groupByReference.get(reference)?.children || itemChildren.get(reference) || []
    for (const child of children) if (child.$ref) visit(child.$ref)
  }
  for (const child of docling.furniture?.children || []) if (child.$ref) visit(child.$ref)
  for (const [reference, group] of groupByReference) {
    if (group.content_layer === 'furniture' || /^(?:page[ -])?(?:header|footer)$/i.test(String(group.name || '').trim())) visit(reference)
  }
  return references
}

function assertPdf(bytes: Uint8Array): void {
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 5))
  if (signature !== '%PDF-') throw new Error('Input is not a PDF file')
}

function inferredOfficeTitleReference(layoutItems: DoclingLayoutItem[], format: DocumentImportFormat): string | null {
  const textCandidates = layoutItems.filter((candidate): candidate is Extract<DoclingLayoutItem, { kind: 'text' }> => {
    if (candidate.kind !== 'text') return false
    const text = String(candidate.item.text || candidate.item.orig || '').trim()
    return text.length >= 4 && text.length <= 160
  })
  if (format === 'docx') {
    const first = textCandidates[0]
    return first ? first.item.self_ref || `text-${first.index}` : null
  }
  if (format !== 'pptx') return null
  const pageOne = textCandidates.filter(candidate => candidate.page === 1)
  const ranked = [...pageOne].sort((left, right) => officeTextArea(right.item) - officeTextArea(left.item) || left.index - right.index)
  const best = ranked[0]
  return best ? best.item.self_ref || `text-${best.index}` : null
}

function officeTextArea(item: DoclingTextItem): number {
  const bbox = item.prov?.[0]?.bbox
  if (!bbox) return 0
  return Math.abs((bbox.r || 0) - (bbox.l || 0)) * Math.abs((bbox.t || 0) - (bbox.b || 0))
}

function firstTableTitle(blocks: AndocBlock[]): string | null {
  const table = blocks.find(block => block.type === 'table')
  if (!table || table.type !== 'table') return null
  for (const cell of table.rows[0] || []) {
    const text = cell.content.map(run => run.text).join('').trim()
    if (text.length >= 4 && text.length <= 200) return text
  }
  return null
}

function extractNativeOfficeCharts(
  sourceBytes: Uint8Array,
  format: DocumentImportFormat,
  sourceHash: string,
  sourceId: string,
  sourcePath: string,
  importedAt: string,
): Array<Extract<AndocBlock, { type: 'chart' }>> {
  if (format !== 'pptx' && format !== 'xlsx') return []
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(sourceBytes)
  } catch {
    return []
  }
  const prefix = format === 'pptx' ? 'ppt/' : 'xl/'
  const chartPaths = Object.keys(files)
    .filter(entry => entry.startsWith(prefix) && /\/charts\/chart\d+\.xml$/i.test(entry))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  return chartPaths.map((entryPath, index) => {
    const xml = strFromU8(files[entryPath]!)
    const data = structuredDataFromOfficeChart(xml)
    const title = officeChartTitle(xml) || `${format.toUpperCase()} native chart ${index + 1}`
    const chartType = officeChartType(xml)
    const page = format === 'pptx' ? presentationChartPage(files, entryPath) : 1
    return {
      id: stableId('chart', sourceHash, `native-office:${entryPath}`),
      type: 'chart',
      alt: title,
      spec: {
        schema: 'andoc.chart.v1',
        chartType,
        data,
        extraction: {
          method: 'local-extraction',
          source: entryPath,
          verified: false,
          confidence: data ? 0.85 : 0.5,
          notes: data
            ? 'Series values were recovered from the chart cache embedded in the Office package.'
            : 'The native chart relationship was preserved, but the Office package did not contain cached series values.',
        },
      },
      provenance: { kind: 'imported', sourceId, sourceUri: sourcePath, page, capturedAt: importedAt },
      attrs: { sourcePackagePath: entryPath, extractionMethod: 'native-office-ooxml' },
    }
  })
}

function officeChartType(xml: string): string {
  const match = xml.match(/<(?:[A-Za-z0-9_]+:)?(barChart|lineChart|pieChart|areaChart|scatterChart|doughnutChart|radarChart)\b/i)
  return match?.[1]?.replace(/Chart$/i, '').toLocaleLowerCase() || 'chart'
}

function officeChartTitle(xml: string): string | null {
  const title = xml.match(/<(?:[A-Za-z0-9_]+:)?title\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?title>/i)?.[1]
  if (!title) return null
  const values = [...title.matchAll(/<(?:[A-Za-z0-9_]+:)?(?:t|v)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?(?:t|v)>/gi)]
    .map(match => decodeXmlText(match[1] || '').trim())
    .filter(Boolean)
  return values.length ? values.join(' ') : null
}

function structuredDataFromOfficeChart(xml: string): { columns: string[]; rows: Array<Array<string | number | null>> } | null {
  const series = [...xml.matchAll(/<(?:[A-Za-z0-9_]+:)?ser\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?ser>/gi)].map((match, index) => {
    const body = match[1] || ''
    const tx = body.match(/<(?:[A-Za-z0-9_]+:)?tx\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?tx>/i)?.[1] || ''
    const label = firstOfficeValue(tx) || `Series ${index + 1}`
    const categoryBody = body.match(/<(?:[A-Za-z0-9_]+:)?cat\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?cat>/i)?.[1] || ''
    const valueBody = body.match(/<(?:[A-Za-z0-9_]+:)?val\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?val>/i)?.[1] || ''
    return { label, categories: officePointValues(categoryBody), values: officePointValues(valueBody).map(value => numberOrText(value)) }
  }).filter(item => item.values.length > 0)
  if (!series.length) return null
  const rowCount = Math.max(...series.map(item => item.values.length))
  const categories = series.find(item => item.categories.length)?.categories || Array.from({ length: rowCount }, (_, index) => String(index + 1))
  const labels = uniqueLabels(series.map(item => item.label))
  return {
    columns: ['Category', ...labels],
    rows: Array.from({ length: rowCount }, (_, rowIndex) => [
      categories[rowIndex] || String(rowIndex + 1),
      ...series.map(item => item.values[rowIndex] ?? null),
    ]),
  }
}

function officePointValues(xml: string): string[] {
  return [...xml.matchAll(/<(?:[A-Za-z0-9_]+:)?pt\b[^>]*>[\s\S]*?<(?:[A-Za-z0-9_]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?v>[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?pt>/gi)]
    .map(match => decodeXmlText(match[1] || '').trim())
}

function firstOfficeValue(xml: string): string | null {
  const value = xml.match(/<(?:[A-Za-z0-9_]+:)?(?:v|t)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?(?:v|t)>/i)?.[1]
  return value ? decodeXmlText(value).trim() : null
}

function numberOrText(value: string): string | number {
  const number = Number(value)
  return value.trim() !== '' && Number.isFinite(number) ? number : value
}

function uniqueLabels(labels: string[]): string[] {
  const counts = new Map<string, number>()
  return labels.map(label => {
    const count = (counts.get(label) || 0) + 1
    counts.set(label, count)
    return count === 1 ? label : `${label} ${count}`
  })
}

function presentationChartPage(files: Record<string, Uint8Array>, chartPath: string): number {
  const name = path.posix.basename(chartPath)
  for (const [entryPath, bytes] of Object.entries(files)) {
    const match = entryPath.match(/^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/i)
    if (match && strFromU8(bytes).includes(name)) return Number.parseInt(match[1]!, 10)
  }
  return 1
}

function assertSource(bytes: Uint8Array, format: DocumentImportFormat): void {
  if (format === 'pdf') return assertPdf(bytes)
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || !([0x03, 0x05, 0x07].includes(bytes[2] || -1)) || !([0x04, 0x06, 0x08].includes(bytes[3] || -1))) {
    throw new Error(`Input is not a valid ZIP-based ${format.toUpperCase()} file`)
  }
}

function sourceFormatFromName(value: string): DocumentImportFormat {
  const extension = path.extname(value).toLowerCase().slice(1)
  if (extension === 'pdf' || extension === 'docx' || extension === 'pptx' || extension === 'xlsx') return extension
  throw new Error('Unsupported source format; use PDF, DOCX, PPTX, or XLSX')
}

function safeSourceName(value: string, format: DocumentImportFormat): string {
  const fallback = `source.${format}`
  const base = path.basename(value || fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback
  return base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`
}

function pageNumber(item: { prov?: DoclingProvenance[] }): number {
  const value = Number(item.prov?.[0]?.page_no || 1)
  return Number.isInteger(value) && value >= 1 ? value : 1
}

function docxTextPageAssignments(sourceBytes: Uint8Array, texts: DoclingTextItem[]): Map<string, number> {
  const nativePages = docxParagraphPageQueues(sourceBytes)
  const assignments = new Map<string, number>()
  for (const [index, item] of texts.entries()) {
    const explicitPage = Number(item.prov?.[0]?.page_no)
    if (Number.isInteger(explicitPage) && explicitPage >= 1) continue
    const text = normalizeFurnitureText(String(item.text || item.orig || ''))
    if (!text) continue
    const candidates = nativePages.get(text)
    const recoveredPage = candidates?.shift()
    if (recoveredPage) assignments.set(item.self_ref || `#/texts/${index}`, recoveredPage)
  }
  return assignments
}

function docxParagraphPageQueues(sourceBytes: Uint8Array): Map<string, number[]> {
  try {
    const files = unzipSync(sourceBytes, { filter: file => file.name === 'word/document.xml' })
    const bytes = files['word/document.xml']
    if (!bytes) return new Map()
    const xml = strFromU8(bytes)
    const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []
    const pages = new Map<string, number[]>()
    let page = 1
    for (const paragraph of paragraphs) {
      const textIndex = paragraph.search(/<w:t(?:\s|>)/)
      const breaks = [
        ...paragraph.matchAll(/<w:br\b[^>]*w:type=["']page["'][^>]*\/?\s*>/g),
        ...paragraph.matchAll(/<w:lastRenderedPageBreak\b[^>]*\/?\s*>/g),
      ].map(match => match.index || 0).sort((left, right) => left - right)
      const beforeText = breaks.filter(index => textIndex < 0 || index < textIndex).length
      page += beforeText
      const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map(match => decodeXmlText(match[1] || ''))
        .join('')
      const normalized = normalizeFurnitureText(text)
      if (normalized) pages.set(normalized, [...(pages.get(normalized) || []), page])
      page += breaks.length - beforeText
    }
    return pages
  } catch {
    return new Map()
  }
}

function toProvenance(
  item: { prov?: DoclingProvenance[] },
  sourceId: string,
  sourceUri: string,
  capturedAt: string,
  pageOverride?: number,
  confidence?: number,
): Provenance {
  const source = item.prov?.[0]
  const bbox = source?.bbox
  return {
    kind: 'imported',
    sourceId,
    sourceUri,
    page: pageOverride || pageNumber(item),
    ...(bbox && [bbox.l, bbox.b, bbox.r, bbox.t].every(value => typeof value === 'number')
      ? { bbox: [bbox.l!, bbox.b!, bbox.r!, bbox.t!] as [number, number, number, number] }
      : {}),
    capturedAt,
    ...(typeof confidence === 'number' ? { confidence: Math.max(0, Math.min(1, confidence)) } : {}),
  }
}

function tableCell(
  cell: DoclingTableCell | null,
  rowIndex: number,
  columnIndex: number,
  sourceGridColumn: number,
  sourceHash: string,
  tableReference: string,
  provenance: Provenance,
): TableCell {
  const value = cell || {}
  const bbox = value.bbox
  const sourceCellRow = Number.isInteger(value.start_row_offset_idx) ? Number(value.start_row_offset_idx) : rowIndex
  const sourceCellColumn = Number.isInteger(value.start_col_offset_idx) ? Number(value.start_col_offset_idx) : sourceGridColumn
  return {
    id: stableId('cell', sourceHash, `${tableReference}:row-${sourceCellRow}:column-${sourceCellColumn}`),
    content: [{ text: String(value.text || '') }],
    ...(rowIndex === 0 || value.column_header || value.row_header ? { header: true } : {}),
    ...(Number(value.col_span || 1) > 1 ? { colspan: Number(value.col_span) } : {}),
    ...(Number(value.row_span || 1) > 1 ? { rowspan: Number(value.row_span) } : {}),
    provenance: structuredClone(provenance),
    attrs: {
      sourceRow: rowIndex,
      sourceColumn: columnIndex,
      sourceGridColumn,
      sourceCellRow,
      sourceCellColumn,
      ...(bbox && [bbox.l, bbox.b, bbox.r, bbox.t].every(coordinate => typeof coordinate === 'number')
        ? { sourceCellBBox: [bbox.l, bbox.b, bbox.r, bbox.t], sourceCellCoordinateOrigin: bbox.coord_origin || null }
        : {}),
    },
  }
}

function orderedTableRow(row: Array<DoclingTableCell | null>, rowIndex: number): Array<{ cell: DoclingTableCell | null; sourceGridColumn: number }> {
  const entries = row
    .map((cell, sourceGridColumn) => ({ cell, sourceGridColumn }))
    .filter(({ cell, sourceGridColumn }) => {
      if (!cell) return true
      const originRow = cell.start_row_offset_idx
      const originColumn = cell.start_col_offset_idx
      if (Number.isInteger(originRow) && Number(originRow) !== rowIndex) return false
      if (Number.isInteger(originColumn) && Number(originColumn) !== sourceGridColumn) return false
      return true
    })
  const hasCompleteHorizontalCoordinates = entries.length > 1 && entries.every(entry => typeof entry.cell?.bbox?.l === 'number')
  return hasCompleteHorizontalCoordinates
    ? entries.sort((left, right) => Number(left.cell?.bbox?.l) - Number(right.cell?.bbox?.l) || left.sourceGridColumn - right.sourceGridColumn)
    : entries
}

function doclingPageSizes(docling: DoclingDocument): Record<string, { width: number; height: number }> {
  const sizes: Record<string, { width: number; height: number }> = {}
  for (const [key, page] of Object.entries(docling.pages || {})) {
    const width = Number(page?.size?.width)
    const height = Number(page?.size?.height)
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) sizes[key] = { width, height }
  }
  return sizes
}

function recurringPictureFurniture(
  pictures: DoclingPictureItem[],
  picturePayloads: Record<string, DoclingPicturePayload>,
  pageSizes: Record<string, { width: number; height: number }>,
): Map<string, PageFurnitureMetadata> {
  const candidates: Array<{ reference: string; page: number; role: PageFurnitureMetadata['role']; sourceBand: PageFurnitureMetadata['sourceBand']; family: string }> = []
  for (const [index, picture] of pictures.entries()) {
    const reference = picture.self_ref || `#/pictures/${index}`
    const classification = primaryPictureClassification(picture)?.className.toLowerCase()
    const payload = picturePayloads[reference]
    const page = pageNumber(picture)
    const pageSize = pageSizes[String(page)]
    const band = picturePageBand(picture.prov?.[0]?.bbox, pageSize?.height)
    if (classification !== 'logo' || !payload?.bytes.length || !pageSize || !band) continue
    candidates.push({
      reference,
      page,
      role: band === 'top' ? 'header-logo' : 'footer-logo',
      sourceBand: band,
      family: pictureFurnitureFamily(picture, pageSize),
    })
  }

  const groups = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    const key = `${candidate.role}:${candidate.family}`
    groups.set(key, [...(groups.get(key) || []), candidate])
  }

  const result = new Map<string, PageFurnitureMetadata>()
  for (const occurrences of groups.values()) {
    const pages = new Set(occurrences.map(candidate => candidate.page))
    if (pages.size < 3) continue
    const ordered = [...occurrences].sort((left, right) => left.page - right.page || left.reference.localeCompare(right.reference, undefined, { numeric: true }))
    for (const [index, candidate] of ordered.entries()) {
      result.set(candidate.reference, {
        role: candidate.role,
        recurring: true,
        occurrence: index + 1,
        occurrenceCount: ordered.length,
        sourceBand: candidate.sourceBand,
      })
    }
  }
  return result
}

function pictureFurnitureFamily(picture: DoclingPictureItem, pageSize: { width: number; height: number }): string {
  const imageWidth = Number(picture.image?.size?.width)
  const imageHeight = Number(picture.image?.size?.height)
  const bbox = picture.prov?.[0]?.bbox
  const left = Number(bbox?.l)
  const right = Number(bbox?.r)
  const widthBucket = Number.isFinite(imageWidth) ? Math.round(imageWidth / 25) : 0
  const heightBucket = Number.isFinite(imageHeight) ? Math.round(imageHeight / 25) : 0
  const center = Number.isFinite(left) && Number.isFinite(right) ? (left + right) / 2 : 0
  const horizontalBucket = Math.round((center / pageSize.width) * 20)
  return `${widthBucket}:${heightBucket}:${horizontalBucket}`
}

function picturePageBand(bbox: DoclingBoundingBox | undefined, pageHeight: number | undefined): 'top' | 'bottom' | null {
  if (!bbox || !pageHeight || !Number.isFinite(pageHeight)) return null
  const lower = Math.min(Number(bbox.b), Number(bbox.t))
  const upper = Math.max(Number(bbox.b), Number(bbox.t))
  if (![lower, upper].every(Number.isFinite)) return null
  const origin = String(bbox.coord_origin || 'BOTTOMLEFT').toUpperCase()
  if (origin === 'TOPLEFT') {
    if (lower <= pageHeight * 0.2) return 'top'
    if (upper >= pageHeight * 0.8) return 'bottom'
    return null
  }
  if (upper >= pageHeight * 0.8) return 'top'
  if (lower <= pageHeight * 0.2) return 'bottom'
  return null
}

function isTextInsideTable(text: DoclingTextItem, tables: DoclingTableItem[]): boolean {
  const textSource = text.prov?.[0]
  const textBox = textSource?.bbox
  if (!textBox || ![textBox.l, textBox.b, textBox.r, textBox.t].every(value => typeof value === 'number')) return false
  return tables.some(table => {
    const tableSource = table.prov?.[0]
    const tableBox = tableSource?.bbox
    if (!tableBox || pageNumber(table) !== pageNumber(text)) return false
    if (tableBox.coord_origin && textBox.coord_origin && tableBox.coord_origin !== textBox.coord_origin) return false
    if (![tableBox.l, tableBox.b, tableBox.r, tableBox.t].every(value => typeof value === 'number')) return false
    const tolerance = 2
    return textBox.l! >= tableBox.l! - tolerance
      && textBox.r! <= tableBox.r! + tolerance
      && Math.min(textBox.b!, textBox.t!) >= Math.min(tableBox.b!, tableBox.t!) - tolerance
      && Math.max(textBox.b!, textBox.t!) <= Math.max(tableBox.b!, tableBox.t!) + tolerance
  })
}

function orderedDoclingLayout(
  docling: DoclingDocument,
  spatialItems: DoclingLayoutItem[],
  pictureCaptionReferences: Set<string>,
  officeFurnitureText: Set<string>,
): DoclingLayoutItem[] {
  const include = (candidate: DoclingLayoutItem): boolean => {
    if (candidate.item.content_layer === 'furniture') return false
    if (candidate.kind !== 'text') return true
    const reference = candidate.item.self_ref || `#/texts/${candidate.index}`
    const text = normalizeFurnitureText(String(candidate.item.text || candidate.item.orig || ''))
    return !pictureCaptionReferences.has(reference) && !officeFurnitureText.has(text)
  }
  if (!docling.body?.children?.length) return spatialItems.filter(include)

  const itemByReference = new Map<string, DoclingLayoutItem>()
  for (const candidate of spatialItems) {
    const reference = candidate.item.self_ref || `#/${candidate.kind === 'text' ? 'texts' : candidate.kind === 'table' ? 'tables' : 'pictures'}/${candidate.index}`
    itemByReference.set(reference, candidate)
  }
  const groups = docling.groups || []
  const groupByReference = new Map(groups.map((group, index) => [group.self_ref || `#/groups/${index}`, group]))
  const seen = new Set<string>()
  const ordered: DoclingLayoutItem[] = []

  const childrenFor = (reference: string): DoclingReference[] => {
    const candidate = itemByReference.get(reference)
    if (candidate?.item.children) return candidate.item.children
    return groupByReference.get(reference)?.children || []
  }
  const consume = (reference: string): void => {
    if (seen.has(reference)) return
    seen.add(reference)
    for (const child of childrenFor(reference)) if (child.$ref) consume(child.$ref)
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
    const candidate = itemByReference.get(reference)
    if (!candidate) {
      seen.add(reference)
      return
    }
    seen.add(reference)
    if (include(candidate)) ordered.push(candidate)
    if (candidate.kind === 'table' || candidate.kind === 'picture') {
      for (const child of candidate.item.children || []) {
        if (!child.$ref) continue
        const childCandidate = itemByReference.get(child.$ref)
        if (candidate.kind === 'table' && childCandidate?.kind === 'text' && isNoteTextItem(childCandidate.item)) visit(child.$ref)
        else consume(child.$ref)
      }
    } else {
      for (const child of candidate.item.children || []) if (child.$ref) visit(child.$ref)
    }
  }

  for (const child of docling.furniture?.children || []) if (child.$ref) consume(child.$ref)
  for (const child of docling.body.children) if (child.$ref) visit(child.$ref)

  // Preserve unlinked root-level items from imperfect Docling output without
  // reintroducing descendants already consumed by tables or furniture.
  for (const candidate of spatialItems) {
    const reference = candidate.item.self_ref || `#/${candidate.kind === 'text' ? 'texts' : candidate.kind === 'table' ? 'tables' : 'pictures'}/${candidate.index}`
    const parent = candidate.item.parent?.$ref
    if (!seen.has(reference) && (candidate.kind === 'text' && isNoteTextItem(candidate.item) || !parent || parent === '#/body')) visit(reference)
  }
  return ordered
}

function docxFurnitureText(sourceBytes: Uint8Array): Set<string> {
  try {
    const files = unzipSync(sourceBytes, {
      filter: file => /^word\/(?:header|footer)\d*\.xml$/i.test(file.name),
    })
    const values = new Set<string>()
    for (const bytes of Object.values(files)) {
      const xml = strFromU8(bytes)
      const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [xml]
      for (const paragraph of paragraphs) {
        const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
          .map(match => decodeXmlText(match[1] || ''))
          .join('')
        const normalized = normalizeFurnitureText(text)
        if (normalized) values.add(normalized)
      }
    }
    return values
  } catch {
    // Docling remains authoritative if an otherwise-valid Office container has
    // non-standard furniture XML that cannot be inspected selectively.
    return new Set<string>()
  }
}

function normalizeFurnitureText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function stableId(kind: string, sourceHash: string, reference: string): string {
  return `${kind}-${sha256(strToU8(`${sourceHash}:${reference}`)).slice(0, 16)}`
}

function clampHeadingLevel(value: number): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.max(1, Math.min(6, Math.trunc(value))) as 1 | 2 | 3 | 4 | 5 | 6
}

function layoutKindOrder(kind: 'text' | 'table' | 'picture'): number {
  return kind === 'text' ? 0 : kind === 'table' ? 1 : 2
}

function doclingAttrs(item: { prov?: DoclingProvenance[]; parent?: DoclingReference }, reference: string, label: string): Record<string, unknown> {
  return {
    doclingRef: reference,
    doclingLabel: label,
    ...(item.parent?.$ref ? { doclingParentRef: item.parent.$ref } : {}),
    coordinateOrigin: item.prov?.[0]?.bbox?.coord_origin || null,
  }
}

function isNoteTextItem(item: DoclingTextItem): boolean {
  return /^(?:footnote|endnote)$/i.test(String(item.label || '').trim())
}

function normalizedNoteKind(label: string): 'footnote' | 'endnote' {
  return String(label).toLowerCase() === 'endnote' ? 'endnote' : 'footnote'
}

function numberedSectionHeading(text: string, label: string): { sectionNumber: string; level: 1 | 2 | 3 | 4 | 5 | 6 } | null {
  if (!/^(?:text|paragraph)$/i.test(label.trim()) || text.length > 160) return null
  const match = text.match(/^(\d+(?:\.\d+){0,5})\.?\s+(.+)$/)
  if (!match) return null
  const title = match[2]!.trim()
  const words = title.match(/[A-Za-z][A-Za-z'-]*/g) || []
  if (!words.length || words.length > 16) return null
  const significant = words.filter(word => !/^(?:a|an|and|as|at|by|for|in|of|on|or|the|to|with)$/i.test(word))
  const titleCase = significant.filter(word => /^[A-Z]/.test(word)).length
  if (significant.length > 1 && titleCase / significant.length < 0.6 && title !== title.toUpperCase()) return null
  if (/[.!?]$/.test(title) && words.length > 8) return null
  return {
    sectionNumber: match[1]!,
    level: clampHeadingLevel(match[1]!.split('.').length),
  }
}

function splitNoteMarker(text: string): { marker: string; content: string } {
  const normalized = text.trim()
  const match = normalized.match(/^(\[[A-Za-z0-9*†‡]+\]|\([A-Za-z0-9*†‡]+\)|[A-Za-z0-9]+[.)]|[*†‡])\s*(.*)$/s)
  if (!match) return { marker: 'unmarked', content: normalized }
  return { marker: match[1]!, content: match[2]?.trim() || normalized }
}

function resolveNoteAnchor(
  noteRef: string,
  tableAnchorByNoteRef: Map<string, string>,
  parentByDoclingRef: Map<string, string>,
  canonicalNodeByDoclingRef: Map<string, string>,
  noteBlockId: string,
): string | null {
  let reference = tableAnchorByNoteRef.get(noteRef) || parentByDoclingRef.get(noteRef)
  const visited = new Set<string>()
  while (reference && !visited.has(reference)) {
    visited.add(reference)
    const nodeId = canonicalNodeByDoclingRef.get(reference)
    if (nodeId && nodeId !== noteBlockId) return nodeId
    reference = parentByDoclingRef.get(reference)
  }
  return null
}

function pictureCaption(picture: DoclingPictureItem, texts: Map<string, DoclingTextItem>): string {
  return (picture.captions || [])
    .map(reference => reference.$ref ? texts.get(reference.$ref)?.text : null)
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .trim()
}

function tableCaption(table: DoclingTableItem, texts: Map<string, DoclingTextItem>): string {
  return (table.captions || [])
    .map(reference => reference.$ref ? texts.get(reference.$ref)?.text : null)
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .trim()
}

function captionSourceRegions(
  references: DoclingReference[] | undefined,
  texts: Map<string, DoclingTextItem>,
  sourceHash: string,
  sourcePath: string,
  importedAt: string,
  parentRegionId: string,
  parentKind: PdfSourceRegionDraft['kind'],
  sourceBlockId?: string,
): PdfSourceRegionDraft[] {
  return (references || []).flatMap((reference, index): PdfSourceRegionDraft[] => {
    if (!reference.$ref) return []
    const item = texts.get(reference.$ref)
    const text = String(item?.text || item?.orig || '').trim()
    const provenance = item?.prov?.[0]
    const bbox = provenance?.bbox
    if (!text || !bbox || !finiteBbox(bbox)) return []
    const page = pageNumber(item!)
    return [{
      id: `region-${stableId('caption', sourceHash, `${parentRegionId}:${reference.$ref}:${index}`)}`,
      kind: 'caption',
      page,
      bbox: [bbox.l!, bbox.b!, bbox.r!, bbox.t!],
      coordinateOrigin: String(bbox.coord_origin || '').toUpperCase() === 'TOPLEFT' ? 'TOPLEFT' : 'BOTTOMLEFT',
      status: 'observed',
      ...(sourceBlockId ? { sourceBlockId } : {}),
      description: text,
      structuredData: {
        regionRole: 'caption',
        semanticLevel: 'part',
        defaultVisibility: 'visible',
        parentRegionId,
        captionForKind: parentKind,
        ...(sourceBlockId ? {
          captionForBlockId: sourceBlockId,
          canonicalTextOwner: 'parent-block-caption',
        } : {
          canonicalTextOwner: 'parent-region-description',
        }),
        captionReference: reference.$ref,
        sourceGeometry: 'docling-caption-text',
      },
      provenance: {
        method: 'imported',
        source: sourcePath,
        verified: false,
        sourceSha256: sourceHash,
        capturedAt: importedAt,
        notes: 'Caption text remains canonical on its parent object; this linked region preserves the caption source geometry without duplicating canonical text.',
      },
    }]
  })
}

interface CaptionAnchoredFigureRecoveryResult {
  regions: PdfSourceRegionDraft[]
  figuresAdded: number
  figuresReclassified: number
  captionLinksResolved: number
  canonicalTableCaptionsDetached: number
}

function recoverCaptionAnchoredFigures(
  texts: DoclingTextItem[],
  tables: DoclingTableItem[],
  blocks: AndocBlock[],
  sourceRegions: PdfSourceRegionDraft[],
  pageSizes: Record<string, { width: number; height: number }>,
  sourceHash: string,
  sourcePath: string,
  importedAt: string,
): CaptionAnchoredFigureRecoveryResult {
  const regions = sourceRegions.map(region => ({
    ...region,
    ...(region.structuredData ? { structuredData: structuredClone(region.structuredData) } : {}),
    provenance: structuredClone(region.provenance),
  }))
  let figuresAdded = 0
  let figuresReclassified = 0
  let captionLinksResolved = 0
  let canonicalTableCaptionsDetached = 0

  for (const [captionIndex, captionItem] of texts.entries()) {
    const captionText = String(captionItem.text || captionItem.orig || '').trim()
    const captionReference = captionItem.self_ref || `#/texts/${captionIndex}`
    const captionProvenance = captionItem.prov?.[0]
    const captionBbox = captionProvenance?.bbox
    if (captionItem.label !== 'caption'
      || !/^fig(?:ure)?\s+[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)*/i.test(captionText)
      || !captionBbox
      || !finiteBbox(captionBbox)) continue
    const page = pageNumber(captionItem)
    const pageSize = pageSizes[String(page)]
    if (!pageSize) continue
    const captionBox = bottomLeftBox(captionBbox, pageSize.height)

    const existingFigure = regions
      .filter(region => region.page === page && region.bbox && typeof region.structuredData?.pictureReference === 'string')
      .filter(region => {
        const rawVisualClass = String(region.structuredData?.rawVisualClass || '')
        if (/\btable\b/i.test(rawVisualClass)) return false
        const box = bottomLeftRegionBox(region, pageSize.height)
        if (!box) return false
        const gap = box[1] - captionBox[3]
        const pageAreaRatio = boxArea(box) / Math.max(1, pageSize.width * pageSize.height)
        return gap >= -pageSize.height * 0.01
          && gap <= pageSize.height * 0.06
          && pageAreaRatio <= 0.45
          && horizontalOverlapRatio(box, captionBox) >= 0.25
      })
      .sort((left, right) => {
        const leftBox = bottomLeftRegionBox(left, pageSize.height)!
        const rightBox = bottomLeftRegionBox(right, pageSize.height)!
        return Math.abs(leftBox[1] - captionBox[3]) - Math.abs(rightBox[1] - captionBox[3])
      })[0]

    let figureRegion = existingFigure
    if (figureRegion) {
      if (figureRegion.kind !== 'figure') figuresReclassified += 1
      figureRegion.kind = 'figure'
      figureRegion.description = captionText
      figureRegion.structuredData = {
        ...(figureRegion.structuredData || {}),
        regionRole: 'caption-anchored-source-figure',
        captionReference,
        captionText,
        sourceGeometry: 'docling-picture-and-caption-geometry',
      }
      figureRegion.provenance = {
        ...figureRegion.provenance,
        notes: 'A retained source visual was deterministically associated with the immediately following explicit figure caption. The source page remains authoritative.',
      }
    } else {
      const tableBoundary = tables
        .flatMap((table, tableIndex) => {
          const provenance = table.prov?.[0]
          const bbox = provenance?.bbox
          if (!bbox || !finiteBbox(bbox) || pageNumber(table) !== page) return []
          const box = bottomLeftBox(bbox, pageSize.height)
          const gap = box[1] - captionBox[3]
          if (gap <= 12 || gap > pageSize.height * 0.45) return []
          return [{ reference: table.self_ref || `#/tables/${tableIndex}`, box, gap }]
        })
        .sort((left, right) => left.gap - right.gap)[0]
      if (!tableBoundary) continue
      const lower = captionBox[3]
      const upper = tableBoundary.box[1]
      const visualText = texts.flatMap((item, textIndex) => {
        const text = String(item.text || item.orig || '').trim()
        const provenance = item.prov?.[0]
        const bbox = provenance?.bbox
        if (!text
          || !bbox
          || !finiteBbox(bbox)
          || pageNumber(item) !== page
          || item.label === 'caption'
          || item.content_layer === 'furniture') return []
        const box = bottomLeftBox(bbox, pageSize.height)
        const centerY = (box[1] + box[3]) / 2
        if (centerY <= lower || centerY >= upper) return []
        return [{ reference: item.self_ref || `#/texts/${textIndex}`, text, box }]
      })
      const horizontalSource = visualText.length
        ? unionBoxes(visualText.map(item => item.box))
        : tableBoundary.box
      const horizontalPadding = Math.min(6, pageSize.width * 0.01)
      const inferredBox: [number, number, number, number] = [
        Math.max(0, horizontalSource[0] - horizontalPadding),
        lower,
        Math.min(pageSize.width, horizontalSource[2] + horizontalPadding),
        upper,
      ]
      if (boxArea(inferredBox) < pageSize.width * pageSize.height * 0.01) continue
      figureRegion = {
        id: `region-${stableId('figure', sourceHash, `caption-anchor:${captionReference}:${inferredBox.map(value => value.toFixed(3)).join(',')}`)}`,
        kind: 'figure',
        page,
        bbox: inferredBox,
        coordinateOrigin: 'BOTTOMLEFT',
        status: 'candidate',
        description: captionText,
        structuredData: {
          regionRole: 'caption-anchored-vector-figure-candidate',
          semanticLevel: 'object',
          defaultVisibility: 'visible',
          captionReference,
          captionText,
          sourceGeometry: 'docling-caption-table-boundary-and-retained-text',
          upperBoundaryTableReference: tableBoundary.reference,
          visualTextLines: visualText.map(item => item.text),
          visualTextReferences: visualText.map(item => item.reference),
        },
        provenance: {
          method: 'local-extraction',
          source: sourcePath,
          verified: false,
          sourceSha256: sourceHash,
          capturedAt: importedAt,
          notes: 'Review-required figure geometry was inferred deterministically from an explicit figure caption, the nearest table boundary above it, and retained text geometry. No pixels or canonical content were changed.',
        },
      }
      regions.push(figureRegion)
      figuresAdded += 1
    }

    for (const region of regions) {
      if (region.kind !== 'caption' || region.structuredData?.parentRegionId !== figureRegion.id) continue
      if (region.structuredData?.captionReference === captionReference) continue
      const structuredData = { ...(region.structuredData || {}) }
      delete structuredData.parentRegionId
      delete structuredData.captionForKind
      delete structuredData.captionForBlockId
      region.structuredData = {
        ...structuredData,
        parentMatchState: 'detached-mismatched-caption',
      }
    }

    let captionRegion = regions.find(region => region.kind === 'caption' && region.structuredData?.captionReference === captionReference)
    if (!captionRegion) {
      captionRegion = captionSourceRegions(
        [{ $ref: captionReference }],
        new Map([[captionReference, captionItem]]),
        sourceHash,
        sourcePath,
        importedAt,
        figureRegion.id,
        'figure',
      )[0]
      if (captionRegion) regions.push(captionRegion)
    }
    if (captionRegion) {
      delete captionRegion.sourceBlockId
      const structuredData = { ...(captionRegion.structuredData || {}) }
      delete structuredData.captionForBlockId
      captionRegion.structuredData = {
        ...structuredData,
        parentRegionId: figureRegion.id,
        captionForKind: 'figure',
        canonicalTextOwner: 'parent-region-description',
        parentMatchState: 'explicit-caption-anchor',
      }
      captionLinksResolved += 1
    }

    for (const block of blocks) {
      if (block.type !== 'table' || !block.caption) continue
      if (block.caption.map(run => run.text).join('').trim() !== captionText) continue
      delete block.caption
      canonicalTableCaptionsDetached += 1
    }
  }

  return { regions, figuresAdded, figuresReclassified, captionLinksResolved, canonicalTableCaptionsDetached }
}

function bottomLeftBox(bbox: Required<Pick<DoclingBoundingBox, 'l' | 't' | 'r' | 'b'>> & DoclingBoundingBox, pageHeight: number): [number, number, number, number] {
  const left = Math.min(bbox.l, bbox.r)
  const right = Math.max(bbox.l, bbox.r)
  if (String(bbox.coord_origin || '').toUpperCase() === 'TOPLEFT') {
    return [left, pageHeight - Math.max(bbox.t, bbox.b), right, pageHeight - Math.min(bbox.t, bbox.b)]
  }
  return [left, Math.min(bbox.b, bbox.t), right, Math.max(bbox.b, bbox.t)]
}

function bottomLeftRegionBox(region: PdfSourceRegionDraft, pageHeight: number): [number, number, number, number] | null {
  if (!region.bbox) return null
  const [x1, y1, x2, y2] = region.bbox
  const left = Math.min(x1, x2)
  const right = Math.max(x1, x2)
  if (region.coordinateOrigin === 'TOPLEFT') return [left, pageHeight - Math.max(y1, y2), right, pageHeight - Math.min(y1, y2)]
  return [left, Math.min(y1, y2), right, Math.max(y1, y2)]
}

function boxArea(box: [number, number, number, number]): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1])
}

function horizontalOverlapRatio(left: [number, number, number, number], right: [number, number, number, number]): number {
  const overlap = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]))
  const minimumWidth = Math.min(left[2] - left[0], right[2] - right[0])
  return minimumWidth > 0 ? overlap / minimumWidth : 0
}

function unionBoxes(boxes: Array<[number, number, number, number]>): [number, number, number, number] {
  return boxes.reduce((union, box) => [
    Math.min(union[0], box[0]),
    Math.min(union[1], box[1]),
    Math.max(union[2], box[2]),
    Math.max(union[3], box[3]),
  ], [...boxes[0]!] as [number, number, number, number])
}

function pictureDescription(picture: DoclingPictureItem): string {
  if (typeof picture.meta?.description?.text === 'string') return picture.meta.description.text.trim()
  const annotation = (picture.annotations || []).find(candidate => candidate.kind === 'description')
  return typeof annotation?.text === 'string' ? annotation.text.trim() : ''
}

function primaryPictureClassification(picture: DoclingPictureItem): { className: string; confidence: number | null } | null {
  const current = picture.meta?.classification?.predictions?.[0]
  if (current?.class_name) return { className: current.class_name, confidence: typeof current.confidence === 'number' ? current.confidence : null }
  const legacy = (picture.annotations || []).find(candidate => candidate.kind === 'classification')
  const prediction = Array.isArray(legacy?.predicted_classes) ? legacy.predicted_classes[0] as Record<string, unknown> | undefined : undefined
  return typeof prediction?.class_name === 'string'
    ? { className: prediction.class_name, confidence: typeof prediction.confidence === 'number' ? prediction.confidence : null }
    : null
}

function extractedChartData(picture: DoclingPictureItem): unknown | null {
  if (picture.meta?.tabular_chart?.chart_data !== undefined) return picture.meta.tabular_chart.chart_data
  const annotation = (picture.annotations || []).find(candidate => {
    const kind = typeof candidate.kind === 'string' ? candidate.kind : ''
    return kind === 'tabular_chart_data' || /(?:bar|line|pie|scatter|stacked_bar)_chart_data/.test(kind)
  })
  return annotation || null
}

function isChartPicture(
  picture: DoclingPictureItem,
  classification: { className: string; confidence: number | null } | null,
  data: unknown | null,
  semanticText = '',
): boolean {
  if (data !== null || picture.label === 'chart') return true
  if (classification && /chart|plot/i.test(classification.className) && (classification.confidence === null || classification.confidence >= 0.5)) return true
  return /\b(?:chart|plot|graph)\b/i.test(semanticText)
}

function normalizeChartType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'chart'
}

function sourceRegionKind(
  className: string,
  semanticText: string,
  chart: boolean,
  confidence: number | null = null,
): 'table' | 'figure' | 'screenshot' | 'visualization' | 'simulation' | 'infographic' | 'roster' | 'logo' | 'qrCode' | 'chart' | 'map' | 'equation' | 'handwriting' | 'signature' | 'other' {
  if (chart) return 'chart'
  const semantic = semanticText.toLowerCase().replace(/[_-]+/g, ' ')
  const value = `${className} ${semanticText}`.toLowerCase().replace(/[_-]+/g, ' ')
  if (/\b(?:qr\s*code|data\s*matrix|barcode)\b/.test(value)) return 'qrCode'
  if (/\b(?:simulation|simulated|synthetic terrain|computer generated terrain|rendered terrain)\b/.test(semantic)) return 'visualization'
  const photographicNarrative = /\b(?:attendees?|people|person|group|gathered|pictured|standing|portrait|crew|team members?)\b/.test(semantic)
  if (/\b(?:logo|emblem|badge|insignia|seal)\b/.test(value) && !photographicNarrative) return 'logo'
  if (/\b(?:infographic|visual summary)\b/.test(value)) return 'infographic'
  if (/\b(?:personnel|leadership|staff|team)\s+(?:roster|directory)\b/.test(value)) return 'roster'
  if (/\b(?:engineering drawing|technical drawing|schematic|diagram)\b/.test(className.toLowerCase().replace(/[_-]+/g, ' '))) return 'figure'
  if (/\btable\b/.test(value)) return 'table'
  if (/\b(?:geographical|topographical|geographic|service area)\s+map\b|\bmap\b/.test(value)) return 'map'
  if (/\b(?:equation|formula|chemistry structure)\b/.test(value)) return 'equation'
  if (/\bhandwrit(?:ing|ten)\b/.test(value)) return 'handwriting'
  if (/\bsignature\b/.test(value)) return 'signature'
  if (/\bscreenshot\b|\bscreen\s+(?:capture|shot)\b/.test(value)) {
    if (/\b(?:simulation|simulated|terrain|flight imagery|scientific visualization)\b/.test(semantic)) return 'visualization'
    return confidence === null || confidence >= 0.6 ? 'screenshot' : 'figure'
  }
  return 'figure'
}

function decorativeSourcePicture(
  className: string,
  confidence: number | null,
  captionText: string,
  bbox: [number, number, number, number] | undefined,
  pageSize: { width: number; height: number } | undefined,
): boolean {
  if (captionText || !bbox || !pageSize) return false
  const width = Math.abs(bbox[2] - bbox[0])
  const height = Math.abs(bbox[3] - bbox[1])
  const areaRatio = width * height / (pageSize.width * pageSize.height)
  if (/\b(?:qr[_ -]?code|logo|emblem|badge|insignia)\b/i.test(className)) return false
  if (/\bicon\b/i.test(className)) return areaRatio <= 0.035
  return areaRatio <= 0.01
    && (confidence === null || confidence < 0.6)
    && /\b(?:full_page_image|photograph|picture|image)\b/i.test(className)
}

function finiteBbox(value: DoclingBoundingBox): value is Required<Pick<DoclingBoundingBox, 'l' | 't' | 'r' | 'b'>> & DoclingBoundingBox {
  return [value.l, value.t, value.r, value.b].every(candidate => typeof candidate === 'number' && Number.isFinite(candidate))
    && value.l !== value.r
    && value.t !== value.b
}

function bboxOverlapRatio(left: [number, number, number, number], right: [number, number, number, number]): number {
  const normalizedLeft = [Math.min(left[0], left[2]), Math.min(left[1], left[3]), Math.max(left[0], left[2]), Math.max(left[1], left[3])]
  const normalizedRight = [Math.min(right[0], right[2]), Math.min(right[1], right[3]), Math.max(right[0], right[2]), Math.max(right[1], right[3])]
  const width = Math.max(0, Math.min(normalizedLeft[2]!, normalizedRight[2]!) - Math.max(normalizedLeft[0]!, normalizedRight[0]!))
  const height = Math.max(0, Math.min(normalizedLeft[3]!, normalizedRight[3]!) - Math.max(normalizedLeft[1]!, normalizedRight[1]!))
  const intersection = width * height
  const leftArea = Math.max(0, normalizedLeft[2]! - normalizedLeft[0]!) * Math.max(0, normalizedLeft[3]! - normalizedLeft[1]!)
  const rightArea = Math.max(0, normalizedRight[2]! - normalizedRight[0]!) * Math.max(0, normalizedRight[3]! - normalizedRight[1]!)
  const smallerArea = Math.min(leftArea, rightArea)
  return smallerArea > 0 ? intersection / smallerArea : 0
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/svg+xml') return 'svg'
  if (mediaType === 'image/webp') return 'webp'
  return 'png'
}

function mediaTypeFromPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  return extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
    : extension === '.svg' ? 'image/svg+xml'
      : extension === '.webp' ? 'image/webp'
        : 'image/png'
}

function compactDoclingJson(docling: DoclingDocument): unknown {
  return JSON.parse(JSON.stringify(docling, (key, value) => {
    if (key === 'uri' && typeof value === 'string' && (value.startsWith('data:image/') || value.includes('_artifacts/image_'))) {
      return '[picture-exported-to-andoc-asset]'
    }
    return value
  }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function roundedMilliseconds(value: number): number {
  return Number(value.toFixed(3))
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function emptyImportTelemetry(): ImportTelemetry {
  return {
    schema: 'agn.import-telemetry.v2',
    measurementScope: 'node-importer-and-child-processes',
    childMemoryMetric: 'sum-rss-descendant-process-tree',
    childPeakRssBytes: null,
    samplingIntervalMs: 250,
    stages: [],
    doclingRuns: [],
  }
}
