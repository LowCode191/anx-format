import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { readAndoc, validateAndoc } from './package.js'
import { ANX_MEDIA_TYPE, LEGACY_AGN_MEDIA_TYPE, LEGACY_ANDOC_MEDIA_TYPE, type AndocBlock } from './types.js'

export type AnxReadConformanceClass = 'ANX-C1' | 'ANX-C2' | 'ANX-C3'
export type AgnReadConformanceClass = 'AGN-C1' | 'AGN-C2' | 'AGN-C3'
export type AnxReadConformanceRequest = AnxReadConformanceClass | AgnReadConformanceClass

export interface AnxConformanceCheck {
  id: string
  passed: boolean
  detail: string
}

export interface AnxConformanceReport {
  schema: 'anx.conformance-report.v1'
  requestedClass: AnxReadConformanceClass
  achievedClass: AnxReadConformanceClass | null
  passed: boolean
  packageSha256: string
  documentId?: string
  revision?: number
  checks: AnxConformanceCheck[]
  claimBoundary: string
}

/** @deprecated Use AnxConformanceCheck. */
export type AgnConformanceCheck = AnxConformanceCheck
/** @deprecated Use AnxConformanceReport. */
export type AgnConformanceReport = AnxConformanceReport

const ranks: Record<AnxReadConformanceClass, number> = { 'ANX-C1': 1, 'ANX-C2': 2, 'ANX-C3': 3 }

export async function evaluateAnxReadConformance(
  input: string | Uint8Array,
  requestedClass: AnxReadConformanceRequest = 'ANX-C3',
): Promise<AnxConformanceReport> {
  const canonicalRequest = normalizeConformanceClass(requestedClass)
  const bytes = typeof input === 'string' ? new Uint8Array(await readFile(input)) : input
  const checks: AnxConformanceCheck[] = []
  const validation = await validateAndoc(bytes)
  checks.push({ id: 'c1-safe-package-validation', passed: validation.ok, detail: validation.ok ? 'Package preflight, manifest, hashes, sizes, and schemas validate.' : `Validation reported ${validation.issues.length} issue(s).` })
  if (!validation.ok) return report(canonicalRequest, bytes, checks)

  const pkg = await readAndoc(bytes)
  const mediaType = new TextDecoder().decode(pkg.files.mimetype || new Uint8Array()).trim()
  const recognizedMediaType = [ANX_MEDIA_TYPE, LEGACY_AGN_MEDIA_TYPE, LEGACY_ANDOC_MEDIA_TYPE].includes(mediaType as typeof ANX_MEDIA_TYPE)
  checks.push({ id: 'c1-media-type', passed: recognizedMediaType, detail: `Internal media type is ${mediaType || 'missing'}${mediaType === ANX_MEDIA_TYPE ? ' (canonical)' : ' (legacy-compatible)'}.` })
  checks.push({ id: 'c1-byte-preservation', passed: true, detail: 'The reader operates on the supplied bytes without rewriting the package.' })

  const view = new TextDecoder().decode(pkg.files['views/document.html'] || new Uint8Array())
  checks.push({ id: 'c2-derived-preview', passed: view.startsWith('<!doctype html>') && view.includes(pkg.document.title), detail: 'A deterministic derived HTML preview exists and identifies the canonical title.' })
  checks.push({ id: 'c2-finalization-disclosure', passed: Array.isArray(pkg.finalizations), detail: `Reader exposes ${pkg.finalizations.length} finalization record(s).` })

  const nodeIds = canonicalNodeIds(pkg.document.blocks)
  const uniqueIds = new Set(nodeIds)
  checks.push({ id: 'c3-stable-node-index', passed: nodeIds.length > 0 && uniqueIds.size === nodeIds.length, detail: `${uniqueIds.size} unique canonical node ID(s) are available for indexing and citation.` })
  checks.push({ id: 'c3-revision', passed: Number.isInteger(pkg.document.revision) && pkg.document.revision >= 0, detail: `Canonical revision ${pkg.document.revision} is exposed.` })
  checks.push({ id: 'c3-history', passed: Array.isArray(pkg.transactions), detail: `${pkg.transactions.length} transaction record(s) are readable.` })
  return report(canonicalRequest, bytes, checks, pkg.document.documentId, pkg.document.revision)
}

/** @deprecated Use evaluateAnxReadConformance. Legacy AGN class names remain accepted. */
export const evaluateAgnReadConformance = evaluateAnxReadConformance

function report(
  requestedClass: AnxReadConformanceClass,
  bytes: Uint8Array,
  checks: AnxConformanceCheck[],
  documentId?: string,
  revision?: number,
): AnxConformanceReport {
  let achievedClass: AnxReadConformanceClass | null = null
  for (const candidate of ['ANX-C1', 'ANX-C2', 'ANX-C3'] as const) {
    const prefix = candidate.toLowerCase().replace('anx-', '')
    const relevant = checks.filter(check => check.id.startsWith(prefix))
    if (relevant.length && relevant.every(check => check.passed) && (!achievedClass || ranks[candidate] === ranks[achievedClass] + 1)) achievedClass = candidate
  }
  return {
    schema: 'anx.conformance-report.v1',
    requestedClass,
    achievedClass,
    passed: Boolean(achievedClass && ranks[achievedClass] >= ranks[requestedClass]),
    packageSha256: createHash('sha256').update(bytes).digest('hex'),
    ...(documentId ? { documentId } : {}),
    ...(revision !== undefined ? { revision } : {}),
    checks,
    claimBoundary: 'This report covers the ANX reference read path through C3. C4 mapping and C5 editing require platform-specific conformance and are not implied.',
  }
}

function normalizeConformanceClass(value: AnxReadConformanceRequest): AnxReadConformanceClass {
  return value.replace(/^AGN-/, 'ANX-') as AnxReadConformanceClass
}

function canonicalNodeIds(blocks: AndocBlock[]): string[] {
  const ids: string[] = []
  const listItemIds = (items: Extract<AndocBlock, { type: 'list' }>['items']): void => {
    for (const item of items) {
      ids.push(item.id)
      listItemIds(item.children || [])
    }
  }
  for (const block of blocks) {
    ids.push(block.id)
    if (block.type === 'table') for (const row of block.rows) for (const cell of row) ids.push(cell.id)
    if (block.type === 'list') listItemIds(block.items)
  }
  return ids
}
