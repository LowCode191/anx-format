export const ANX_MEDIA_TYPE = 'application/anx+zip' as const
export const LEGACY_AGN_MEDIA_TYPE = 'application/agn+zip' as const
export const LEGACY_ANDOC_MEDIA_TYPE = 'application/vnd.andoc+zip' as const
/** @deprecated Use ANX_MEDIA_TYPE. Retained for readers of the former AGN identity. */
export const AGN_MEDIA_TYPE = LEGACY_AGN_MEDIA_TYPE
/** @deprecated Use ANX_MEDIA_TYPE. Retained for readers of the original ANDoc identity. */
export const ANDOC_MEDIA_TYPE = LEGACY_ANDOC_MEDIA_TYPE

// The 0.1 schema tokens remain stable through the extension migration so existing
// transactions, profiles, signatures, and historical evidence remain verifiable.
export const ANDOC_DOCUMENT_SCHEMA = 'andoc.document.v1' as const
export const ANDOC_MANIFEST_SCHEMA = 'andoc.manifest.v1' as const
export const ANDOC_TRANSACTION_SCHEMA = 'andoc.transaction.v1' as const
export const ANDOC_PROFILES_SCHEMA = 'andoc.profiles.v1' as const
export const ANDOC_FINALIZATION_SCHEMA = 'andoc.finalization.v1' as const
export const ANDOC_TRUST_STORE_SCHEMA = 'andoc.trust-store.v1' as const
export const ANDOC_LINEAGE_SCHEMA = 'andoc.lineage.v1' as const
export const ANX_SOURCE_BASELINES_SCHEMA = 'anx.source-baselines.v1' as const
export const ANX_SOURCE_BASELINE_SCHEMA = 'anx.source-baseline.v1' as const

export type TextMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'subscript' | 'superscript'

export interface TextRun {
  text: string
  marks?: TextMark[]
  href?: string
}

export interface Provenance {
  kind: 'imported' | 'human' | 'agent' | 'generated'
  sourceId?: string
  sourceUri?: string
  page?: number
  bbox?: [number, number, number, number]
  capturedAt?: string
  confidence?: number
}

interface BaseBlock {
  id: string
  provenance?: Provenance
  attrs?: Record<string, unknown>
}

export interface ParagraphBlock extends BaseBlock {
  type: 'paragraph'
  content: TextRun[]
}

export interface HeadingBlock extends BaseBlock {
  type: 'heading'
  level: 1 | 2 | 3 | 4 | 5 | 6
  content: TextRun[]
}

export interface ListItem {
  id: string
  content: TextRun[]
  children?: ListItem[]
  provenance?: Provenance
  attrs?: Record<string, unknown>
}

export interface ListBlock extends BaseBlock {
  type: 'list'
  ordered: boolean
  start?: number
  items: ListItem[]
}

export interface FootnoteBlock extends BaseBlock {
  type: 'footnote'
  label: string
  content: TextRun[]
  noteKind?: 'footnote' | 'endnote'
  anchorIds?: string[]
  anchorStatus?: 'resolved' | 'uncertain' | 'unanchored'
}

export interface ExtensionBlock extends BaseBlock {
  type: 'extension'
  extensionId: string
  version: string
  payload: Record<string, unknown>
  fallback: TextRun[]
}

export interface ImageBlock extends BaseBlock {
  type: 'image'
  assetId: string
  alt: string
  caption?: TextRun[]
}

export interface TableCell {
  id: string
  content: TextRun[]
  header?: boolean
  colspan?: number
  rowspan?: number
  provenance?: Provenance
  attrs?: Record<string, unknown>
}

export interface TableBlock extends BaseBlock {
  type: 'table'
  rows: TableCell[][]
  caption?: TextRun[]
}

export interface ChartBlock extends BaseBlock {
  type: 'chart'
  alt: string
  spec: Record<string, unknown>
  dataAssetId?: string
  fallbackAssetId?: string
  caption?: TextRun[]
}

export type ChartDataScalar = string | number | null

export interface StructuredChartData {
  columns: string[]
  rows: ChartDataScalar[][]
}

export interface ChartDataEvidence {
  method: 'imported' | 'human-provided' | 'agent-provided' | 'local-extraction'
  source: string
  verified: boolean
  confidence?: number
  notes?: string
}

export interface PageBreakBlock extends BaseBlock {
  type: 'pageBreak'
}

export type AndocBlock = ParagraphBlock | HeadingBlock | ListBlock | FootnoteBlock | ExtensionBlock | ImageBlock | TableBlock | ChartBlock | PageBreakBlock

export interface AndocAsset {
  id: string
  packagePath: `assets/${string}`
  mediaType: string
  sha256: string
  size: number
  originalName?: string
  description?: string
}

export interface AndocDocument {
  schema: typeof ANDOC_DOCUMENT_SCHEMA
  documentId: string
  revision: number
  title: string
  locale: string
  createdAt: string
  updatedAt: string
  metadata: Record<string, unknown>
  assets: Record<string, AndocAsset>
  blocks: AndocBlock[]
}

export interface ManifestEntry {
  path: string
  mediaType: string
  sha256: string
  size: number
  role: 'canonical' | 'history' | 'human-view' | 'asset' | 'source' | 'profile' | 'extension' | 'lineage' | 'finalization' | 'signature' | 'receipt'
}

export interface AndocManifest {
  schema: typeof ANDOC_MANIFEST_SCHEMA
  formatVersion: '1.0' | '1.1'
  mediaType: typeof ANX_MEDIA_TYPE | typeof LEGACY_AGN_MEDIA_TYPE | typeof LEGACY_ANDOC_MEDIA_TYPE
  document: 'document.json'
  revision: number
  entries: ManifestEntry[]
}

export interface AndocActor {
  type: 'human' | 'agent' | 'import' | 'system'
  id: string
}

export interface AndocCapabilityReference {
  id: string
  version: string
  required: boolean
}

export interface AndocTemplateReference {
  id: string
  version: string
}

export interface AndocProfiles {
  schema: typeof ANDOC_PROFILES_SCHEMA
  core: AndocCapabilityReference
  profiles: AndocCapabilityReference[]
  extensions: AndocCapabilityReference[]
  template?: AndocTemplateReference
}

export interface AndocProtectedContent {
  hashAlgorithm: 'SHA-256'
  canonicalDocumentSha256: string
  transactionHistorySha256: string
  humanViewSha256: string
  profileDeclarationSha256?: string
  protectedEntryRootSha256: string
  protectedEntryCount: number
}

export interface AndocFinalizationPolicy {
  id: string
  requiredSignatures: number
  requiredRoles?: string[]
}

export interface AndocSupersedesReference {
  finalizationId: string
  documentId: string
  revision: number
  packageSha256: string
  protectedEntryRootSha256: string
}

export interface AndocLineage {
  schema: typeof ANDOC_LINEAGE_SCHEMA
  documentId: string
  derivedRevision: number
  derivedAt: string
  actor: AndocActor
  parent: AndocSupersedesReference & (
    | {
        mode?: 'embedded'
        packagePath: `sources/lineage/${string}.anx` | `sources/lineage/${string}.anxd` | `sources/lineage/${string}.agn` | `sources/lineage/${string}.andoc`
      }
    | {
        mode: 'reference'
        uri: string
      }
  )
}

export interface AndocFinalizationSignature {
  algorithm: 'Ed25519'
  keyId: string
  role: string
  signedAt: string
  publicKeySpki: string
  publicKeySha256: string
  value: string
}

export interface AndocExternalReceipt {
  type: 'rfc3161' | 'transparency-log' | 'blockchain-anchor' | 'signed-time-attestation' | 'agent-attestation'
  provider: string
  payload: string
  receivedAt: string
}

export interface AndocFinalization {
  schema: typeof ANDOC_FINALIZATION_SCHEMA
  id: string
  documentId: string
  revision: number
  createdAt: string
  actor: AndocActor
  content: AndocProtectedContent
  policy: AndocFinalizationPolicy
  supersedes?: AndocSupersedesReference
  signatures: AndocFinalizationSignature[]
  receipts?: AndocExternalReceipt[]
}

export interface AndocTrustedKey {
  keyId: string
  publicKeySha256: string
  roles?: string[]
}

export interface AndocTrustStore {
  schema: typeof ANDOC_TRUST_STORE_SCHEMA
  keys: AndocTrustedKey[]
}

export type AnxSourceAcquisitionMethod = 'purchase' | 'download' | 'received' | 'scanned' | 'other'

export interface AnxSourceBaselineSignature {
  algorithm: 'Ed25519'
  keyId: string
  role: 'source-baseline-registrar'
  signedAt: string
  publicKeySpki: string
  publicKeySha256: string
  value: string
}

export interface AnxSourceBaseline {
  schema: typeof ANX_SOURCE_BASELINE_SCHEMA
  id: string
  designation: 'organization-baseline'
  documentId: string
  documentRevisionAtRegistration: number
  source: {
    path: string
    fileName: string
    mediaType: string
    sha256: string
    size: number
  }
  registeredAt: string
  registeredBy: AndocActor & { type: 'human' }
  organization?: string
  description: {
    title: string
    publisher?: string
    edition?: string
  }
  acquisition: {
    method: AnxSourceAcquisitionMethod
    acquiredAt?: string
    sourceUri?: string
    supplier?: string
    orderReference?: string
  }
  supersedes?: {
    documentId: string
    baselineId: string
    sourceSha256: string
  }
  issuerVerification: {
    status: 'not-established'
  }
  rights: {
    redistribution: 'not-established'
  }
  statement: "Accepted as the organization's controlled source baseline; issuer authenticity is not independently verified."
  signature: AnxSourceBaselineSignature
}

export interface AnxSourceBaselines {
  schema: typeof ANX_SOURCE_BASELINES_SCHEMA
  activeBaselineId: string
  records: AnxSourceBaseline[]
}

export interface TextCandidateRef {
  kind: 'ocr' | 'agent-vision'
  candidateSha256: string
  engine: string
  engineVersion: string
  page: number
  policyId?: string
  policySha256?: string
  modelHashes?: string[]
  meanConfidence?: number
  normalizedSimilarity?: number
  recommendation?: string
}

export type AndocOperation =
  | { op: 'addAsset'; asset: AndocAsset }
  | { op: 'insertBlocks'; afterId: string | null; blocks: AndocBlock[] }
  | { op: 'moveBlock'; targetId: string; afterId: string | null }
  | { op: 'replaceBlock'; targetId: string; block: AndocBlock }
  | { op: 'removeBlock'; targetId: string }
  | { op: 'updateTextBlock'; targetId: string; content: TextRun[]; level?: HeadingBlock['level'] }
  | { op: 'applyTextCandidate'; targetId: string; expectedCurrentText: string; content: TextRun[]; reason: string; candidate: TextCandidateRef }
  | { op: 'updateTableCell'; tableId: string; cellId: string; content: TextRun[] }
  | { op: 'insertTableRow'; tableId: string; afterRowIndex: number | null; cells: TableCell[] }
  | { op: 'removeTableRow'; tableId: string; rowIndex: number }
  | { op: 'insertTableColumn'; tableId: string; afterColumnIndex: number | null; cells: TableCell[] }
  | { op: 'removeTableColumn'; tableId: string; columnIndex: number }
  | { op: 'updateMediaMetadata'; targetId: string; patch: { alt?: string; caption?: TextRun[] } }
  | { op: 'updateChartData'; targetId: string; data: StructuredChartData; evidence: ChartDataEvidence }
  | { op: 'setDocument'; patch: { title?: string; locale?: string; metadata?: Record<string, unknown> } }
  | { op: 'replaceDocumentMetadata'; metadata: Record<string, unknown> }

export interface AndocTransaction {
  schema: typeof ANDOC_TRANSACTION_SCHEMA
  id: string
  baseRevision: number
  actor: AndocActor
  timestamp: string
  message?: string
  operations: AndocOperation[]
}

// Canonical ANX public type names. The Agn* and Andoc* exports remain available
// as compatibility aliases through the pre-1.0 transition.
export type AnxBlock = AndocBlock
export type AnxAsset = AndocAsset
export type AnxDocument = AndocDocument
export type AnxManifest = AndocManifest
export type AnxActor = AndocActor
export type AnxCapabilityReference = AndocCapabilityReference
export type AnxTemplateReference = AndocTemplateReference
export type AnxProfiles = AndocProfiles
export type AnxProtectedContent = AndocProtectedContent
export type AnxFinalizationPolicy = AndocFinalizationPolicy
export type AnxSupersedesReference = AndocSupersedesReference
export type AnxLineage = AndocLineage
export type AnxFinalizationSignature = AndocFinalizationSignature
export type AnxExternalReceipt = AndocExternalReceipt
export type AnxFinalization = AndocFinalization
export type AnxTrustedKey = AndocTrustedKey
export type AnxTrustStore = AndocTrustStore
export type AnxSourceBaselineRecord = AnxSourceBaseline
export type AnxSourceBaselineRegistry = AnxSourceBaselines
export type AnxOperation = AndocOperation
export type AnxTransaction = AndocTransaction

export type AgnBlock = AndocBlock
export type AgnAsset = AndocAsset
export type AgnDocument = AndocDocument
export type AgnManifest = AndocManifest
export type AgnActor = AndocActor
export type AgnCapabilityReference = AndocCapabilityReference
export type AgnTemplateReference = AndocTemplateReference
export type AgnProfiles = AndocProfiles
export type AgnProtectedContent = AndocProtectedContent
export type AgnFinalizationPolicy = AndocFinalizationPolicy
export type AgnSupersedesReference = AndocSupersedesReference
export type AgnLineage = AndocLineage
export type AgnFinalizationSignature = AndocFinalizationSignature
export type AgnExternalReceipt = AndocExternalReceipt
export type AgnFinalization = AndocFinalization
export type AgnTrustedKey = AndocTrustedKey
export type AgnTrustStore = AndocTrustStore
export type AgnOperation = AndocOperation
export type AgnTransaction = AndocTransaction

export interface ValidationIssue {
  code: string
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
  document?: AndocDocument
  versionBaseline?: AndocDocument
  manifest?: AndocManifest
  profiles?: AndocProfiles
  lineage?: AndocLineage
  finalizations?: AndocFinalization[]
  sourceBaselines?: AnxSourceBaselines
}
