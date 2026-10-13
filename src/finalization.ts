import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import {
  ANDOC_FINALIZATION_SCHEMA,
  ANDOC_LINEAGE_SCHEMA,
  ANDOC_TRANSACTION_SCHEMA,
  type AndocActor,
  type AndocFinalization,
  type AndocFinalizationPolicy,
  type AndocFinalizationSignature,
  type AndocExternalReceipt,
  type AndocLineage,
  type AndocProfiles,
  type AndocProtectedContent,
  type AndocTrustStore,
  type ManifestEntry,
} from './types.js'
import { canonicalJson, sha256 } from './hash.js'
import {
  ANDOC_PROFILE_PATH,
  ANX_SOURCE_BASELINES_PATH,
  packAndoc,
  readAndoc,
  repackAndocPackage,
  type AndocPackage,
} from './package.js'
import {
  ANDOC_SIGNATURE_EXTENSION_ID,
  inspectProfiles,
  withRequiredExtension,
} from './profiles.js'
import { applyTransaction } from './transaction.js'
import { validateProfiles } from './validate.js'

export interface FinalizeAndocOptions {
  privateKeyPem: string | Uint8Array
  keyId: string
  role: string
  actor: AndocActor
  createdAt: string
  policy?: AndocFinalizationPolicy
  outputPath?: string
}

export interface CosignAndocOptions {
  privateKeyPem: string | Uint8Array
  keyId: string
  role: string
  signedAt: string
  outputPath?: string
}

export interface DeriveAndocDraftOptions {
  actor: AndocActor
  derivedAt: string
  outputPath?: string
  parentMode?: 'embedded' | 'reference'
  parentUri?: string
  documentMetadataPatch?: Record<string, unknown>
}

export interface SetProfilesResult {
  packageBytes: Uint8Array
  profiles: AndocProfiles
  inspection: Record<string, unknown>
}

export interface FinalizationResult {
  packageBytes: Uint8Array
  finalization: AndocFinalization
  verification: FinalizationVerification
}

export interface DeriveAndocDraftResult {
  packageBytes: Uint8Array
  lineage: AndocLineage
  transactionId: string
  revision: number
}

export interface LineageVerification {
  status: 'NO_LINEAGE' | 'MISSING_PARENT' | 'PARENT_REFERENCE_UNRESOLVED' | 'PARENT_MISMATCH' | 'PARENT_INVALID' | 'VALID_UNTRUSTED' | 'VALID_TRUSTED'
  valid: boolean
  trusted: boolean
  documentId: string
  revision: number
  lineage?: AndocLineage
  parentVerification?: FinalizationVerification
}

export interface SignatureVerification {
  keyId: string
  role: string
  cryptographicallyValid: boolean
  trusted: boolean
  roleAuthorized: boolean
  publicKeySha256: string
}

export interface FinalizationVerification {
  status: 'UNFINALIZED' | 'TAMPERED' | 'POLICY_INCOMPLETE' | 'VALID_UNTRUSTED_SIGNER' | 'VALID_TRUSTED'
  valid: boolean
  trusted: boolean
  sealed: boolean
  documentId: string
  revision: number
  finalizationId?: string
  contentMatches: boolean
  signatureResults: SignatureVerification[]
  policy: {
    id?: string
    complete: boolean
    requiredSignatures: number
    validSignatures: number
    trustedSignatures: number
    requiredRoles: string[]
    missingRoles: string[]
  }
  trustedTime: boolean
  receipts: number
  receiptResults: ReceiptVerification[]
  supersedes?: AndocFinalization['supersedes']
}

export interface ReceiptVerification {
  type: AndocExternalReceipt['type']
  provider: string
  receivedAt: string
  valid: boolean
  trustedTime: boolean
}

export interface FinalizationReceiptVerifier {
  type: AndocExternalReceipt['type']
  provider: string
  trustedTime?: boolean
  verify(record: AndocFinalization, receipt: AndocExternalReceipt): boolean
}

const protectedRoles = new Set<ManifestEntry['role']>(['canonical', 'history', 'human-view', 'asset', 'source', 'profile', 'extension', 'lineage'])

export async function inspectAndocCapabilities(input: string | Uint8Array): Promise<Record<string, unknown>> {
  const pkg = await readAndoc(input)
  return {
    documentId: pkg.document.documentId,
    revision: pkg.document.revision,
    finalized: pkg.finalizations.length > 0,
    ...(pkg.lineage ? { lineage: pkg.lineage } : {}),
    ...inspectProfiles(pkg.profiles),
  }
}

export async function setAndocProfiles(input: string | Uint8Array, profiles: AndocProfiles, outputPath?: string): Promise<SetProfilesResult> {
  const validation = validateProfiles(profiles)
  if (!validation.ok) throw new Error(`Invalid ANX profiles: ${validation.issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
  const pkg = await readAndoc(input)
  if (pkg.finalizations.length) throw new Error('DOCUMENT_FINALIZED: profile declarations cannot change after finalization')
  const packageBytes = await repackAndocPackage(pkg, { profiles })
  if (outputPath) await writeFile(outputPath, packageBytes)
  return { packageBytes, profiles, inspection: inspectProfiles(profiles) }
}

export async function finalizeAndoc(input: string | Uint8Array, options: FinalizeAndocOptions): Promise<FinalizationResult> {
  const pkg = await readAndoc(input)
  if (pkg.finalizations.length) throw new Error(`DOCUMENT_FINALIZED: ${pkg.finalizations[0]!.id}`)
  const profiles = withRequiredExtension(pkg.profiles, ANDOC_SIGNATURE_EXTENSION_ID)
  const profiledBytes = await repackAndocPackage(pkg, { profiles, finalizations: [] })
  const profiledPackage = await readAndoc(profiledBytes)
  const content = protectedContent(profiledPackage)
  const policy = options.policy || { id: 'andoc.policy.single-signer.v1', requiredSignatures: 1 }
  const seed = {
    documentId: profiledPackage.document.documentId,
    revision: profiledPackage.document.revision,
    createdAt: options.createdAt,
    actor: options.actor,
    content,
    policy,
    ...(profiledPackage.lineage ? { supersedes: supersedesReference(profiledPackage.lineage) } : {}),
  }
  const record: AndocFinalization = {
    schema: ANDOC_FINALIZATION_SCHEMA,
    id: `final-${sha256(Buffer.from(canonicalJson(seed))).slice(0, 24)}`,
    ...seed,
    signatures: [],
  }
  record.signatures.push(createSignature(record, options))
  const packageBytes = await repackAndocPackage(profiledPackage, { profiles, finalizations: [record] })
  const verification = await verifyAndocFinalization(packageBytes)
  if (options.outputPath) await writeFile(options.outputPath, packageBytes)
  return { packageBytes, finalization: record, verification }
}

export async function deriveAndocDraft(input: string | Uint8Array, options: DeriveAndocDraftOptions): Promise<DeriveAndocDraftResult> {
  const parentBytes = typeof input === 'string' ? new Uint8Array(await readFile(input)) : new Uint8Array(input)
  const parentPackage = await readAndoc(parentBytes)
  if (parentPackage.finalizations.length !== 1) throw new Error('A derivation parent must contain exactly one finalization record')
  const parentVerification = await verifyAndocFinalization(parentPackage)
  if (!parentVerification.valid) throw new Error(`PARENT_NOT_FINAL: parent verification status is ${parentVerification.status}`)
  const parentFinalization = parentPackage.finalizations[0]!
  const packageSha256 = sha256(parentBytes)
  const packagePath = `sources/lineage/${packageSha256}.anx` as const
  const parentMode = options.parentMode || 'embedded'
  if (parentMode === 'reference' && !options.parentUri?.trim()) throw new Error('REFERENCE_PARENT_URI_REQUIRED: parentUri is required for reference lineage')
  const lineage: AndocLineage = {
    schema: ANDOC_LINEAGE_SCHEMA,
    documentId: parentPackage.document.documentId,
    derivedRevision: parentPackage.document.revision + 1,
    derivedAt: options.derivedAt,
    actor: options.actor,
    parent: {
      finalizationId: parentFinalization.id,
      documentId: parentFinalization.documentId,
      revision: parentFinalization.revision,
      packageSha256,
      protectedEntryRootSha256: parentFinalization.content.protectedEntryRootSha256,
      ...(parentMode === 'reference'
        ? { mode: 'reference' as const, uri: options.parentUri!.trim() }
        : { mode: 'embedded' as const, packagePath }),
    },
  }
  const transaction = {
    schema: ANDOC_TRANSACTION_SCHEMA,
    id: `derive-${sha256(Buffer.from(canonicalJson({ packageSha256, actor: options.actor, derivedAt: options.derivedAt }))).slice(0, 24)}`,
    baseRevision: parentPackage.document.revision,
    actor: options.actor,
    timestamp: options.derivedAt,
    message: `Derived editable draft from finalized revision ${parentPackage.document.revision}`,
    operations: [{
      op: 'setDocument' as const,
      patch: {
        metadata: {
          ...(options.documentMetadataPatch ? structuredClone(options.documentMetadataPatch) : {}),
          andocLineage: { schema: lineage.schema, parentFinalizationId: parentFinalization.id, parentPackageSha256: packageSha256 },
        },
      },
    }],
  }
  const document = applyTransaction(parentPackage.document, transaction)
  const assets = Object.fromEntries(Object.values(document.assets).map(asset => [asset.id, parentPackage.files[asset.packagePath]!]))
  const sources = Object.fromEntries(Object.entries(parentPackage.files).filter(([entryPath]) => entryPath.startsWith('sources/')
    && entryPath !== ANX_SOURCE_BASELINES_PATH
    && (parentMode === 'embedded' || !entryPath.startsWith('sources/lineage/'))))
  if (parentMode === 'embedded') sources[packagePath] = parentBytes
  const packageBytes = await packAndoc({
    document,
    versionBaseline: parentPackage.versionBaseline || parentPackage.document,
    assets,
    sources,
    transactions: [...parentPackage.transactions, transaction],
    ...(parentPackage.profiles ? { profiles: parentPackage.profiles } : {}),
    lineage,
    finalizations: [],
    ...(parentPackage.sourceBaselines ? { sourceBaselines: parentPackage.sourceBaselines } : {}),
  })
  if (options.outputPath) await writeFile(options.outputPath, packageBytes)
  return { packageBytes, lineage, transactionId: transaction.id, revision: document.revision }
}

export async function verifyAndocLineage(
  input: string | Uint8Array | AndocPackage,
  trustStore?: AndocTrustStore,
  externalParent?: string | Uint8Array,
): Promise<LineageVerification> {
  const pkg = isPackage(input) ? input : await readAndoc(input)
  const base = { documentId: pkg.document.documentId, revision: pkg.document.revision }
  const lineage = pkg.lineage
  if (!lineage) return { status: 'NO_LINEAGE', valid: false, trusted: false, ...base }
  const parentBytes = lineage.parent.mode === 'reference'
    ? externalParent === undefined
      ? undefined
      : typeof externalParent === 'string'
        ? new Uint8Array(await readFile(externalParent))
        : new Uint8Array(externalParent)
    : pkg.files[lineage.parent.packagePath]
  if (!parentBytes) {
    return {
      status: lineage.parent.mode === 'reference' ? 'PARENT_REFERENCE_UNRESOLVED' : 'MISSING_PARENT',
      valid: false,
      trusted: false,
      ...base,
      lineage,
    }
  }
  if (sha256(parentBytes) !== lineage.parent.packageSha256) return { status: 'PARENT_MISMATCH', valid: false, trusted: false, ...base, lineage }
  try {
    const parentPackage = await readAndoc(parentBytes)
    const parentRecord = parentPackage.finalizations[0]
    const referencesMatch = parentPackage.finalizations.length === 1
      && parentRecord?.id === lineage.parent.finalizationId
      && parentRecord.documentId === lineage.parent.documentId
      && parentRecord.revision === lineage.parent.revision
      && parentRecord.content.protectedEntryRootSha256 === lineage.parent.protectedEntryRootSha256
    if (!referencesMatch) return { status: 'PARENT_MISMATCH', valid: false, trusted: false, ...base, lineage }
    const parentVerification = await verifyAndocFinalization(parentPackage, trustStore)
    if (!parentVerification.valid) return { status: 'PARENT_INVALID', valid: false, trusted: false, ...base, lineage, parentVerification }
    return {
      status: parentVerification.trusted ? 'VALID_TRUSTED' : 'VALID_UNTRUSTED',
      valid: true,
      trusted: parentVerification.trusted,
      ...base,
      lineage,
      parentVerification,
    }
  } catch {
    return { status: 'PARENT_INVALID', valid: false, trusted: false, ...base, lineage }
  }
}

export async function cosignAndoc(input: string | Uint8Array, options: CosignAndocOptions): Promise<FinalizationResult> {
  const pkg = await readAndoc(input)
  const record = pkg.finalizations[0]
  if (!record) throw new Error('UNFINALIZED: no finalization record exists to co-sign')
  if (pkg.finalizations.length !== 1) throw new Error('Multiple finalization records are not supported by the v1 co-sign operation')
  if (record.signatures.some(signature => signature.keyId === options.keyId)) throw new Error(`Duplicate finalization key: ${options.keyId}`)
  const verificationBefore = await verifyAndocFinalization(pkg)
  if (!verificationBefore.contentMatches) throw new Error('TAMPERED: protected content does not match the finalization record')
  const next = structuredClone(record)
  next.signatures.push(createSignature(next, options))
  const packageBytes = await repackAndocPackage(pkg, { finalizations: [next] })
  const verification = await verifyAndocFinalization(packageBytes)
  if (options.outputPath) await writeFile(options.outputPath, packageBytes)
  return { packageBytes, finalization: next, verification }
}

export async function attachAndocFinalizationReceipt(
  input: string | Uint8Array,
  receipt: AndocExternalReceipt,
  outputPath?: string,
): Promise<FinalizationResult> {
  const pkg = await readAndoc(input)
  const record = pkg.finalizations[0]
  if (!record || pkg.finalizations.length !== 1) throw new Error('UNFINALIZED: exactly one finalization record is required')
  const verificationBefore = await verifyAndocFinalization(pkg)
  if (!verificationBefore.contentMatches) throw new Error('TAMPERED: protected content does not match the finalization record')
  if (!receipt.provider?.trim() || !receipt.payload?.trim() || !receipt.receivedAt?.trim()) throw new Error('Finalization receipt is incomplete')
  const next = structuredClone(record)
  const receipts = next.receipts || []
  if (receipts.some(item => item.type === receipt.type && item.provider === receipt.provider && item.payload === receipt.payload)) {
    throw new Error('Duplicate finalization receipt')
  }
  next.receipts = [...receipts, structuredClone(receipt)]
  const packageBytes = await repackAndocPackage(pkg, { finalizations: [next] })
  const verification = await verifyAndocFinalization(packageBytes)
  if (outputPath) await writeFile(outputPath, packageBytes)
  return { packageBytes, finalization: next, verification }
}

export async function verifyAndocFinalization(
  input: string | Uint8Array | AndocPackage,
  trustStore?: AndocTrustStore,
  receiptVerifiers: FinalizationReceiptVerifier[] = [],
): Promise<FinalizationVerification> {
  const pkg = isPackage(input) ? input : await readAndoc(input)
  const record = pkg.finalizations[0]
  const emptyPolicy = {
    complete: false,
    requiredSignatures: 0,
    validSignatures: 0,
    trustedSignatures: 0,
    requiredRoles: [] as string[],
    missingRoles: [] as string[],
  }
  if (!record) {
    return {
      status: 'UNFINALIZED',
      valid: false,
      trusted: false,
      sealed: false,
      documentId: pkg.document.documentId,
      revision: pkg.document.revision,
      contentMatches: false,
      signatureResults: [],
      policy: emptyPolicy,
      trustedTime: false,
      receipts: 0,
      receiptResults: [],
    }
  }
  const actualContent = protectedContent(pkg)
  const contentMatches = canonicalJson(actualContent) === canonicalJson(record.content)
  const signatureResults = record.signatures.map(signature => verifySignature(record, signature, trustStore))
  const validSignatures = signatureResults.filter(result => result.cryptographicallyValid)
  const trustedSignatures = validSignatures.filter(result => result.trusted && result.roleAuthorized)
  const requiredRoles = record.policy.requiredRoles || []
  const validRoles = new Set(validSignatures.map(result => result.role))
  const trustedRoles = new Set(trustedSignatures.map(result => result.role))
  const missingRoles = requiredRoles.filter(role => !validRoles.has(role))
  const missingTrustedRoles = requiredRoles.filter(role => !trustedRoles.has(role))
  const policyComplete = validSignatures.length >= record.policy.requiredSignatures && missingRoles.length === 0
  const trustedPolicyComplete = Boolean(trustStore) && trustedSignatures.length >= record.policy.requiredSignatures && missingTrustedRoles.length === 0
  const signatureTampered = signatureResults.some(result => !result.cryptographicallyValid)
  const status = !contentMatches || signatureTampered ? 'TAMPERED'
    : !policyComplete ? 'POLICY_INCOMPLETE'
      : trustedPolicyComplete ? 'VALID_TRUSTED'
        : 'VALID_UNTRUSTED_SIGNER'
  const receiptResults = (record.receipts || []).map(receipt => {
    const verifier = receiptVerifiers.find(candidate => candidate.type === receipt.type && candidate.provider === receipt.provider)
    let valid = false
    try {
      valid = Boolean(verifier?.verify(record, receipt))
    } catch {
      valid = false
    }
    return {
      type: receipt.type,
      provider: receipt.provider,
      receivedAt: receipt.receivedAt,
      valid,
      trustedTime: valid && verifier?.trustedTime === true,
    }
  })
  return {
    status,
    valid: contentMatches && !signatureTampered && policyComplete,
    trusted: status === 'VALID_TRUSTED',
    sealed: true,
    documentId: pkg.document.documentId,
    revision: pkg.document.revision,
    finalizationId: record.id,
    contentMatches,
    signatureResults,
    policy: {
      id: record.policy.id,
      complete: policyComplete,
      requiredSignatures: record.policy.requiredSignatures,
      validSignatures: validSignatures.length,
      trustedSignatures: trustedSignatures.length,
      requiredRoles,
      missingRoles,
    },
    // Receipt presence alone is never proof of trusted time. A configured,
    // provider-specific verifier must validate the receipt against this record.
    trustedTime: receiptResults.some(result => result.trustedTime),
    receipts: record.receipts?.length || 0,
    receiptResults,
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
  }
}

export function protectedContent(pkg: AndocPackage): AndocProtectedContent {
  const entries = pkg.manifest.entries
    .filter(entry => protectedRoles.has(entry.role))
    .map(entry => ({ path: entry.path, mediaType: entry.mediaType, sha256: entry.sha256, size: entry.size, role: entry.role }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  const document = byPath.get('document.json')
  const history = byPath.get('revisions/transactions.jsonl')
  const view = byPath.get('views/document.html')
  if (!document || !history || !view) throw new Error('Protected content is missing a canonical document, history, or human view')
  const profile = byPath.get(ANDOC_PROFILE_PATH)
  return {
    hashAlgorithm: 'SHA-256',
    canonicalDocumentSha256: document.sha256,
    transactionHistorySha256: history.sha256,
    humanViewSha256: view.sha256,
    ...(profile ? { profileDeclarationSha256: profile.sha256 } : {}),
    protectedEntryRootSha256: sha256(Buffer.from(canonicalJson(entries))),
    protectedEntryCount: entries.length,
  }
}

function createSignature(
  record: AndocFinalization,
  options: Pick<FinalizeAndocOptions, 'privateKeyPem' | 'keyId' | 'role'> & Partial<Pick<FinalizeAndocOptions, 'createdAt'>> & Partial<Pick<CosignAndocOptions, 'signedAt'>>,
): AndocFinalizationSignature {
  const privateKey = createPrivateKey(typeof options.privateKeyPem === 'string' ? options.privateKeyPem : Buffer.from(options.privateKeyPem))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`ANX finalization requires an Ed25519 private key, found ${privateKey.asymmetricKeyType || 'unknown'}`)
  const publicKey = createPublicKey(privateKey)
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' })
  const publicKeySpki = publicKeyDer.toString('base64')
  const publicKeySha256 = sha256(publicKeyDer)
  const signedAt = options.signedAt || options.createdAt
  if (!signedAt) throw new Error('A signing timestamp is required')
  const signer = { algorithm: 'Ed25519' as const, keyId: options.keyId, role: options.role, signedAt, publicKeySha256 }
  const value = sign(null, Buffer.from(signaturePayload(record, signer)), privateKey).toString('base64')
  return { ...signer, publicKeySpki, value }
}

function verifySignature(record: AndocFinalization, signature: AndocFinalizationSignature, trustStore?: AndocTrustStore): SignatureVerification {
  let cryptographicallyValid = false
  try {
    const publicKeyDer = Buffer.from(signature.publicKeySpki, 'base64')
    const digestMatches = sha256(publicKeyDer) === signature.publicKeySha256
    const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
    cryptographicallyValid = digestMatches && publicKey.asymmetricKeyType === 'ed25519' && verify(
      null,
      Buffer.from(signaturePayload(record, signature)),
      publicKey,
      Buffer.from(signature.value, 'base64'),
    )
  } catch {
    cryptographicallyValid = false
  }
  const trustedKey = trustStore?.keys.find(key => key.keyId === signature.keyId && key.publicKeySha256 === signature.publicKeySha256)
  const roleAuthorized = Boolean(trustedKey && (!trustedKey.roles?.length || trustedKey.roles.includes(signature.role)))
  return {
    keyId: signature.keyId,
    role: signature.role,
    cryptographicallyValid,
    trusted: Boolean(trustedKey),
    roleAuthorized,
    publicKeySha256: signature.publicKeySha256,
  }
}

function signaturePayload(
  record: AndocFinalization,
  signer: Pick<AndocFinalizationSignature, 'algorithm' | 'keyId' | 'role' | 'signedAt' | 'publicKeySha256'>,
): string {
  const { signatures: _signatures, receipts: _receipts, ...finalization } = record
  return canonicalJson({ finalization, signer: {
    algorithm: signer.algorithm,
    keyId: signer.keyId,
    role: signer.role,
    signedAt: signer.signedAt,
    publicKeySha256: signer.publicKeySha256,
  } })
}

function supersedesReference(lineage: AndocLineage): NonNullable<AndocFinalization['supersedes']> {
  return {
    finalizationId: lineage.parent.finalizationId,
    documentId: lineage.parent.documentId,
    revision: lineage.parent.revision,
    packageSha256: lineage.parent.packageSha256,
    protectedEntryRootSha256: lineage.parent.protectedEntryRootSha256,
  }
}

function isPackage(value: unknown): value is AndocPackage {
  return Boolean(value && typeof value === 'object' && 'manifest' in value && 'document' in value && 'files' in value)
}
