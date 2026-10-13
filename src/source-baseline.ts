import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { canonicalJson, sha256 } from './hash.js'
import {
  ANX_SOURCE_BASELINES_PATH,
  readAndoc,
  repackAndocPackage,
  type AndocPackage,
} from './package.js'
import {
  ANX_SOURCE_BASELINES_SCHEMA,
  ANX_SOURCE_BASELINE_SCHEMA,
  type AndocActor,
  type AndocTrustStore,
  type AnxSourceAcquisitionMethod,
  type AnxSourceBaseline,
  type AnxSourceBaselines,
} from './types.js'
import { validateSourceBaselines } from './validate.js'
import { releaseControlState } from './release-control.js'

export const ANX_SOURCE_BASELINE_STATEMENT = "Accepted as the organization's controlled source baseline; issuer authenticity is not independently verified." as const
export const ANX_SOURCE_BASELINE_ROLE = 'source-baseline-registrar' as const

export interface RegisterSourceBaselineOptions {
  actor: AndocActor & { type: 'human' }
  privateKeyPem: string | Uint8Array
  keyId: string
  role: typeof ANX_SOURCE_BASELINE_ROLE
  registeredAt: string
  organization?: string
  title: string
  publisher?: string
  edition?: string
  acquisitionMethod: AnxSourceAcquisitionMethod
  acquiredAt?: string
  sourceUri?: string
  supplier?: string
  orderReference?: string
  supersedes?: AnxSourceBaseline['supersedes']
  outputPath?: string
}

export interface SourceBaselineVerification {
  status: 'UNVERIFIED_SOURCE' | 'TAMPERED' | 'REGISTERED_UNTRUSTED_SIGNER' | 'REGISTERED_TRUSTED'
  evidencePresent: boolean
  valid: boolean
  registered: boolean
  trusted: boolean
  cryptographicallyValid: boolean
  sourceMatches: boolean
  issuerVerified: false
  documentId: string
  revision: number
  source?: AnxSourceBaseline['source']
  baselineId?: string
  registeredAt?: string
  registeredBy?: string
  organization?: string
  title?: string
  publisher?: string
  edition?: string
  acquisition?: AnxSourceBaseline['acquisition']
  supersedes?: AnxSourceBaseline['supersedes']
  keyId?: string
  publicKeySha256?: string
  statement: string
  agentGuidance: string
  reason?: string
}

export interface RegisterSourceBaselineResult {
  packageBytes: Uint8Array
  sourceBaselines: AnxSourceBaselines
  baseline: AnxSourceBaseline
  verification: SourceBaselineVerification
}

export async function registerSourceBaseline(
  input: string | Uint8Array | AndocPackage,
  options: RegisterSourceBaselineOptions,
): Promise<RegisterSourceBaselineResult> {
  const pkg = isAndocPackage(input) ? input : await readAndoc(input)
  if (pkg.finalizations.length) throw new Error('DOCUMENT_FINALIZED: derive a working copy before registering source evidence')
  const lifecycle = releaseControlState(pkg.document)
  if (lifecycle.state !== 'working') throw new Error(`SOURCE_BASELINE_LIFECYCLE_BLOCKED: registration requires WORKING state; current state is ${lifecycle.state}`)
  if (pkg.sourceBaselines?.records.length) throw new Error('SOURCE_BASELINE_ALREADY_REGISTERED')
  if (options.actor.type !== 'human' || !stableActorId(options.actor.id)) throw new Error('Source-baseline registration requires a stable human actor ID')
  if (options.role !== ANX_SOURCE_BASELINE_ROLE) throw new Error(`Source-baseline signatures require role ${ANX_SOURCE_BASELINE_ROLE}`)
  if (!stableId(options.keyId)) throw new Error('Source-baseline registration requires a stable key ID')
  if (!validTimestamp(options.registeredAt)) throw new Error('Source-baseline registration requires a valid registeredAt timestamp')
  if (options.acquiredAt && !validTimestamp(options.acquiredAt)) throw new Error('Source-baseline acquiredAt must be a valid timestamp')

  const title = requiredText(options.title, 'title', 2048)
  const originalEntries = pkg.manifest.entries.filter(entry => entry.path.startsWith('sources/original/'))
  if (originalEntries.length !== 1) throw new Error(`Source-baseline registration requires exactly one retained original source; found ${originalEntries.length}`)
  const sourceEntry = originalEntries[0]!
  const sourceBytes = pkg.files[sourceEntry.path]
  if (!sourceBytes || sourceBytes.length !== sourceEntry.size || sha256(sourceBytes) !== sourceEntry.sha256) {
    throw new Error('RETAINED_SOURCE_INTEGRITY_FAILED')
  }

  const privateKey = createPrivateKey(typeof options.privateKeyPem === 'string' ? options.privateKeyPem : Buffer.from(options.privateKeyPem))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Source-baseline registrations require an Ed25519 private key')
  const publicKeyDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  const source: AnxSourceBaseline['source'] = {
    path: sourceEntry.path,
    fileName: sourceFileName(pkg, sourceEntry.path),
    mediaType: sourceEntry.mediaType,
    sha256: sourceEntry.sha256,
    size: sourceEntry.size,
  }
  const seed = {
    schema: ANX_SOURCE_BASELINE_SCHEMA,
    designation: 'organization-baseline' as const,
    documentId: pkg.document.documentId,
    documentRevisionAtRegistration: pkg.document.revision,
    source,
    registeredAt: options.registeredAt,
    registeredBy: options.actor,
    ...(optionalText(options.organization, 512) ? { organization: optionalText(options.organization, 512)! } : {}),
    description: {
      title,
      ...(optionalText(options.publisher, 1024) ? { publisher: optionalText(options.publisher, 1024)! } : {}),
      ...(optionalText(options.edition, 512) ? { edition: optionalText(options.edition, 512)! } : {}),
    },
    acquisition: {
      method: options.acquisitionMethod,
      ...(options.acquiredAt ? { acquiredAt: options.acquiredAt } : {}),
      ...(optionalText(options.sourceUri, 4096) ? { sourceUri: optionalText(options.sourceUri, 4096)! } : {}),
      ...(optionalText(options.supplier, 1024) ? { supplier: optionalText(options.supplier, 1024)! } : {}),
      ...(optionalText(options.orderReference, 1024) ? { orderReference: optionalText(options.orderReference, 1024)! } : {}),
    },
    ...(options.supersedes ? { supersedes: structuredClone(options.supersedes) } : {}),
    issuerVerification: { status: 'not-established' as const },
    rights: { redistribution: 'not-established' as const },
    statement: ANX_SOURCE_BASELINE_STATEMENT,
  }
  const id = `baseline-${sha256(Buffer.from(canonicalJson(seed))).slice(0, 24)}`
  const signatureMetadata = {
    algorithm: 'Ed25519' as const,
    keyId: options.keyId,
    role: ANX_SOURCE_BASELINE_ROLE,
    signedAt: options.registeredAt,
    publicKeySpki: publicKeyDer.toString('base64'),
    publicKeySha256: sha256(publicKeyDer),
  }
  const signedBody = { ...seed, id, signature: signatureMetadata }
  const baseline: AnxSourceBaseline = {
    ...signedBody,
    signature: {
      ...signatureMetadata,
      value: sign(null, Buffer.from(canonicalJson(signedBody)), privateKey).toString('base64'),
    },
  }
  const sourceBaselines: AnxSourceBaselines = {
    schema: ANX_SOURCE_BASELINES_SCHEMA,
    activeBaselineId: baseline.id,
    records: [baseline],
  }
  const validation = validateSourceBaselines(sourceBaselines)
  if (!validation.ok) throw new Error(`Invalid source-baseline registration: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
  const packageBytes = await repackAndocPackage(pkg, { sourceBaselines })
  const verification = await verifySourceBaseline(packageBytes)
  if (!verification.valid) throw new Error(`Source-baseline registration failed verification: ${verification.reason || verification.status}`)
  if (options.outputPath) await writeFile(options.outputPath, packageBytes)
  return { packageBytes, sourceBaselines, baseline, verification }
}

export async function verifySourceBaseline(
  input: string | Uint8Array | AndocPackage,
  trustStore?: AndocTrustStore,
): Promise<SourceBaselineVerification> {
  const pkg = isAndocPackage(input) ? input : await readAndoc(input)
  const registry = pkg.sourceBaselines
  if (!registry) {
    return {
      status: 'UNVERIFIED_SOURCE',
      evidencePresent: false,
      valid: false,
      registered: false,
      trusted: false,
      cryptographicallyValid: false,
      sourceMatches: retainedOriginalSource(pkg) !== null,
      issuerVerified: false,
      documentId: pkg.document.documentId,
      revision: pkg.document.revision,
      statement: 'No organizational source baseline has been registered.',
      agentGuidance: 'Treat the retained file as an unverified imported source. Do not call it authentic, original, authoritative, or issuer-verified.',
    }
  }

  const record = registry.records.find(candidate => candidate.id === registry.activeBaselineId)
  if (!record) return tampered(pkg, 'Active source-baseline record is missing')
  const sourceEntry = pkg.manifest.entries.find(entry => entry.path === record.source.path)
  const sourceBytes = sourceEntry ? pkg.files[sourceEntry.path] : undefined
  const sourceMatches = Boolean(sourceEntry
    && sourceEntry.path.startsWith('sources/original/')
    && sourceEntry.role === 'source'
    && sourceEntry.mediaType === record.source.mediaType
    && sourceEntry.sha256 === record.source.sha256
    && sourceEntry.size === record.source.size
    && sourceBytes
    && sourceBytes.length === sourceEntry.size
    && sha256(sourceBytes) === sourceEntry.sha256
    && record.documentId === pkg.document.documentId
    && record.documentRevisionAtRegistration <= pkg.document.revision)

  try {
    const { value, ...signatureMetadata } = record.signature
    const signedBody = { ...record, signature: signatureMetadata }
    const publicKeyDer = Buffer.from(record.signature.publicKeySpki, 'base64')
    const idSeed = {
      schema: record.schema,
      designation: record.designation,
      documentId: record.documentId,
      documentRevisionAtRegistration: record.documentRevisionAtRegistration,
      source: record.source,
      registeredAt: record.registeredAt,
      registeredBy: record.registeredBy,
      ...(record.organization ? { organization: record.organization } : {}),
      description: record.description,
      acquisition: record.acquisition,
      ...(record.supersedes ? { supersedes: record.supersedes } : {}),
      issuerVerification: record.issuerVerification,
      rights: record.rights,
      statement: record.statement,
    }
    const idMatches = record.id === `baseline-${sha256(Buffer.from(canonicalJson(idSeed))).slice(0, 24)}`
    const cryptographicallyValid = record.signature.algorithm === 'Ed25519'
      && record.signature.role === ANX_SOURCE_BASELINE_ROLE
      && record.signature.signedAt === record.registeredAt
      && sha256(publicKeyDer) === record.signature.publicKeySha256
      && verify(
        null,
        Buffer.from(canonicalJson(signedBody)),
        createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' }),
        Buffer.from(value, 'base64'),
      )
    const trusted = Boolean(cryptographicallyValid && trustStore?.keys.some(key => key.keyId === record.signature.keyId
      && key.publicKeySha256 === record.signature.publicKeySha256
      && (key.roles || []).includes(ANX_SOURCE_BASELINE_ROLE)))
    const valid = sourceMatches && idMatches && cryptographicallyValid
    return {
      status: valid ? trusted ? 'REGISTERED_TRUSTED' : 'REGISTERED_UNTRUSTED_SIGNER' : 'TAMPERED',
      evidencePresent: true,
      valid,
      registered: valid,
      trusted,
      cryptographicallyValid,
      sourceMatches,
      issuerVerified: false,
      documentId: pkg.document.documentId,
      revision: pkg.document.revision,
      source: record.source,
      baselineId: record.id,
      registeredAt: record.registeredAt,
      registeredBy: record.registeredBy.id,
      ...(record.organization ? { organization: record.organization } : {}),
      title: record.description.title,
      ...(record.description.publisher ? { publisher: record.description.publisher } : {}),
      ...(record.description.edition ? { edition: record.description.edition } : {}),
      acquisition: record.acquisition,
      ...(record.supersedes ? { supersedes: record.supersedes } : {}),
      keyId: record.signature.keyId,
      publicKeySha256: record.signature.publicKeySha256,
      statement: record.statement,
      agentGuidance: valid
        ? 'This exact retained source is the organization-designated baseline. Describe it as a registered baseline, not as an authentic original or issuer-verified copy.'
        : 'The source-baseline claim failed integrity verification. Treat the retained file as an unverified source and disclose the failure.',
      ...(!valid ? { reason: !sourceMatches ? 'The registered source does not match the retained original bytes' : !idMatches ? 'The baseline ID does not match its signed designation' : 'The baseline signature is invalid' } : {}),
    }
  } catch {
    return tampered(pkg, 'The source-baseline signature or payload is invalid', sourceMatches)
  }
}

export function sourceBaselineSummary(verification: SourceBaselineVerification): Record<string, unknown> {
  return {
    status: verification.status,
    evidencePresent: verification.evidencePresent,
    registered: verification.registered,
    trusted: verification.trusted,
    cryptographicallyValid: verification.cryptographicallyValid,
    sourceMatches: verification.sourceMatches,
    issuerVerified: false,
    ...(verification.baselineId ? { baselineId: verification.baselineId } : {}),
    ...(verification.source ? { source: verification.source } : {}),
    ...(verification.registeredAt ? { registeredAt: verification.registeredAt } : {}),
    ...(verification.registeredBy ? { registeredBy: verification.registeredBy } : {}),
    ...(verification.organization ? { organization: verification.organization } : {}),
    ...(verification.title ? { title: verification.title } : {}),
    ...(verification.publisher ? { publisher: verification.publisher } : {}),
    ...(verification.edition ? { edition: verification.edition } : {}),
    ...(verification.acquisition ? { acquisition: verification.acquisition } : {}),
    ...(verification.supersedes ? { supersedes: verification.supersedes } : {}),
    ...(verification.keyId ? { keyId: verification.keyId } : {}),
    ...(verification.publicKeySha256 ? { publicKeySha256: verification.publicKeySha256 } : {}),
    statement: verification.statement,
    agentGuidance: verification.agentGuidance,
    ...(verification.reason ? { reason: verification.reason } : {}),
  }
}

function retainedOriginalSource(pkg: AndocPackage) {
  return pkg.manifest.entries.find(entry => entry.path.startsWith('sources/original/')) || null
}

function sourceFileName(pkg: AndocPackage, sourcePath: string): string {
  const metadata = pkg.document.metadata.source
  if (metadata && typeof metadata === 'object' && typeof (metadata as Record<string, unknown>).fileName === 'string') {
    return requiredText((metadata as Record<string, unknown>).fileName as string, 'source file name', 512)
  }
  return sourcePath.slice(sourcePath.lastIndexOf('/') + 1)
}

function isAndocPackage(value: unknown): value is AndocPackage {
  return Boolean(value && typeof value === 'object' && 'manifest' in value && 'document' in value && 'files' in value)
}

function stableId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function stableActorId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,254}$/.test(value)
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

function requiredText(value: string, field: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Source-baseline registration requires ${field}`)
  if (normalized.length > maximum) throw new Error(`Source-baseline ${field} exceeds ${maximum} characters`)
  return normalized
}

function optionalText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > maximum) throw new Error(`Source-baseline field exceeds ${maximum} characters`)
  return normalized
}

function tampered(pkg: AndocPackage, reason: string, sourceMatches = false): SourceBaselineVerification {
  return {
    status: 'TAMPERED',
    evidencePresent: true,
    valid: false,
    registered: false,
    trusted: false,
    cryptographicallyValid: false,
    sourceMatches,
    issuerVerified: false,
    documentId: pkg.document.documentId,
    revision: pkg.document.revision,
    statement: 'The source-baseline evidence failed verification.',
    agentGuidance: 'Treat the retained file as an unverified source and disclose the baseline-verification failure.',
    reason,
  }
}

export { ANX_SOURCE_BASELINES_PATH }
