import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { canonicalJson, sha256 } from './hash.js'
import { renderHtml } from './render.js'
import { applyTransaction } from './transaction.js'
import {
  ANDOC_MANIFEST_SCHEMA,
  ANX_MEDIA_TYPE,
  LEGACY_AGN_MEDIA_TYPE,
  LEGACY_ANDOC_MEDIA_TYPE,
  type AndocAsset,
  type AndocDocument,
  type AndocFinalization,
  type AndocLineage,
  type AndocManifest,
  type AndocProfiles,
  type AnxSourceBaselines,
  type AndocTransaction,
  type ManifestEntry,
  type ValidationIssue,
  type ValidationResult,
} from './types.js'
import { validateDocument, validateFinalization, validateLineage, validateManifest, validateProfiles, validateSourceBaselines, validateTransaction } from './validate.js'

// ZIP timestamps use local DOS time. Day two avoids crossing below 1980 in
// negative UTC offsets while preserving deterministic bytes across runs.
const FIXED_ZIP_TIME = new Date('1980-01-02T00:00:00.000Z')
const MIME_PATH = 'mimetype'
const MANIFEST_PATH = 'manifest.json'
const DOCUMENT_PATH = 'document.json'
const HISTORY_PATH = 'revisions/transactions.jsonl'
export const ANX_VERSION_BASELINE_PATH = 'versions/baseline.document.json'
const HTML_PATH = 'views/document.html'
export const ANDOC_PROFILE_PATH = 'profiles/declaration.json'
export const ANDOC_LINEAGE_PATH = 'lineage/record.json'
export const ANDOC_FINALIZATIONS_PATH = 'finalizations/records.json'
export const ANX_SOURCE_BASELINES_PATH = 'sources/provenance/source-baselines.json'
const inFlightPathReads = new Map<string, Promise<AndocPackage>>()

export const ANDOC_PACKAGE_LIMITS = {
  maximumPackageBytes: 96 * 1024 * 1024,
  maximumExpandedBytes: 256 * 1024 * 1024,
  maximumEntryBytes: 64 * 1024 * 1024,
  maximumEntries: 2048,
} as const

export interface PackageInput {
  document: AndocDocument
  versionBaseline?: AndocDocument
  assets?: Record<string, Uint8Array>
  sources?: Record<string, Uint8Array>
  transactions?: AndocTransaction[]
  profiles?: AndocProfiles
  lineage?: AndocLineage
  finalizations?: AndocFinalization[]
  sourceBaselines?: AnxSourceBaselines
}

export type AnxPackageInput = PackageInput

export interface AndocPackage {
  manifest: AndocManifest
  document: AndocDocument
  versionBaseline?: AndocDocument
  transactions: AndocTransaction[]
  profiles?: AndocProfiles
  lineage?: AndocLineage
  finalizations: AndocFinalization[]
  sourceBaselines?: AnxSourceBaselines
  files: Record<string, Uint8Array>
}

export type AgnPackage = AndocPackage
export type AnxPackage = AndocPackage

export const ANX_PACKAGE_LIMITS = ANDOC_PACKAGE_LIMITS
export const ANX_PROFILE_PATH = ANDOC_PROFILE_PATH
export const ANX_LINEAGE_PATH = ANDOC_LINEAGE_PATH
export const ANX_FINALIZATIONS_PATH = ANDOC_FINALIZATIONS_PATH

export async function packAndoc(input: PackageInput, outputPath?: string): Promise<Uint8Array> {
  const documentValidation = validateDocument(input.document)
  if (!documentValidation.ok) throw new Error(formatIssues('Invalid ANX document', documentValidation.issues))

  const usedExtensions = new Set(input.document.blocks
    .filter((block): block is Extract<AndocDocument['blocks'][number], { type: 'extension' }> => block.type === 'extension')
    .map(block => `${block.extensionId}@${block.version}`))
  const declaredExtensions = new Set((input.profiles?.extensions || []).map(extension => `${extension.id}@${extension.version}`))
  const undeclaredExtensions = [...usedExtensions].filter(extension => !declaredExtensions.has(extension))
  if (undeclaredExtensions.length) {
    throw new Error(`Invalid ANX extension block: every extension block must have an exact profiles/declaration.json entry; missing ${undeclaredExtensions.join(', ')}`)
  }

  const transactions = input.transactions || []
  const versionBaseline = input.versionBaseline || (!transactions.length ? structuredClone(input.document) : undefined)
  if (versionBaseline) {
    const baselineValidation = validateDocument(versionBaseline)
    if (!baselineValidation.ok) throw new Error(formatIssues('Invalid ANX version baseline', baselineValidation.issues))
    if (versionBaseline.documentId !== input.document.documentId) throw new Error('ANX version baseline must target the current document ID')
    if (versionBaseline.revision > input.document.revision) throw new Error('ANX version baseline cannot be newer than the current document')
  }

  const files: Record<string, Uint8Array> = {
    [MIME_PATH]: strToU8(ANX_MEDIA_TYPE),
    [DOCUMENT_PATH]: strToU8(canonicalJson(input.document)),
    [HISTORY_PATH]: strToU8(renderTransactions(transactions)),
    [HTML_PATH]: strToU8(renderHtml(input.document)),
  }
  if (versionBaseline) files[ANX_VERSION_BASELINE_PATH] = strToU8(canonicalJson(versionBaseline))
  if (input.profiles) {
    const validation = validateProfiles(input.profiles)
    if (!validation.ok) throw new Error(formatIssues('Invalid ANX profile declaration', validation.issues))
    files[ANDOC_PROFILE_PATH] = strToU8(canonicalJson(input.profiles))
  }
  if (input.lineage) {
    const validation = validateLineage(input.lineage)
    if (!validation.ok) throw new Error(formatIssues('Invalid ANX lineage', validation.issues))
    files[ANDOC_LINEAGE_PATH] = strToU8(canonicalJson(input.lineage))
  }
  if (input.finalizations?.length) {
    input.finalizations.forEach((record, index) => {
      const validation = validateFinalization(record)
      if (!validation.ok) throw new Error(formatIssues(`Invalid ANX finalization ${index}`, validation.issues))
    })
    files[ANDOC_FINALIZATIONS_PATH] = strToU8(canonicalJson(input.finalizations))
  }
  if (input.sourceBaselines) {
    const validation = validateSourceBaselines(input.sourceBaselines)
    if (!validation.ok) throw new Error(formatIssues('Invalid ANX source-baseline registry', validation.issues))
    files[ANX_SOURCE_BASELINES_PATH] = strToU8(canonicalJson(input.sourceBaselines))
  }

  for (const asset of Object.values(input.document.assets)) {
    const bytes = input.assets?.[asset.id]
    if (!bytes) throw new Error(`Missing bytes for asset ${asset.id}`)
    verifyAssetMetadata(asset, bytes)
    files[asset.packagePath] = bytes
  }

  for (const [sourcePath, bytes] of Object.entries(input.sources || {})) {
    const normalized = normalizePackagePath(sourcePath)
    if (!normalized.startsWith('sources/')) throw new Error(`Source entry must be under sources/: ${sourcePath}`)
    if (normalized === ANX_SOURCE_BASELINES_PATH) throw new Error(`Reserved ANX source-baseline path must use sourceBaselines: ${sourcePath}`)
    files[normalized] = bytes
  }

  const assetMediaTypes = new Map<string, string>(Object.values(input.document.assets).map(asset => [asset.packagePath, asset.mediaType]))
  const entries = Object.entries(files)
    .filter(([entryPath]) => entryPath !== MIME_PATH)
    .map(([entryPath, bytes]) => manifestEntry(entryPath, bytes, assetMediaTypes.get(entryPath)))
    .sort((left, right) => left.path.localeCompare(right.path))

  const manifest: AndocManifest = {
    schema: ANDOC_MANIFEST_SCHEMA,
    formatVersion: input.profiles || input.lineage || input.finalizations?.length || input.sourceBaselines || versionBaseline ? '1.1' : '1.0',
    mediaType: ANX_MEDIA_TYPE,
    document: DOCUMENT_PATH,
    revision: input.document.revision,
    entries,
  }
  files[MANIFEST_PATH] = strToU8(canonicalJson(manifest))

  const ordered = Object.fromEntries(
    Object.entries(files)
      .sort(([left], [right]) => packageOrder(left) - packageOrder(right) || left.localeCompare(right)),
  )
  assertFileSetLimits(ordered)
  const bytes = zipSync(ordered, { level: 6, mtime: FIXED_ZIP_TIME })
  if (bytes.length > ANDOC_PACKAGE_LIMITS.maximumPackageBytes) throw new Error('ANX package exceeds the compressed package limit')
  if (outputPath) await writeFile(outputPath, bytes)
  return bytes
}

export async function readAndoc(input: string | Uint8Array): Promise<AndocPackage> {
  if (typeof input !== 'string') return decodeAndoc(input)
  const resolved = path.resolve(input)
  const existing = inFlightPathReads.get(resolved)
  if (existing) return existing
  const pending = readFile(resolved).then(bytes => decodeAndoc(new Uint8Array(bytes)))
  inFlightPathReads.set(resolved, pending)
  try {
    return await pending
  } finally {
    if (inFlightPathReads.get(resolved) === pending) inFlightPathReads.delete(resolved)
  }
}

function decodeAndoc(bytes: Uint8Array): AndocPackage {
  const files = safeUnzip(bytes)
  const result = validateAndocFiles(files)
  if (!result.ok || !result.document || !result.manifest) {
    throw new Error(formatIssues('Invalid ANX package', result.issues))
  }
  return {
      manifest: result.manifest,
      document: result.document,
      ...(result.versionBaseline ? { versionBaseline: result.versionBaseline } : {}),
      transactions: parseTransactions(files[HISTORY_PATH]),
      ...(result.profiles ? { profiles: result.profiles } : {}),
      ...(result.lineage ? { lineage: result.lineage } : {}),
      finalizations: result.finalizations || [],
      ...(result.sourceBaselines ? { sourceBaselines: result.sourceBaselines } : {}),
      files,
  }
}

export async function repackAndocPackage(
  pkg: AndocPackage,
  overrides: Partial<Pick<PackageInput, 'document' | 'versionBaseline' | 'transactions' | 'profiles' | 'lineage' | 'finalizations' | 'sourceBaselines'>> = {},
): Promise<Uint8Array> {
  const document = overrides.document || pkg.document
  const assets = Object.fromEntries(Object.values(document.assets).map(asset => {
    const bytes = pkg.files[asset.packagePath]
    if (!bytes) throw new Error(`Cannot preserve missing asset bytes: ${asset.id}`)
    return [asset.id, bytes]
  }))
  const sources = Object.fromEntries(Object.entries(pkg.files).filter(([entryPath]) => entryPath.startsWith('sources/') && entryPath !== ANX_SOURCE_BASELINES_PATH))
  return packAndoc({
    document,
    versionBaseline: overrides.versionBaseline || pkg.versionBaseline || pkg.document,
    assets,
    sources,
    transactions: overrides.transactions || pkg.transactions,
    ...(overrides.profiles !== undefined ? { profiles: overrides.profiles } : pkg.profiles ? { profiles: pkg.profiles } : {}),
    ...(overrides.lineage !== undefined ? { lineage: overrides.lineage } : pkg.lineage ? { lineage: pkg.lineage } : {}),
    finalizations: overrides.finalizations || pkg.finalizations,
    ...(overrides.sourceBaselines !== undefined
      ? { sourceBaselines: overrides.sourceBaselines }
      : pkg.sourceBaselines ? { sourceBaselines: pkg.sourceBaselines } : {}),
  })
}

export async function validateAndoc(input: string | Uint8Array): Promise<ValidationResult> {
  try {
    const bytes = typeof input === 'string' ? new Uint8Array(await readFile(input)) : input
    return validateAndocFiles(safeUnzip(bytes))
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: 'invalid_zip', path: '/', message: error instanceof Error ? error.message : String(error) }],
    }
  }
}

export async function unpackAndoc(input: string | Uint8Array, outputDirectory: string): Promise<AndocPackage> {
  const pkg = await readAndoc(input)
  const root = path.resolve(outputDirectory)
  await mkdir(root, { recursive: true })
  for (const [entryPath, bytes] of Object.entries(pkg.files)) {
    const normalized = normalizePackagePath(entryPath)
    const destination = path.resolve(root, normalized)
    if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Unsafe package path: ${entryPath}`)
    }
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
  return pkg
}

function validateAndocFiles(files: Record<string, Uint8Array>): ValidationResult {
  const issues: ValidationIssue[] = []
  for (const entryPath of Object.keys(files)) {
    try {
      normalizePackagePath(entryPath)
    } catch (error) {
      issues.push({ code: 'unsafe_path', path: entryPath, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const mediaType = strFromU8(files[MIME_PATH] || new Uint8Array())
  if (mediaType !== ANX_MEDIA_TYPE && mediaType !== LEGACY_AGN_MEDIA_TYPE && mediaType !== LEGACY_ANDOC_MEDIA_TYPE) {
    issues.push({ code: 'invalid_mimetype', path: MIME_PATH, message: `Expected ${ANX_MEDIA_TYPE} (legacy ${LEGACY_AGN_MEDIA_TYPE} and ${LEGACY_ANDOC_MEDIA_TYPE} are also accepted)` })
  }

  const manifestValue = parseJson(files[MANIFEST_PATH], MANIFEST_PATH, issues)
  const documentValue = parseJson(files[DOCUMENT_PATH], DOCUMENT_PATH, issues)
  const versionBaselineValue = files[ANX_VERSION_BASELINE_PATH] ? parseJson(files[ANX_VERSION_BASELINE_PATH], ANX_VERSION_BASELINE_PATH, issues) : undefined
  const profilesValue = files[ANDOC_PROFILE_PATH] ? parseJson(files[ANDOC_PROFILE_PATH], ANDOC_PROFILE_PATH, issues) : undefined
  const lineageValue = files[ANDOC_LINEAGE_PATH] ? parseJson(files[ANDOC_LINEAGE_PATH], ANDOC_LINEAGE_PATH, issues) : undefined
  const finalizationsValue = files[ANDOC_FINALIZATIONS_PATH] ? parseJson(files[ANDOC_FINALIZATIONS_PATH], ANDOC_FINALIZATIONS_PATH, issues) : []
  const sourceBaselinesValue = files[ANX_SOURCE_BASELINES_PATH] ? parseJson(files[ANX_SOURCE_BASELINES_PATH], ANX_SOURCE_BASELINES_PATH, issues) : undefined
  const manifestResult = validateManifest(manifestValue)
  const documentResult = validateDocument(documentValue)
  const versionBaselineResult = versionBaselineValue === undefined ? { ok: true, issues: [] as ValidationIssue[] } : validateDocument(versionBaselineValue)
  const profilesResult = profilesValue === undefined ? { ok: true, issues: [] as ValidationIssue[] } : validateProfiles(profilesValue)
  const lineageResult = lineageValue === undefined ? { ok: true, issues: [] as ValidationIssue[] } : validateLineage(lineageValue)
  const sourceBaselinesResult = sourceBaselinesValue === undefined ? { ok: true, issues: [] as ValidationIssue[] } : validateSourceBaselines(sourceBaselinesValue)
  const finalizations: AndocFinalization[] = []
  if (!Array.isArray(finalizationsValue)) {
    issues.push({ code: 'invalid_finalizations', path: ANDOC_FINALIZATIONS_PATH, message: 'Finalization records must be a JSON array' })
  } else {
    finalizationsValue.forEach((value, index) => {
      const result = validateFinalization(value)
      issues.push(...result.issues.map(issue => ({ ...issue, path: `${ANDOC_FINALIZATIONS_PATH}/${index}${issue.path}` })))
      if (result.finalization) finalizations.push(result.finalization)
    })
  }
  issues.push(...manifestResult.issues.map(issue => ({ ...issue, path: `${MANIFEST_PATH}${issue.path}` })))
  issues.push(...documentResult.issues.map(issue => ({ ...issue, path: `${DOCUMENT_PATH}${issue.path}` })))
  issues.push(...versionBaselineResult.issues.map(issue => ({ ...issue, path: `${ANX_VERSION_BASELINE_PATH}${issue.path}` })))
  issues.push(...profilesResult.issues.map(issue => ({ ...issue, path: `${ANDOC_PROFILE_PATH}${issue.path}` })))
  issues.push(...lineageResult.issues.map(issue => ({ ...issue, path: `${ANDOC_LINEAGE_PATH}${issue.path}` })))
  issues.push(...sourceBaselinesResult.issues.map(issue => ({ ...issue, path: `${ANX_SOURCE_BASELINES_PATH}${issue.path}` })))

  const manifest = manifestResult.manifest
  const document = documentResult.document
  const versionBaseline = 'document' in versionBaselineResult ? versionBaselineResult.document : undefined
  const profiles = 'profiles' in profilesResult ? profilesResult.profiles : undefined
  const lineage = 'lineage' in lineageResult ? lineageResult.lineage : undefined
  const sourceBaselines = 'sourceBaselines' in sourceBaselinesResult ? sourceBaselinesResult.sourceBaselines : undefined
  if (manifest && document && manifest.revision !== document.revision) {
    issues.push({ code: 'revision_mismatch', path: MANIFEST_PATH, message: `Manifest revision ${manifest.revision} does not match document revision ${document.revision}` })
  }

  if (document && versionBaseline) {
    if (versionBaseline.documentId !== document.documentId) {
      issues.push({ code: 'version_baseline_document_mismatch', path: ANX_VERSION_BASELINE_PATH, message: `Version baseline targets ${versionBaseline.documentId}, current document is ${document.documentId}` })
    }
    if (versionBaseline.revision > document.revision) {
      issues.push({ code: 'version_baseline_revision_mismatch', path: ANX_VERSION_BASELINE_PATH, message: `Version baseline revision ${versionBaseline.revision} exceeds current revision ${document.revision}` })
    }
    try {
      const relevantTransactions = parseTransactions(files[HISTORY_PATH]).filter(transaction => transaction.baseRevision >= versionBaseline.revision)
      const futureTransactions = relevantTransactions.filter(transaction => transaction.baseRevision >= document.revision)
      if (futureTransactions.length) {
        issues.push({ code: 'version_history_future', path: HISTORY_PATH, message: `Version history contains ${futureTransactions.length} transaction(s) at or beyond current revision ${document.revision}` })
      }
      let replayed = structuredClone(versionBaseline)
      let replayComplete = true
      for (let revision = versionBaseline.revision; revision < document.revision; revision += 1) {
        const matches = relevantTransactions.filter(transaction => transaction.baseRevision === revision)
        if (matches.length !== 1) {
          issues.push({ code: 'version_history_gap', path: HISTORY_PATH, message: `Version history requires exactly one transaction from revision ${revision}; found ${matches.length}` })
          replayComplete = false
          continue
        }
        if (replayComplete) {
          try {
            replayed = applyTransaction(replayed, matches[0]!)
          } catch (error) {
            issues.push({ code: 'version_history_replay_failed', path: HISTORY_PATH, message: `Version history failed to replay revision ${revision}: ${error instanceof Error ? error.message : String(error)}` })
            replayComplete = false
          }
        }
      }
      if (replayComplete && canonicalJson(replayed) !== canonicalJson(document)) {
        issues.push({ code: 'version_history_document_mismatch', path: DOCUMENT_PATH, message: 'Current canonical document does not equal the deterministic result of replaying the retained version history' })
      }
    } catch {}
  }

  if (manifest) {
    const declared = new Set(manifest.entries.map(entry => entry.path))
    for (const entry of manifest.entries) {
      const bytes = files[entry.path]
      if (!bytes) {
        issues.push({ code: 'missing_entry', path: entry.path, message: 'Manifest entry is missing from package' })
        continue
      }
      if (bytes.length !== entry.size) issues.push({ code: 'size_mismatch', path: entry.path, message: `Expected ${entry.size} bytes, found ${bytes.length}` })
      const digest = sha256(bytes)
      if (digest !== entry.sha256) issues.push({ code: 'hash_mismatch', path: entry.path, message: `Expected ${entry.sha256}, found ${digest}` })
    }
    for (const entryPath of Object.keys(files)) {
      if (![MIME_PATH, MANIFEST_PATH].includes(entryPath) && !declared.has(entryPath)) {
        issues.push({ code: 'undeclared_entry', path: entryPath, message: 'Package entry is not declared in manifest' })
      }
    }
  }

  if (document) {
    for (const asset of Object.values(document.assets)) {
      const bytes = files[asset.packagePath]
      if (!bytes) continue
      if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
        issues.push({ code: 'asset_integrity', path: asset.packagePath, message: `Asset bytes do not match document metadata for ${asset.id}` })
      }
      const manifestEntry = manifest?.entries.find(entry => entry.path === asset.packagePath)
      if (manifestEntry && (manifestEntry.mediaType !== asset.mediaType || manifestEntry.role !== 'asset')) {
        issues.push({ code: 'asset_manifest_mismatch', path: asset.packagePath, message: `Manifest metadata does not match asset ${asset.id}` })
      }
    }
  }

  if (manifest) {
    const profileEntry = manifest.entries.find(entry => entry.path === ANDOC_PROFILE_PATH)
    if (profileEntry && profileEntry.role !== 'profile') issues.push({ code: 'profile_manifest_mismatch', path: ANDOC_PROFILE_PATH, message: 'Profile declaration must use the profile manifest role' })
    const finalizationEntry = manifest.entries.find(entry => entry.path === ANDOC_FINALIZATIONS_PATH)
    if (finalizationEntry && finalizationEntry.role !== 'finalization') issues.push({ code: 'finalization_manifest_mismatch', path: ANDOC_FINALIZATIONS_PATH, message: 'Finalization records must use the finalization manifest role' })
    const lineageEntry = manifest.entries.find(entry => entry.path === ANDOC_LINEAGE_PATH)
    if (lineageEntry && lineageEntry.role !== 'lineage') issues.push({ code: 'lineage_manifest_mismatch', path: ANDOC_LINEAGE_PATH, message: 'Lineage records must use the lineage manifest role' })
    const versionBaselineEntry = manifest.entries.find(entry => entry.path === ANX_VERSION_BASELINE_PATH)
    if (versionBaselineEntry && versionBaselineEntry.role !== 'history') issues.push({ code: 'version_baseline_manifest_mismatch', path: ANX_VERSION_BASELINE_PATH, message: 'Version baseline must use the history manifest role' })
    const sourceBaselinesEntry = manifest.entries.find(entry => entry.path === ANX_SOURCE_BASELINES_PATH)
    if (sourceBaselinesEntry && sourceBaselinesEntry.role !== 'source') issues.push({ code: 'source_baseline_manifest_mismatch', path: ANX_SOURCE_BASELINES_PATH, message: 'Source-baseline evidence must use the source manifest role' })
  }

  if (document && manifest && sourceBaselines) {
    sourceBaselines.records.forEach((record, index) => {
      if (record.documentId !== document.documentId || record.documentRevisionAtRegistration > document.revision) {
        issues.push({ code: 'source_baseline_document_mismatch', path: `${ANX_SOURCE_BASELINES_PATH}/records/${index}`, message: 'Source-baseline evidence must target this document at an existing revision' })
      }
      const sourceEntry = manifest.entries.find(entry => entry.path === record.source.path)
      if (!sourceEntry
        || sourceEntry.role !== 'source'
        || sourceEntry.sha256 !== record.source.sha256
        || sourceEntry.size !== record.source.size
        || sourceEntry.mediaType !== record.source.mediaType) {
        issues.push({ code: 'source_baseline_source_mismatch', path: `${ANX_SOURCE_BASELINES_PATH}/records/${index}/source`, message: 'Source-baseline evidence must bind an exact retained original source entry' })
      }
    })
  }

  if (document && lineage) {
    if (lineage.documentId !== document.documentId) {
      issues.push({ code: 'lineage_document_mismatch', path: ANDOC_LINEAGE_PATH, message: `Lineage targets ${lineage.documentId}, current document is ${document.documentId}` })
    }
    if (lineage.derivedRevision !== lineage.parent.revision + 1 || document.revision < lineage.derivedRevision) {
      issues.push({ code: 'lineage_revision_mismatch', path: ANDOC_LINEAGE_PATH, message: `Derived revision ${lineage.derivedRevision} must follow parent revision ${lineage.parent.revision} and not exceed current revision ${document.revision}` })
    }
    if (lineage.parent.mode !== 'reference') {
      const parentBytes = files[lineage.parent.packagePath]
      if (!parentBytes || sha256(parentBytes) !== lineage.parent.packageSha256) {
        issues.push({ code: 'lineage_parent_mismatch', path: lineage.parent.packagePath, message: 'Embedded parent package is missing or does not match the lineage digest' })
      }
    }
  }

  if (document) {
    finalizations.forEach((record, index) => {
      if (record.documentId !== document.documentId || record.revision !== document.revision) {
        issues.push({ code: 'finalization_target_mismatch', path: `${ANDOC_FINALIZATIONS_PATH}/${index}`, message: `Finalization targets ${record.documentId}@${record.revision}, current package is ${document.documentId}@${document.revision}` })
      }
      if (record.supersedes && (!lineage
        || record.supersedes.finalizationId !== lineage.parent.finalizationId
        || record.supersedes.packageSha256 !== lineage.parent.packageSha256
        || record.supersedes.protectedEntryRootSha256 !== lineage.parent.protectedEntryRootSha256)) {
        issues.push({ code: 'finalization_lineage_mismatch', path: `${ANDOC_FINALIZATIONS_PATH}/${index}/supersedes`, message: 'Finalization supersession reference does not match the package lineage record' })
      }
      if (lineage && !record.supersedes) {
        issues.push({ code: 'missing_finalization_lineage', path: `${ANDOC_FINALIZATIONS_PATH}/${index}/supersedes`, message: 'A finalized derived package must declare which finalization it supersedes' })
      }
    })
  }

  try {
    parseTransactions(files[HISTORY_PATH])
  } catch (error) {
    issues.push({ code: 'invalid_history', path: HISTORY_PATH, message: error instanceof Error ? error.message : String(error) })
  }

  return { ok: issues.length === 0, issues, document, ...(versionBaseline ? { versionBaseline } : {}), manifest, ...(profiles ? { profiles } : {}), ...(lineage ? { lineage } : {}), finalizations, ...(sourceBaselines ? { sourceBaselines } : {}) }
}

function safeUnzip(bytes: Uint8Array): Record<string, Uint8Array> {
  inspectZipArchive(bytes)
  return unzipSync(bytes)
}

function inspectZipArchive(bytes: Uint8Array): void {
  if (bytes.length > ANDOC_PACKAGE_LIMITS.maximumPackageBytes) throw new Error(`ZIP exceeds the ${ANDOC_PACKAGE_LIMITS.maximumPackageBytes} byte package limit`)
  if (bytes.length < 22) throw new Error('ZIP end-of-central-directory record is missing')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const earliest = Math.max(0, bytes.length - 22 - 65_535)
  let endOffset = -1
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new Error('ZIP end-of-central-directory record is missing')
  const diskNumber = view.getUint16(endOffset + 4, true)
  const centralDisk = view.getUint16(endOffset + 6, true)
  const entriesOnDisk = view.getUint16(endOffset + 8, true)
  const entryCount = view.getUint16(endOffset + 10, true)
  const centralSize = view.getUint32(endOffset + 12, true)
  const centralOffset = view.getUint32(endOffset + 16, true)
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error('Multi-disk ZIP packages are not supported')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 packages are not supported')
  if (entryCount > ANDOC_PACKAGE_LIMITS.maximumEntries) throw new Error(`ZIP contains ${entryCount} entries; maximum is ${ANDOC_PACKAGE_LIMITS.maximumEntries}`)
  if (centralOffset + centralSize > endOffset) throw new Error('ZIP central directory is out of bounds')

  let position = centralOffset
  let expandedTotal = 0
  const names = new Set<string>()
  for (let index = 0; index < entryCount; index += 1) {
    if (position + 46 > endOffset || view.getUint32(position, true) !== 0x02014b50) throw new Error(`ZIP central directory entry ${index + 1} is invalid`)
    const flags = view.getUint16(position + 8, true)
    const compressedSize = view.getUint32(position + 20, true)
    const expandedSize = view.getUint32(position + 24, true)
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const commentLength = view.getUint16(position + 32, true)
    const next = position + 46 + nameLength + extraLength + commentLength
    if (next > endOffset) throw new Error(`ZIP central directory entry ${index + 1} is out of bounds`)
    if ((flags & 0x1) !== 0) throw new Error('Encrypted ZIP entries are not supported')
    if (compressedSize === 0xffffffff || expandedSize === 0xffffffff) throw new Error('ZIP64 entries are not supported')
    if (expandedSize > ANDOC_PACKAGE_LIMITS.maximumEntryBytes) throw new Error(`ZIP entry ${index + 1} exceeds the expanded entry limit`)
    expandedTotal += expandedSize
    if (expandedTotal > ANDOC_PACKAGE_LIMITS.maximumExpandedBytes) throw new Error('ZIP exceeds the total expanded package limit')
    const name = strFromU8(bytes.subarray(position + 46, position + 46 + nameLength))
    if (names.has(name)) throw new Error(`ZIP contains a duplicate entry: ${name}`)
    names.add(name)
    position = next
  }
  if (position !== centralOffset + centralSize) throw new Error('ZIP central directory size does not match its entries')
}

function assertFileSetLimits(files: Record<string, Uint8Array>): void {
  const entries = Object.entries(files)
  if (entries.length > ANDOC_PACKAGE_LIMITS.maximumEntries) throw new Error(`ANX package contains too many entries: ${entries.length}`)
  let expandedTotal = 0
  for (const [entryPath, bytes] of entries) {
    if (bytes.length > ANDOC_PACKAGE_LIMITS.maximumEntryBytes) throw new Error(`Package entry exceeds the expanded entry limit: ${entryPath}`)
    expandedTotal += bytes.length
    if (expandedTotal > ANDOC_PACKAGE_LIMITS.maximumExpandedBytes) throw new Error('ANX package exceeds the total expanded package limit')
  }
}

function manifestEntry(entryPath: string, bytes: Uint8Array, declaredMediaType?: string): ManifestEntry {
  const role = entryPath === DOCUMENT_PATH ? 'canonical'
    : entryPath === HISTORY_PATH ? 'history'
      : entryPath === ANX_VERSION_BASELINE_PATH ? 'history'
      : entryPath === HTML_PATH ? 'human-view'
        : entryPath.startsWith('assets/') ? 'asset'
          : entryPath === ANDOC_PROFILE_PATH ? 'profile'
            : entryPath === ANDOC_LINEAGE_PATH ? 'lineage'
      : entryPath === ANDOC_FINALIZATIONS_PATH ? 'finalization'
                : entryPath === ANX_SOURCE_BASELINES_PATH ? 'source'
                : entryPath.startsWith('extensions/') ? 'extension'
                  : entryPath.startsWith('signatures/') ? 'signature'
                    : entryPath.startsWith('receipts/') ? 'receipt'
                      : 'source'
  const mediaType = declaredMediaType || (entryPath.endsWith('.json') ? 'application/json'
    : entryPath.endsWith('.jsonl') ? 'application/x-ndjson'
      : entryPath.endsWith('.html') ? 'text/html'
        : entryPath.endsWith('.pdf') ? 'application/pdf'
          : entryPath.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : entryPath.endsWith('.pptx') ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
              : entryPath.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : entryPath.endsWith('.png') ? 'image/png'
          : entryPath.endsWith('.jpg') || entryPath.endsWith('.jpeg') ? 'image/jpeg'
            : entryPath.endsWith('.svg') ? 'image/svg+xml'
              : entryPath.endsWith('.csv') ? 'text/csv'
                : 'application/octet-stream')
  return { path: entryPath, mediaType, sha256: sha256(bytes), size: bytes.length, role }
}

function verifyAssetMetadata(asset: AndocAsset, bytes: Uint8Array): void {
  if (asset.size !== bytes.length) throw new Error(`Asset ${asset.id} size mismatch: metadata=${asset.size}, bytes=${bytes.length}`)
  const digest = sha256(bytes)
  if (asset.sha256 !== digest) throw new Error(`Asset ${asset.id} SHA-256 mismatch: metadata=${asset.sha256}, bytes=${digest}`)
}

function normalizePackagePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) throw new Error(`Unsafe package path: ${value}`)
  if (normalized.split('/').some(segment => segment === '..' || segment === '')) throw new Error(`Unsafe package path: ${value}`)
  return normalized
}

function packageOrder(entryPath: string): number {
  if (entryPath === MIME_PATH) return 0
  if (entryPath === MANIFEST_PATH) return 1
  if (entryPath === DOCUMENT_PATH) return 2
  return 3
}

function renderTransactions(transactions: AndocTransaction[]): string {
  return transactions.length ? `${transactions.map(transaction => JSON.stringify(transaction)).join('\n')}\n` : ''
}

function parseTransactions(bytes?: Uint8Array): AndocTransaction[] {
  if (!bytes?.length) return []
  return strFromU8(bytes).split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const value = JSON.parse(line) as unknown
      const validation = validateTransaction(value)
      if (!validation.ok || !validation.transaction) {
        throw new Error(validation.issues.map(issue => `${issue.path} ${issue.message}`).join('; '))
      }
      return validation.transaction
    } catch {
      throw new Error(`Invalid transaction on line ${index + 1}`)
    }
  })
}

function parseJson(bytes: Uint8Array | undefined, entryPath: string, issues: ValidationIssue[]): unknown {
  if (!bytes) {
    issues.push({ code: 'missing_required_entry', path: entryPath, message: 'Required package entry is missing' })
    return null
  }
  try {
    return JSON.parse(strFromU8(bytes))
  } catch (error) {
    issues.push({ code: 'invalid_json', path: entryPath, message: error instanceof Error ? error.message : String(error) })
    return null
  }
}

function formatIssues(prefix: string, issues: ValidationIssue[]): string {
  return `${prefix}: ${issues.map(issue => `${issue.code} at ${issue.path}: ${issue.message}`).join('; ')}`
}
