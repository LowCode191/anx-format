export const ANX_AGENT_RESPONSE_SCHEMA = 'anx.agent-response.v1' as const
export const ANX_AGENT_RESPONSE_EVIDENCE_SCHEMA = 'anx.agent-response-evidence.v1' as const
export const ANX_AGENT_MODEL_RESPONSE_SCHEMA = 'anx.agent-model-response.v1' as const
export const ANX_AGENT_MODEL_RESPONSE_V2_SCHEMA = 'anx.agent-model-response.v2' as const

export type AnxAgentRepresentation = 'anx-native' | 'source-text' | 'source-image' | 'unknown'
export type AnxAgentSourceBaselineStatus =
  | 'UNVERIFIED_SOURCE'
  | 'TAMPERED'
  | 'REGISTERED_UNTRUSTED_SIGNER'
  | 'REGISTERED_TRUSTED'
  | 'UNAVAILABLE'
  | 'UNKNOWN'
export type AnxAgentSourceRepresentation =
  | 'text-and-vector'
  | 'image-based'
  | 'image-based-with-structured-extraction'
  | 'vector-rules'
  | 'mixed'
  | 'native-text'
  | 'source-text'
  | 'source-image'
  | 'unknown'
  | 'unavailable'
  | 'not-applicable'
export type AnxAgentDataState =
  | 'structured-verified'
  | 'structured-unverified'
  | 'visual-only'
  | 'candidate-only'
  | 'unstructured'
  | 'canonical-text'
  | 'image-only'
  | 'unknown'
  | 'unavailable'
  | 'not-applicable'
export type AnxAgentTextQuality =
  | 'native-clean'
  | 'native-suspect'
  | 'ocr'
  | 'derived'
  | 'unverified'
  | 'unavailable'
  | 'not-applicable'
export type AnxAgentEvidenceStatus =
  | 'observed'
  | 'candidate'
  | 'verified'
  | 'abstained'
  | 'unavailable'
  | 'unknown'
export type AnxAgentUnattendedUse =
  | 'allowed'
  | 'review-required'
  | 'abstain'
  | 'unavailable'
  | 'unknown'
export type AnxAgentAnchorStatus =
  | 'resolved'
  | 'unresolved'
  | 'unanchored'
  | 'unavailable'
  | 'unknown'
  | 'not-applicable'

export interface AnxAgentEvidenceDimensions {
  rowCount: number | null
  columnCount: number | null
  disclosure: 'complete' | 'partial' | 'unavailable' | 'not-applicable'
}

export interface AnxAgentResponseEvidenceItem {
  role: 'primary' | 'supporting'
  evidenceId: string
  citation: string
  semanticType: string
  sourceRepresentation: AnxAgentSourceRepresentation
  dataState: AnxAgentDataState
  textQuality: AnxAgentTextQuality
  evidenceStatus: AnxAgentEvidenceStatus
  unattendedUse: AnxAgentUnattendedUse
  safeForUnattendedAcceptance: boolean | null
  reviewRequired: boolean | null
  dimensions: AnxAgentEvidenceDimensions | null
  anchorStatus: AnxAgentAnchorStatus
}

export interface AnxAgentResponseEvidence {
  schema: typeof ANX_AGENT_RESPONSE_EVIDENCE_SCHEMA
  representation: AnxAgentRepresentation
  sourceBaseline: {
    status: AnxAgentSourceBaselineStatus
    trusted: boolean | null
    issuerVerified: boolean | null
  }
  canonicalContentChangedAutomatically: boolean | null
  items: AnxAgentResponseEvidenceItem[]
}

export interface AnxAgentResponseTask {
  id: string
  answer: string
  citations: string[]
  evidenceJudgment: string
  evidence: AnxAgentResponseEvidence
}

export interface AnxAgentResponse {
  schema: typeof ANX_AGENT_RESPONSE_SCHEMA
  documentId: string
  task: AnxAgentResponseTask
  limitations: string[]
}

export interface AnxAgentModelResponseTask {
  id: string
  answer: string
  citations: string[]
  evidenceJudgment: string
}

export interface AnxAgentModelResponse {
  schema: typeof ANX_AGENT_MODEL_RESPONSE_SCHEMA
  documentId: string
  task: AnxAgentModelResponseTask
  limitations: string[]
}

export interface AnxAgentModelResponseV2Task {
  id: string
  answer: string
  evidenceJudgment: string
}

export interface AnxAgentModelResponseV2 {
  schema: typeof ANX_AGENT_MODEL_RESPONSE_V2_SCHEMA
  documentId: string
  task: AnxAgentModelResponseV2Task
  limitations: string[]
}

export interface AnxAgentModelResponseNormalizationAudit {
  strategy: 'deterministic-host-v1'
  documentIdentityRebound: boolean
  taskIdentityRebound: boolean
  technicalCitationsRemoved: number
  humanFieldsChanged: number
}

export interface NormalizedAnxAgentModelResponse {
  response: unknown
  audit: AnxAgentModelResponseNormalizationAudit
}

export type AnxAgentProviderResponse = AnxAgentModelResponse | AnxAgentModelResponseV2

export interface AnxAgentModelResponseValidation {
  valid: boolean
  errors: string[]
  citations: number
}

export interface AnxAgentResponseValidation {
  valid: boolean
  errors: string[]
  evidenceItems: number
  reviewRequiredItems: number
  unresolvedEvidenceItems: number
}

export interface AnxAgentEvidenceBindingValidation {
  valid: boolean
  errors: string[]
  expectedItems: number
  matchedItems: number
}

export type AnxAgentResponseSchemaProvider = 'codex' | 'claude'

const representations = new Set<AnxAgentRepresentation>(['anx-native', 'source-text', 'source-image', 'unknown'])
const baselineStatuses = new Set<AnxAgentSourceBaselineStatus>([
  'UNVERIFIED_SOURCE',
  'TAMPERED',
  'REGISTERED_UNTRUSTED_SIGNER',
  'REGISTERED_TRUSTED',
  'UNAVAILABLE',
  'UNKNOWN',
])
const sourceRepresentations = new Set<AnxAgentSourceRepresentation>([
  'text-and-vector',
  'image-based',
  'image-based-with-structured-extraction',
  'vector-rules',
  'mixed',
  'native-text',
  'source-text',
  'source-image',
  'unknown',
  'unavailable',
  'not-applicable',
])
const dataStates = new Set<AnxAgentDataState>([
  'structured-verified',
  'structured-unverified',
  'visual-only',
  'candidate-only',
  'unstructured',
  'canonical-text',
  'image-only',
  'unknown',
  'unavailable',
  'not-applicable',
])
const textQualities = new Set<AnxAgentTextQuality>([
  'native-clean',
  'native-suspect',
  'ocr',
  'derived',
  'unverified',
  'unavailable',
  'not-applicable',
])
const evidenceStatuses = new Set<AnxAgentEvidenceStatus>([
  'observed',
  'candidate',
  'verified',
  'abstained',
  'unavailable',
  'unknown',
])
const unattendedUses = new Set<AnxAgentUnattendedUse>([
  'allowed',
  'review-required',
  'abstain',
  'unavailable',
  'unknown',
])
const anchorStatuses = new Set<AnxAgentAnchorStatus>([
  'resolved',
  'unresolved',
  'unanchored',
  'unavailable',
  'unknown',
  'not-applicable',
])
const dimensionDisclosures = new Set<AnxAgentEvidenceDimensions['disclosure']>([
  'complete',
  'partial',
  'unavailable',
  'not-applicable',
])

export function validateAnxAgentResponse(
  value: unknown,
  options: {
    expectedDocumentId?: string
    expectedTaskId?: string
    expectedRevision?: number
  } = {},
): AnxAgentResponseValidation {
  const errors: string[] = []
  if (!record(value)) return failure(['response must be an object'])
  if (value.schema !== ANX_AGENT_RESPONSE_SCHEMA) errors.push(`schema must be ${ANX_AGENT_RESPONSE_SCHEMA}`)
  if (!nonEmpty(value.documentId)) errors.push('documentId must be a non-empty string')
  if (options.expectedDocumentId && value.documentId !== options.expectedDocumentId) {
    errors.push(`documentId must match ${options.expectedDocumentId}`)
  }
  if (!record(value.task)) return failure([...errors, 'task must be an object'])
  const task = value.task
  if (!nonEmpty(task.id)) errors.push('task.id must be a non-empty string')
  if (options.expectedTaskId && task.id !== options.expectedTaskId) {
    errors.push(`task.id must match ${options.expectedTaskId}`)
  }
  if (!nonEmpty(task.answer)) errors.push('task.answer must be a non-empty string')
  if (!nonEmpty(task.evidenceJudgment)) errors.push('task.evidenceJudgment must be a non-empty string')
  if (!Array.isArray(task.citations) || !task.citations.length || !task.citations.every(nonEmpty)) {
    errors.push('task.citations must contain at least one non-empty citation')
  }
  const citations = Array.isArray(task.citations)
    ? task.citations.filter(nonEmpty)
    : []
  if (new Set(citations).size !== citations.length) errors.push('task.citations must not contain duplicates')
  if (!Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === 'string')) {
    errors.push('limitations must be an array of strings')
  }
  if (!record(task.evidence)) return failure([...errors, 'task.evidence must be an object'])
  const evidence = task.evidence
  if (evidence.schema !== ANX_AGENT_RESPONSE_EVIDENCE_SCHEMA) {
    errors.push(`task.evidence.schema must be ${ANX_AGENT_RESPONSE_EVIDENCE_SCHEMA}`)
  }
  if (!representations.has(evidence.representation as AnxAgentRepresentation)) {
    errors.push('task.evidence.representation is invalid')
  }
  validateSourceBaseline(evidence.sourceBaseline, errors)
  if (typeof evidence.canonicalContentChangedAutomatically !== 'boolean' && evidence.canonicalContentChangedAutomatically !== null) {
    errors.push('task.evidence.canonicalContentChangedAutomatically must be boolean or null')
  }
  if (!Array.isArray(evidence.items) || !evidence.items.length) {
    errors.push('task.evidence.items must contain at least one item')
    return failure(errors)
  }
  let reviewRequiredItems = 0
  let unresolvedEvidenceItems = 0
  let primaryItems = 0
  const evidenceCitations: string[] = []
  const evidenceIds: string[] = []
  for (const [index, item] of evidence.items.entries()) {
    if (!record(item)) {
      errors.push(`task.evidence.items[${index}] must be an object`)
      continue
    }
    const prefix = `task.evidence.items[${index}]`
    if (item.role !== 'primary' && item.role !== 'supporting') errors.push(`${prefix}.role is invalid`)
    if (item.role === 'primary') primaryItems += 1
    if (!nonEmpty(item.evidenceId)) errors.push(`${prefix}.evidenceId must be a non-empty string`)
    else evidenceIds.push(item.evidenceId)
    if (!nonEmpty(item.citation)) errors.push(`${prefix}.citation must be a non-empty string`)
    else evidenceCitations.push(item.citation)
    if (nonEmpty(item.citation) && !citations.includes(item.citation)) errors.push(`${prefix}.citation is not listed in task.citations`)
    if (
      nonEmpty(item.citation)
      && nonEmpty(item.evidenceId)
      && !citationEndsWithEvidenceId(item.citation, item.evidenceId)
    ) {
      errors.push(`${prefix}.evidenceId does not match its citation`)
    }
    if (
      nonEmpty(item.citation)
      && options.expectedRevision !== undefined
      && item.citation.startsWith('anx://')
      && !item.citation.includes(`/revisions/${options.expectedRevision}/`)
    ) {
      errors.push(`${prefix}.citation is not pinned to revision ${options.expectedRevision}`)
    }
    if (!nonEmpty(item.semanticType)) errors.push(`${prefix}.semanticType must be a non-empty string`)
    if (!sourceRepresentations.has(item.sourceRepresentation as AnxAgentSourceRepresentation)) errors.push(`${prefix}.sourceRepresentation is invalid`)
    if (!dataStates.has(item.dataState as AnxAgentDataState)) errors.push(`${prefix}.dataState is invalid`)
    if (!textQualities.has(item.textQuality as AnxAgentTextQuality)) errors.push(`${prefix}.textQuality is invalid`)
    if (!evidenceStatuses.has(item.evidenceStatus as AnxAgentEvidenceStatus)) errors.push(`${prefix}.evidenceStatus is invalid`)
    if (!unattendedUses.has(item.unattendedUse as AnxAgentUnattendedUse)) errors.push(`${prefix}.unattendedUse is invalid`)
    if (typeof item.safeForUnattendedAcceptance !== 'boolean' && item.safeForUnattendedAcceptance !== null) {
      errors.push(`${prefix}.safeForUnattendedAcceptance must be boolean or null`)
    }
    if (typeof item.reviewRequired !== 'boolean' && item.reviewRequired !== null) {
      errors.push(`${prefix}.reviewRequired must be boolean or null`)
    }
    if (!anchorStatuses.has(item.anchorStatus as AnxAgentAnchorStatus)) errors.push(`${prefix}.anchorStatus is invalid`)
    validateDimensions(item.dimensions, prefix, errors)
    if (item.reviewRequired === true || item.unattendedUse === 'review-required') reviewRequiredItems += 1
    if (item.evidenceStatus === 'unknown' || item.evidenceStatus === 'unavailable') unresolvedEvidenceItems += 1
    if (
      item.unattendedUse === 'allowed'
      && (item.safeForUnattendedAcceptance !== true || item.reviewRequired !== false)
    ) {
      errors.push(`${prefix} has contradictory allowed/review flags`)
    }
    if (
      (item.unattendedUse === 'review-required' || item.unattendedUse === 'abstain')
      && item.safeForUnattendedAcceptance !== false
    ) {
      errors.push(`${prefix} cannot be unattended-safe`)
    }
  }
  if (primaryItems < 1) errors.push('task.evidence.items must contain a primary item')
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    errors.push('task.evidence.items must not contain duplicate evidenceId values')
  }
  if (new Set(evidenceCitations).size !== evidenceCitations.length) {
    errors.push('task.evidence.items must not contain duplicate citation values')
  }
  for (const citation of citations) {
    if (!evidenceCitations.includes(citation)) {
      errors.push(`task.citations entry has no machine evidence item: ${citation}`)
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    evidenceItems: evidence.items.length,
    reviewRequiredItems,
    unresolvedEvidenceItems,
  }
}

export function validateAnxAgentModelResponse(
  value: unknown,
  options: {
    expectedDocumentId?: string
    expectedTaskId?: string
    expectedRevision?: number
  } = {},
): AnxAgentModelResponseValidation {
  const errors: string[] = []
  if (!record(value)) return modelFailure(['response must be an object'])
  rejectUnexpectedKeys(value, ['schema', 'documentId', 'task', 'limitations'], 'response', errors)
  if (value.schema !== ANX_AGENT_MODEL_RESPONSE_SCHEMA) {
    errors.push(`schema must be ${ANX_AGENT_MODEL_RESPONSE_SCHEMA}`)
  }
  if (!nonEmpty(value.documentId)) errors.push('documentId must be a non-empty string')
  if (options.expectedDocumentId && value.documentId !== options.expectedDocumentId) {
    errors.push(`documentId must match ${options.expectedDocumentId}`)
  }
  if (!record(value.task)) return modelFailure([...errors, 'task must be an object'])
  const task = value.task
  rejectUnexpectedKeys(task, ['id', 'answer', 'citations', 'evidenceJudgment'], 'task', errors)
  if (!nonEmpty(task.id)) errors.push('task.id must be a non-empty string')
  if (options.expectedTaskId && task.id !== options.expectedTaskId) {
    errors.push(`task.id must match ${options.expectedTaskId}`)
  }
  if (!nonEmpty(task.answer)) errors.push('task.answer must be a non-empty string')
  if (!nonEmpty(task.evidenceJudgment)) {
    errors.push('task.evidenceJudgment must be a non-empty string')
  }
  if (!Array.isArray(task.citations) || !task.citations.length || !task.citations.every(nonEmpty)) {
    errors.push('task.citations must contain at least one non-empty citation')
  }
  const citations = Array.isArray(task.citations)
    ? task.citations.filter(nonEmpty)
    : []
  if (new Set(citations).size !== citations.length) {
    errors.push('task.citations must not contain duplicates')
  }
  if (options.expectedRevision !== undefined) {
    for (const citation of citations) {
      if (
        citation.startsWith('anx://')
        && !citation.includes(`/revisions/${options.expectedRevision}/`)
      ) {
        errors.push(`task.citations entry is not pinned to revision ${options.expectedRevision}: ${citation}`)
      }
    }
  }
  if (!Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === 'string')) {
    errors.push('limitations must be an array of strings')
  }
  return {
    valid: errors.length === 0,
    errors,
    citations: citations.length,
  }
}

export function validateAnxAgentModelResponseV2(
  value: unknown,
  options: {
    expectedDocumentId?: string
    expectedTaskId?: string
  } = {},
): AnxAgentModelResponseValidation {
  const errors: string[] = []
  if (!record(value)) return modelFailure(['response must be an object'])
  rejectUnexpectedKeys(value, ['schema', 'documentId', 'task', 'limitations'], 'response', errors)
  if (value.schema !== ANX_AGENT_MODEL_RESPONSE_V2_SCHEMA) {
    errors.push(`schema must be ${ANX_AGENT_MODEL_RESPONSE_V2_SCHEMA}`)
  }
  if (!nonEmpty(value.documentId)) errors.push('documentId must be a non-empty string')
  if (options.expectedDocumentId && value.documentId !== options.expectedDocumentId) {
    errors.push(`documentId must match ${options.expectedDocumentId}`)
  }
  if (!record(value.task)) return modelFailure([...errors, 'task must be an object'])
  const task = value.task
  rejectUnexpectedKeys(task, ['id', 'answer', 'evidenceJudgment'], 'task', errors)
  if (!nonEmpty(task.id)) errors.push('task.id must be a non-empty string')
  if (options.expectedTaskId && task.id !== options.expectedTaskId) {
    errors.push(`task.id must match ${options.expectedTaskId}`)
  }
  if (!nonEmpty(task.answer)) errors.push('task.answer must be a non-empty string')
  if (!nonEmpty(task.evidenceJudgment)) {
    errors.push('task.evidenceJudgment must be a non-empty string')
  }
  if (!Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === 'string')) {
    errors.push('limitations must be an array of strings')
  }
  return {
    valid: errors.length === 0,
    errors,
    citations: 0,
  }
}

export function requireValidAnxAgentResponse(
  value: unknown,
  options: Parameters<typeof validateAnxAgentResponse>[1] = {},
): AnxAgentResponse {
  const result = validateAnxAgentResponse(value, options)
  if (!result.valid) throw new Error(`ANX_AGENT_RESPONSE_INVALID: ${result.errors.join('; ')}`)
  return value as AnxAgentResponse
}

export function requireValidAnxAgentModelResponse(
  value: unknown,
  options: Parameters<typeof validateAnxAgentModelResponse>[1] = {},
): AnxAgentModelResponse {
  const result = validateAnxAgentModelResponse(value, options)
  if (!result.valid) {
    throw new Error(`ANX_AGENT_MODEL_RESPONSE_INVALID: ${result.errors.join('; ')}`)
  }
  return value as AnxAgentModelResponse
}

export function requireValidAnxAgentModelResponseV2(
  value: unknown,
  options: Parameters<typeof validateAnxAgentModelResponseV2>[1] = {},
): AnxAgentModelResponseV2 {
  const result = validateAnxAgentModelResponseV2(value, options)
  if (!result.valid) {
    throw new Error(`ANX_AGENT_MODEL_RESPONSE_V2_INVALID: ${result.errors.join('; ')}`)
  }
  return value as AnxAgentModelResponseV2
}

/**
 * Rebinds host-owned routing identity and removes machine-only ANX citations
 * from human-facing provider fields. It deliberately preserves unexpected or
 * malformed provider fields so the normal response validator still fails
 * closed rather than laundering an invalid response.
 */
export function normalizeAnxAgentModelResponseForHost(
  value: unknown,
  options: {
    expectedDocumentId: string
    expectedTaskId: string
  },
): NormalizedAnxAgentModelResponse {
  if (!record(value) || !record(value.task)) {
    return {
      response: structuredClone(value),
      audit: {
        strategy: 'deterministic-host-v1',
        documentIdentityRebound: false,
        taskIdentityRebound: false,
        technicalCitationsRemoved: 0,
        humanFieldsChanged: 0,
      },
    }
  }

  const response = structuredClone(value)
  const task = response.task as Record<string, unknown>
  const documentIdentityRebound = response.documentId !== options.expectedDocumentId
  const taskIdentityRebound = task.id !== options.expectedTaskId
  response.documentId = options.expectedDocumentId
  task.id = options.expectedTaskId

  let technicalCitationsRemoved = 0
  let humanFieldsChanged = 0
  const normalizeHumanField = (candidate: unknown): unknown => {
    if (typeof candidate !== 'string') return candidate
    const normalized = removeTechnicalAnxCitations(candidate)
    technicalCitationsRemoved += normalized.removed
    if (normalized.value !== candidate) humanFieldsChanged += 1
    return normalized.value
  }
  task.answer = normalizeHumanField(task.answer)
  task.evidenceJudgment = normalizeHumanField(task.evidenceJudgment)
  if (Array.isArray(response.limitations)) {
    response.limitations = response.limitations.map(normalizeHumanField)
  }

  return {
    response,
    audit: {
      strategy: 'deterministic-host-v1',
      documentIdentityRebound,
      taskIdentityRebound,
      technicalCitationsRemoved,
      humanFieldsChanged,
    },
  }
}

export function composeAnxAgentResponse(
  modelResponseValue: unknown,
  evidence: AnxAgentResponseEvidence,
  options: Parameters<typeof validateAnxAgentModelResponse>[1] = {},
): AnxAgentResponse {
  const modelResponse = record(modelResponseValue)
    && modelResponseValue.schema === ANX_AGENT_MODEL_RESPONSE_V2_SCHEMA
    ? requireValidAnxAgentModelResponseV2(modelResponseValue, options)
    : requireValidAnxAgentModelResponse(modelResponseValue, options)
  const citations = evidence.items.map(item => item.citation)
  const response: AnxAgentResponse = {
    schema: ANX_AGENT_RESPONSE_SCHEMA,
    documentId: modelResponse.documentId,
    task: {
      id: modelResponse.task.id,
      answer: modelResponse.task.answer,
      citations,
      evidenceJudgment: modelResponse.task.evidenceJudgment,
      evidence: structuredClone(evidence),
    },
    limitations: [...modelResponse.limitations],
  }
  return requireValidAnxAgentResponse(response, options)
}

function removeTechnicalAnxCitations(value: string): { value: string; removed: number } {
  const technicalCitationPattern = /anx:\/\/[^\s)\]}>,;`"'*]+/giu
  const removed = value.match(technicalCitationPattern)?.length || 0
  if (!removed) return { value, removed: 0 }

  const normalized = value
    .replace(/\[([^\]\n]+)\]\(\s*anx:\/\/[^)\s]+\s*\)/giu, '$1')
    .replace(/`+\s*anx:\/\/[^`\s)\]}>,;]+`*/giu, '')
    .replace(technicalCitationPattern, '')
    .replace(/\(\s*(?:source\s+)?citation\s*:\s*`*\s*\)/giu, '')
    .replace(/\[\s*\]/gu, '')
    .replace(/`{2,}/gu, '')
    .replace(/\(\s*\)/gu, '')
    .replace(/[ \t]+([,.;:!?])/gu, '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .trim()

  return { value: normalized, removed }
}

export function summarizeAnxAgentResponseEvidence(response: AnxAgentResponse): string {
  const result = validateAnxAgentResponse(response)
  const baseline = response.task.evidence.sourceBaseline.status.replaceAll('_', ' ').toLowerCase()
  return [
    `Evidence contract verified`,
    `${result.evidenceItems} item${result.evidenceItems === 1 ? '' : 's'}`,
    `${result.reviewRequiredItems} review-required`,
    baseline,
  ].join(' · ')
}

export function projectAnxAgentResponseSchemaForProvider(
  value: Record<string, unknown>,
  provider: AnxAgentResponseSchemaProvider,
): Record<string, unknown> {
  const projected = structuredClone(value)
  delete projected.$schema
  delete projected.$id
  if (provider === 'codex') {
    removeSchemaKeyword(projected, 'uniqueItems')
    addMissingConstTypes(projected)
  }
  return projected
}

export function validateAnxAgentResponseAgainstTableBundle(
  response: AnxAgentResponse,
  bundleValue: unknown,
): AnxAgentEvidenceBindingValidation {
  const errors: string[] = []
  if (!record(bundleValue)) return bindingFailure(['table evidence bundle must be an object'])
  const bundle = bundleValue
  if (bundle.schema !== 'anx.table-answer-evidence.v1') {
    errors.push('table evidence bundle schema is invalid')
  }
  const baseline = record(bundle.sourceBaseline) ? bundle.sourceBaseline : {}
  const disclosedBaseline = response.task.evidence.sourceBaseline
  compare('representation', response.task.evidence.representation, 'anx-native', errors)
  compare('sourceBaseline.status', disclosedBaseline.status, baseline.status, errors)
  compare('sourceBaseline.trusted', disclosedBaseline.trusted, baseline.trusted, errors)
  compare('sourceBaseline.issuerVerified', disclosedBaseline.issuerVerified, baseline.issuerVerified, errors)
  compare(
    'canonicalContentChangedAutomatically',
    response.task.evidence.canonicalContentChangedAutomatically,
    bundle.automaticCanonicalChange,
    errors,
  )
  const expected = new Map<string, Record<string, unknown>>()
  for (const tableValue of Array.isArray(bundle.tables) ? bundle.tables : []) {
    if (!record(tableValue) || !nonEmpty(tableValue.citation)) continue
    expected.set(tableValue.citation, tableValue)
    for (const linkedValue of Array.isArray(tableValue.linkedEvidence) ? tableValue.linkedEvidence : []) {
      if (record(linkedValue) && nonEmpty(linkedValue.citation)) expected.set(linkedValue.citation, linkedValue)
    }
  }
  let matchedItems = 0
  for (const item of response.task.evidence.items) {
    const source = expected.get(item.citation)
    if (!source) {
      errors.push(`evidence item is not bound to the table bundle: ${item.citation}`)
      continue
    }
    matchedItems += 1
    const isTable = record(source.dimensions)
    const evidence = record(source.evidence) ? source.evidence : {}
    const agentUse = record(source.agentUse) ? source.agentUse : {}
    const tableEvidence = record(evidence.tableEvidence) ? evidence.tableEvidence : {}
    compare(`${item.evidenceId}.semanticType`, item.semanticType, isTable ? tableEvidence.semanticType : source.kind, errors)
    compare(`${item.evidenceId}.evidenceStatus`, item.evidenceStatus, evidence.status, errors)
    compare(`${item.evidenceId}.unattendedUse`, item.unattendedUse, evidence.unattendedUse, errors)
    compare(
      `${item.evidenceId}.safeForUnattendedAcceptance`,
      item.safeForUnattendedAcceptance,
      agentUse.safeForUnattendedAcceptance,
      errors,
    )
    compare(`${item.evidenceId}.reviewRequired`, item.reviewRequired, agentUse.reviewRequired, errors)
    if (isTable) {
      compare(`${item.evidenceId}.sourceRepresentation`, item.sourceRepresentation, tableEvidence.sourceRepresentation, errors)
      compare(`${item.evidenceId}.dataState`, item.dataState, tableEvidence.dataState, errors)
      compare(`${item.evidenceId}.dimensions`, item.dimensions, source.dimensions, errors)
      compare(`${item.evidenceId}.anchorStatus`, item.anchorStatus, 'not-applicable', errors)
    } else {
      compare(`${item.evidenceId}.anchorStatus`, item.anchorStatus, evidence.anchorStatus || 'not-applicable', errors)
    }
  }
  for (const citation of expected.keys()) {
    if (!response.task.evidence.items.some(item => item.citation === citation)) {
      errors.push(`required bundle evidence was omitted: ${citation}`)
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    expectedItems: expected.size,
    matchedItems,
  }
}

function validateSourceBaseline(value: unknown, errors: string[]): void {
  if (!record(value)) {
    errors.push('task.evidence.sourceBaseline must be an object')
    return
  }
  if (!baselineStatuses.has(value.status as AnxAgentSourceBaselineStatus)) {
    errors.push('task.evidence.sourceBaseline.status is invalid')
  }
  if (typeof value.trusted !== 'boolean' && value.trusted !== null) {
    errors.push('task.evidence.sourceBaseline.trusted must be boolean or null')
  }
  if (typeof value.issuerVerified !== 'boolean' && value.issuerVerified !== null) {
    errors.push('task.evidence.sourceBaseline.issuerVerified must be boolean or null')
  }
}

function validateDimensions(value: unknown, prefix: string, errors: string[]): void {
  if (value === null) return
  if (!record(value)) {
    errors.push(`${prefix}.dimensions must be an object or null`)
    return
  }
  for (const field of ['rowCount', 'columnCount'] as const) {
    const count = value[field]
    if (count !== null && (!Number.isInteger(count) || Number(count) < 0)) {
      errors.push(`${prefix}.dimensions.${field} must be a non-negative integer or null`)
    }
  }
  if (!dimensionDisclosures.has(value.disclosure as AnxAgentEvidenceDimensions['disclosure'])) {
    errors.push(`${prefix}.dimensions.disclosure is invalid`)
  }
}

function citationEndsWithEvidenceId(citation: string, evidenceId: string): boolean {
  const path = citation.split(/[?#]/u)[0] || ''
  return decodeURIComponent(path.split('/').at(-1) || '') === evidenceId
}

function compare(path: string, actual: unknown, expected: unknown, errors: string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`${path} does not match bound evidence`)
  }
}

function removeSchemaKeyword(value: unknown, keyword: string): void {
  if (Array.isArray(value)) {
    for (const item of value) removeSchemaKeyword(item, keyword)
    return
  }
  if (!record(value)) return
  delete value[keyword]
  for (const item of Object.values(value)) removeSchemaKeyword(item, keyword)
}

function addMissingConstTypes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) addMissingConstTypes(item)
    return
  }
  if (!record(value)) return
  if ('const' in value && !('type' in value)) {
    const constant = value.const
    value.type = constant === null
      ? 'null'
      : Array.isArray(constant)
        ? 'array'
        : typeof constant === 'number' && Number.isInteger(constant)
          ? 'integer'
          : typeof constant
  }
  for (const item of Object.values(value)) addMissingConstTypes(item)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  prefix: string,
  errors: string[],
): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`${prefix}.${key} is not allowed`)
  }
}

function failure(errors: string[]): AnxAgentResponseValidation {
  return {
    valid: false,
    errors,
    evidenceItems: 0,
    reviewRequiredItems: 0,
    unresolvedEvidenceItems: 0,
  }
}

function modelFailure(errors: string[]): AnxAgentModelResponseValidation {
  return { valid: false, errors, citations: 0 }
}

function bindingFailure(errors: string[]): AnxAgentEvidenceBindingValidation {
  return { valid: false, errors, expectedItems: 0, matchedItems: 0 }
}
