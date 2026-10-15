#!/usr/bin/env node
// Imports every manifest document into an ANX package with the reference CLI and
// records import cost, validation and package hashes. Re-runs reuse existing
// packages unless --force (or --force-id <id>) is given.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { readAndoc, type AndocBlock } from '../../src/index.js'

const execFileAsync = promisify(execFile)
const benchmarkRoot = import.meta.dirname
const repoRoot = path.resolve(benchmarkRoot, '../..')
const manifestPath = path.join(benchmarkRoot, 'corpus/manifest.json')
const packagesRoot = path.join(benchmarkRoot, 'corpus/packages')
const resultsRoot = path.join(benchmarkRoot, 'results')
const force = process.argv.includes('--force')
const forceId = argument('--force-id')
const only = (argument('--only') || '').split(',').map(value => value.trim()).filter(Boolean)

interface ManifestDocument {
  id: string
  format: 'pdf' | 'docx'
  fileName: string
  sourcePath: string
  title: string
  sha256: string
  sourceBytes: number
  pageCount: number
}

interface Manifest {
  benchmarkId: string
  documents: ManifestDocument[]
}

interface ImportRecord {
  reused: boolean
  wallTimeMs: number | null
  peakRssBytes: number | null
  doclingVersion: string | null
  doclingCliVersion: string | null
  importerStats: Record<string, unknown> | null
  warnings: unknown[] | null
}

interface DocumentResult {
  id: string
  format: string
  title: string
  status: 'passed' | 'failed'
  error?: string
  sourcePath: string
  sourceSha256: string
  sourceBytes: number
  sourcePages: number
  packagePath?: string
  packageSha256?: string
  packageBytes?: number
  packageToSourceSizeRatio?: number
  import?: ImportRecord
  validationOk?: boolean
  blocks?: number
  pageBreaks?: number
  canonicalCharacters?: number
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
await mkdir(packagesRoot, { recursive: true })
await mkdir(resultsRoot, { recursive: true })
const previous = await previousResults()
const results: DocumentResult[] = []

for (const document of manifest.documents) {
  if (only.length && !only.includes(document.id)) {
    const kept = previous.get(document.id)
    if (kept) results.push(kept)
    continue
  }
  process.stdout.write(`[prepare] ${document.id} ${document.fileName}\n`)
  const sourcePath = path.join(benchmarkRoot, document.sourcePath)
  const packagePath = path.join(packagesRoot, `${stem(document.fileName)}.anx`)
  try {
    const sourceBytes = await readFile(sourcePath)
    const sourceSha256 = sha256(sourceBytes)
    if (sourceSha256 !== document.sha256) throw new Error(`source checksum mismatch for ${document.id}: expected ${document.sha256}, got ${sourceSha256}`)
    const imported = await importDocument(sourcePath, packagePath, force || forceId === document.id, previous.get(document.id)?.import)
    const validation = await validatePackage(packagePath)
    if (!validation.ok) throw new Error(`validation failed for ${document.id}: ${JSON.stringify(validation.issues || validation).slice(0, 500)}`)
    const packageBytes = await readFile(packagePath)
    const pkg = await readAndoc(new Uint8Array(packageBytes))
    const canonical = canonicalText(pkg.document.blocks)
    results.push({
      id: document.id,
      format: document.format,
      title: document.title,
      status: 'passed',
      sourcePath: document.sourcePath,
      sourceSha256,
      sourceBytes: sourceBytes.byteLength,
      sourcePages: document.pageCount,
      packagePath: path.relative(benchmarkRoot, packagePath),
      packageSha256: sha256(packageBytes),
      packageBytes: packageBytes.byteLength,
      packageToSourceSizeRatio: Number((packageBytes.byteLength / sourceBytes.byteLength).toFixed(3)),
      import: imported,
      validationOk: true,
      blocks: pkg.document.blocks.length,
      pageBreaks: pkg.document.blocks.filter(block => block.type === 'pageBreak').length,
      canonicalCharacters: canonical.length,
    })
  } catch (error) {
    results.push({
      id: document.id,
      format: document.format,
      title: document.title,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      sourcePath: document.sourcePath,
      sourceSha256: document.sha256,
      sourceBytes: document.sourceBytes,
      sourcePages: document.pageCount,
    })
  }
  await writeResults(results)
}

await writeResults(results)
const failed = results.filter(result => result.status === 'failed')
process.stdout.write(`[prepare] complete: ${results.length - failed.length}/${results.length} passed\n`)
if (failed.length) {
  for (const failure of failed) process.stderr.write(`[prepare] ${failure.id}: ${failure.error}\n`)
  process.exitCode = 1
}

async function importDocument(sourcePath: string, packagePath: string, forceThis: boolean, previousImport?: ImportRecord): Promise<ImportRecord> {
  if (await exists(packagePath)) {
    if (!forceThis) return previousImport ? { ...previousImport, reused: true } : { reused: true, wallTimeMs: null, peakRssBytes: null, doclingVersion: null, doclingCliVersion: null, importerStats: null, warnings: null }
    await unlink(packagePath)
  }
  const cliArgs = [process.execPath, '--import', 'tsx', path.join(repoRoot, 'src/cli.ts'), 'import-document', sourcePath, packagePath]
  const timed = process.platform === 'darwin' && await exists('/usr/bin/time')
  const started = performance.now()
  const { stdout, stderr } = await execFileAsync(timed ? '/usr/bin/time' : cliArgs[0]!, timed ? ['-l', ...cliArgs] : cliArgs.slice(1), {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  const wallTimeMs = Number((performance.now() - started).toFixed(3))
  const cliResult = parseJson(stdout)
  const rss = stderr.match(/^\s*(\d+)\s+maximum resident set size\s*$/mu)
  return {
    reused: false,
    wallTimeMs,
    peakRssBytes: rss ? Number(rss[1]) : null,
    doclingVersion: cliResult && typeof cliResult.doclingVersion === 'string' ? cliResult.doclingVersion : null,
    doclingCliVersion: cliResult && typeof cliResult.doclingCliVersion === 'string' ? cliResult.doclingCliVersion : null,
    importerStats: cliResult && typeof cliResult.stats === 'object' ? cliResult.stats as Record<string, unknown> : null,
    warnings: cliResult && Array.isArray(cliResult.warnings) ? cliResult.warnings : null,
  }
}

async function validatePackage(packagePath: string): Promise<{ ok: boolean; issues?: unknown }> {
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'src/cli.ts'), 'validate', packagePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).catch(error => ({ stdout: typeof error?.stdout === 'string' ? error.stdout : '' }))
  const parsed = parseJson(stdout)
  return parsed ? { ok: parsed.ok === true, issues: parsed.issues } : { ok: false, issues: 'validate produced no JSON' }
}

async function previousResults(): Promise<Map<string, DocumentResult>> {
  const map = new Map<string, DocumentResult>()
  try {
    const parsed = JSON.parse(await readFile(path.join(resultsRoot, 'preparation.json'), 'utf8')) as { documents?: DocumentResult[] }
    for (const document of parsed.documents || []) map.set(document.id, document)
  } catch {
    // First run.
  }
  return map
}

async function writeResults(documents: DocumentResult[]) {
  const passed = documents.filter(document => document.status === 'passed')
  const importTimes = passed.flatMap(document => document.import?.wallTimeMs ? [document.import.wallTimeMs] : [])
  const result = {
    schema: 'anx.corpus-preparation.v1',
    benchmarkId: manifest.benchmarkId,
    generatedAt: new Date().toISOString(),
    importer: {
      command: 'anx import-document (reference CLI; Docling for PDF layout and DOCX conversion)',
      node: process.version,
      docling: await doclingVersion(),
      platform: `${process.platform}-${process.arch}`,
    },
    status: documents.length === manifest.documents.length && passed.length === documents.length ? 'passed' : 'partial',
    summary: {
      documentsPlanned: manifest.documents.length,
      documentsCompleted: documents.length,
      documentsPassed: passed.length,
      totalSourceBytes: passed.reduce((sum, document) => sum + document.sourceBytes, 0),
      totalPackageBytes: passed.reduce((sum, document) => sum + (document.packageBytes || 0), 0),
      totalSourcePages: passed.reduce((sum, document) => sum + document.sourcePages, 0),
      medianImportTimeMs: importTimes.length ? median(importTimes) : null,
      maximumPeakRssBytes: Math.max(0, ...passed.map(document => document.import?.peakRssBytes || 0)) || null,
    },
    documents,
  }
  await writeFile(path.join(resultsRoot, 'preparation.json'), `${JSON.stringify(result, null, 2)}\n`)
}

async function doclingVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(process.env.ANX_DOCLING_BIN || 'docling', ['--version'], { encoding: 'utf8', timeout: 20_000 })
    // Keep the tool versions; drop the host platform line so retained results carry no OS build fingerprint.
    return stdout.trim().split('\n').filter(line => !/^Platform:/u.test(line)).join('; ') || null
  } catch {
    return null
  }
}

function canonicalText(blocks: AndocBlock[]): string {
  const values: string[] = []
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'paragraph') values.push(runs(block.content))
    else if (block.type === 'table') {
      if (block.caption) values.push(runs(block.caption))
      for (const row of block.rows) values.push(row.map(cell => runs(cell.content)).join(' | '))
    } else if (block.type === 'list') values.push(block.items.map(item => runs(item.content)).join('\n'))
    else if (block.type === 'image') values.push(block.alt, runs(block.caption))
  }
  return values.filter(Boolean).join('\n')
}

function runs(value?: Array<{ text: string }>): string { return (value || []).map(run => run.text).join('') }
function stem(fileName: string): string { return fileName.replace(/\.(pdf|docx)$/iu, '') }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return Number((sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2).toFixed(3)) }
function parseJson(value: string): Record<string, any> | null { try { return JSON.parse(value) as Record<string, any> } catch { return null } }
function argument(name: string): string | null { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] || null : null }
async function exists(filePath: string): Promise<boolean> { try { await access(filePath); return true } catch { return false } }
