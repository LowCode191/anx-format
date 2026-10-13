import { canonicalJson, sha256 } from './hash.js'
import { readFile } from 'node:fs/promises'
import {
  deriveAndocDraft,
  finalizeAndoc,
  type DeriveAndocDraftResult,
  type FinalizationResult,
} from './finalization.js'
import { readAndoc, type AndocPackage } from './package.js'
import {
  recordReviewApprovalTransaction,
  reviewState,
  reviewableContentSha256,
} from './review.js'
import { transactAndocPackage } from './revision.js'
import type {
  AndocActor,
  AndocDocument,
  AndocFinalizationPolicy,
  AndocTransaction,
} from './types.js'

export const ANX_RELEASE_CONTROL_SCHEMA = 'anx.release-control.v1' as const
export const ANX_REVISION_POLICY_SCHEMA = 'anx.revision-policy.v1' as const

export type AnxReleaseState = 'working' | 'review' | 'approved' | 'released' | 'superseded'

export interface AnxReleaseScheme {
  kind: 'integer' | 'alphabetic' | 'lookup' | 'semantic' | 'date' | 'explicit'
  first: string
  increment?: number
  values?: string[]
  component?: 'major' | 'minor' | 'patch'
  pattern?: string
  label?: string
}

export interface AnxRevisionPolicy {
  schema: typeof ANX_REVISION_POLICY_SCHEMA
  id: string
  label: string
  releaseScheme: AnxReleaseScheme
  workingScheme: {
    kind: 'integer'
    first: number
    increment: number
    unbounded: boolean
    label: string
  }
  states: AnxReleaseState[]
  releasedContentLocked: boolean
  changeLogRequired: boolean
  explicitHumanReleaseRequired: boolean
  agentAuthority: 'advisory-only' | 'bounded-lifecycle'
  review: {
    requiredApprovals: number
    requireResolvedAnnotations: boolean
    requireDecidedProposals: boolean
  }
  finalization: AndocFinalizationPolicy
  retention: {
    retainReleased: boolean
    workingVersions: 'all' | number
    legalHoldCapable: boolean
    backupRequiredBeforePrune: boolean
  }
}

export interface AnxReleaseReview {
  contentSha256: string
  submittedRevision: number
  submittedAt: string
  submittedBy: AndocActor
}

export interface AnxReleaseLogEntry {
  releaseRevision: string
  priorReleaseRevision: string | null
  changeSummary: string
  releasedAt: string
  releasedBy: AndocActor
  sourceInternalRevision: number
  releasedInternalRevision: number
  contentSha256: string
}

export interface AnxReleaseControl {
  schema: typeof ANX_RELEASE_CONTROL_SCHEMA
  policyId: string
  policySnapshot: AnxRevisionPolicy
  releaseRevision: string
  baseReleaseRevision: string
  nextReleaseRevision: string
  state: AnxReleaseState
  workingVersion: number
  internalRevision: number
  updatedAt: string
  updatedBy: string
  review: AnxReleaseReview | null
  releaseLog: AnxReleaseLogEntry[]
}

export interface ReleaseMutationOptions {
  actor: AndocActor
  timestamp?: string
  id?: string
  message?: string
}

export interface ReleaseSigningOptions extends ReleaseMutationOptions {
  privateKeyPem: string | Uint8Array
  keyId: string
  role: string
  requestedReleaseRevision?: string
  changeSummary: string
}

export interface ReleaseResult extends FinalizationResult {
  document: AndocDocument
  transaction: AndocTransaction
  releaseControl: AnxReleaseControl
}

export type PreparedReleaseResult = ReleaseResult

export interface DeriveNextWorkingResult extends DeriveAndocDraftResult {
  document: AndocDocument
  releaseControl: AnxReleaseControl
}

export const defaultControlledDocumentRevisionPolicy: AnxRevisionPolicy = {
  schema: ANX_REVISION_POLICY_SCHEMA,
  id: 'anx.revision-policy.controlled-document.v1',
  label: 'Controlled document',
  releaseScheme: { kind: 'integer', first: '0', increment: 1, label: 'Rev' },
  workingScheme: { kind: 'integer', first: 1, increment: 1, unbounded: true, label: 'Working v' },
  states: ['working', 'review', 'approved', 'released', 'superseded'],
  releasedContentLocked: true,
  changeLogRequired: true,
  explicitHumanReleaseRequired: true,
  agentAuthority: 'advisory-only',
  review: {
    requiredApprovals: 1,
    requireResolvedAnnotations: true,
    requireDecidedProposals: true,
  },
  finalization: {
    id: 'anx.finalization.single-approver.v1',
    requiredSignatures: 1,
    requiredRoles: ['approver'],
  },
  retention: {
    retainReleased: true,
    workingVersions: 'all',
    legalHoldCapable: true,
    backupRequiredBeforePrune: true,
  },
}

export class AnxRevisionPolicyRegistry {
  readonly #policies = new Map<string, AnxRevisionPolicy>()

  constructor(policies: unknown[] = [defaultControlledDocumentRevisionPolicy]) {
    for (const policy of policies) this.register(policy)
  }

  register(candidate: unknown): AnxRevisionPolicy {
    const policy = validateRevisionPolicy(candidate)
    if (this.#policies.has(policy.id)) throw new Error(`Revision policy is already registered: ${policy.id}`)
    this.#policies.set(policy.id, policy)
    return structuredClone(policy)
  }

  get(id: string): AnxRevisionPolicy | null {
    const policy = this.#policies.get(id)
    return policy ? structuredClone(policy) : null
  }

  list(): AnxRevisionPolicy[] {
    return [...this.#policies.values()].map(policy => structuredClone(policy))
  }
}

export function validateRevisionPolicy(candidate: unknown): AnxRevisionPolicy {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Revision policy must be an object')
  const value = candidate as Partial<AnxRevisionPolicy>
  if (value.schema !== ANX_REVISION_POLICY_SCHEMA) throw new Error(`Revision policy schema must be ${ANX_REVISION_POLICY_SCHEMA}`)
  if (!value.id?.trim()) throw new Error('Revision policy requires a stable id')
  if (!value.label?.trim()) throw new Error('Revision policy requires a label')
  const releaseScheme = validateReleaseScheme(value.releaseScheme)
  const working = value.workingScheme
  if (!working || working.kind !== 'integer' || !Number.isInteger(working.first) || working.first < 0
    || !Number.isInteger(working.increment) || working.increment < 1 || typeof working.unbounded !== 'boolean' || !working.label?.trim()) {
    throw new Error('Revision policy requires a deterministic integer working scheme')
  }
  const states = value.states
  const requiredStates: AnxReleaseState[] = ['working', 'review', 'approved', 'released', 'superseded']
  if (!Array.isArray(states) || requiredStates.some(state => !states.includes(state))) throw new Error('Revision policy must declare the complete controlled-document lifecycle')
  if (value.releasedContentLocked !== true) throw new Error('Revision policy must lock released content')
  if (value.explicitHumanReleaseRequired !== true) throw new Error('Revision policy must require explicit human release')
  if (value.agentAuthority !== 'advisory-only' && value.agentAuthority !== 'bounded-lifecycle') throw new Error('Revision policy has an unsupported agent authority')
  const review = value.review
  if (!review || !Number.isInteger(review.requiredApprovals) || review.requiredApprovals < 1
    || typeof review.requireResolvedAnnotations !== 'boolean' || typeof review.requireDecidedProposals !== 'boolean') {
    throw new Error('Revision policy requires deterministic review gates')
  }
  const finalization = value.finalization
  if (!finalization?.id?.trim() || !Number.isInteger(finalization.requiredSignatures) || finalization.requiredSignatures < 1) {
    throw new Error('Revision policy requires a finalization policy')
  }
  if (finalization.requiredRoles && (!Array.isArray(finalization.requiredRoles) || finalization.requiredRoles.some(role => !role.trim()))) {
    throw new Error('Revision policy finalization roles must be non-empty strings')
  }
  const retention = value.retention
  if (!retention || retention.retainReleased !== true
    || (retention.workingVersions !== 'all' && (!Number.isInteger(retention.workingVersions) || retention.workingVersions < 1))
    || typeof retention.legalHoldCapable !== 'boolean' || typeof retention.backupRequiredBeforePrune !== 'boolean') {
    throw new Error('Revision policy requires an explicit non-destructive retention contract')
  }
  return structuredClone({ ...value, releaseScheme } as AnxRevisionPolicy)
}

export function releaseControlState(document: AndocDocument): AnxReleaseControl {
  const candidate = document.metadata?.anxReleaseControl
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const value = candidate as Partial<AnxReleaseControl>
    if (value.schema === ANX_RELEASE_CONTROL_SCHEMA) {
      const policy = resolveRevisionPolicy(value.policySnapshot)
      const releaseRevision = scalarRevision(value.releaseRevision, policy.releaseScheme.first)
      const log = Array.isArray(value.releaseLog) ? structuredClone(value.releaseLog) as AnxReleaseLogEntry[] : []
      return {
        schema: ANX_RELEASE_CONTROL_SCHEMA,
        policyId: typeof value.policyId === 'string' && value.policyId.trim() ? value.policyId : policy.id,
        policySnapshot: policy,
        releaseRevision,
        baseReleaseRevision: scalarRevision(value.baseReleaseRevision, releaseRevision),
        nextReleaseRevision: typeof value.nextReleaseRevision === 'string' || typeof value.nextReleaseRevision === 'number'
          ? String(value.nextReleaseRevision)
          : computeNextReleaseRevision(releaseRevision, policy, log),
        state: isReleaseState(value.state) ? value.state : 'working',
        workingVersion: Number.isInteger(value.workingVersion) && Number(value.workingVersion) >= 0 ? Number(value.workingVersion) : document.revision,
        internalRevision: Number.isInteger(value.internalRevision) ? Number(value.internalRevision) : document.revision,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : document.updatedAt,
        updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : 'legacy-import',
        review: validReleaseReview(value.review) ? structuredClone(value.review) : null,
        releaseLog: log,
      }
    }
  }
  const policy = structuredClone(defaultControlledDocumentRevisionPolicy)
  return {
    schema: ANX_RELEASE_CONTROL_SCHEMA,
    policyId: policy.id,
    policySnapshot: policy,
    releaseRevision: policy.releaseScheme.first,
    baseReleaseRevision: policy.releaseScheme.first,
    nextReleaseRevision: policy.releaseScheme.first,
    state: 'working',
    workingVersion: document.revision,
    internalRevision: document.revision,
    updatedAt: document.updatedAt,
    updatedBy: 'legacy-import',
    review: null,
    releaseLog: [],
  }
}

export function releaseControlSummary(document: AndocDocument): Record<string, unknown> {
  const control = releaseControlState(document)
  const contentSha256 = reviewableContentSha256(document)
  const state = reviewState(document)
  const approvals = approvedActorsForContent(document, control.review?.contentSha256 || contentSha256)
  const gates = releaseGates(document, control)
  return {
    schema: control.schema,
    documentId: document.documentId,
    internalRevision: document.revision,
    contentSha256,
    state: control.state,
    releaseRevision: control.releaseRevision,
    nextReleaseRevision: control.nextReleaseRevision,
    workingVersion: control.workingVersion,
    policy: control.policySnapshot,
    review: control.review,
    approvals,
    requiredApprovals: control.policySnapshot.review.requiredApprovals,
    releaseLog: control.releaseLog,
    counts: {
      openAnnotations: state.annotations.filter(item => item.status === 'open').length,
      openProposals: state.proposals.filter(item => item.status === 'open').length,
    },
    gates,
    allowedActions: allowedLifecycleActions(document, control, gates, approvals.length),
  }
}

export function applyRevisionPolicyTransaction(
  document: AndocDocument,
  policyCandidate: unknown,
  options: ReleaseMutationOptions,
): AndocTransaction {
  const current = releaseControlState(document)
  assertHumanLifecycleActor(options.actor, current.policySnapshot)
  if (current.state !== 'working') throw new Error(`Revision policy may only change in WORKING state; current state is ${current.state}`)
  if (current.releaseLog.length) throw new Error('REVISION_POLICY_LOCKED: policy cannot change after the first controlled release')
  const policy = validateRevisionPolicy(policyCandidate)
  const timestamp = options.timestamp || new Date().toISOString()
  const next = updateControl(current, {
    policyId: policy.id,
    policySnapshot: policy,
    releaseRevision: policy.releaseScheme.first,
    baseReleaseRevision: policy.releaseScheme.first,
    nextReleaseRevision: policy.releaseScheme.first,
    state: 'working',
    internalRevision: document.revision + 1,
    updatedAt: timestamp,
    updatedBy: options.actor.id,
    review: null,
  })
  return controlTransaction(document, next, options, options.message || `Apply revision policy ${policy.id}`, timestamp)
}

export function submitReleaseReviewTransaction(document: AndocDocument, options: ReleaseMutationOptions): AndocTransaction {
  assertHumanLifecycleActor(options.actor, releaseControlState(document).policySnapshot)
  const timestamp = options.timestamp || new Date().toISOString()
  const control = releaseControlState(document)
  if (control.state === 'released') throw new Error('RELEASED_CONTENT_LOCKED: derive a new working copy before review')
  if (control.state !== 'working') throw new Error(`Release review requires WORKING state; current state is ${control.state}`)
  const gates = releaseGates(document, control)
  if (!gates.annotationsResolved) throw new Error('REVIEW_GATE_OPEN_ANNOTATIONS: resolve all review annotations before submission')
  if (!gates.proposalsDecided) throw new Error('REVIEW_GATE_OPEN_PROPOSALS: decide all review proposals before submission')
  const contentSha256 = reviewableContentSha256(document)
  const next = updateControl(control, {
    state: 'review',
    internalRevision: document.revision + 1,
    updatedAt: timestamp,
    updatedBy: options.actor.id,
    review: {
      contentSha256,
      submittedRevision: document.revision,
      submittedAt: timestamp,
      submittedBy: structuredClone(options.actor),
    },
  })
  return controlTransaction(document, next, options, options.message || `Submit WORKING v${control.workingVersion} for release review`, timestamp)
}

export function approveReleaseTransaction(document: AndocDocument, options: ReleaseMutationOptions & { note?: string }): AndocTransaction {
  const control = releaseControlState(document)
  assertHumanLifecycleActor(options.actor, control.policySnapshot)
  if (control.state !== 'review' && control.state !== 'approved') throw new Error(`Release approval requires REVIEW state; current state is ${control.state}`)
  if (!control.review) throw new Error('Release approval requires a bound review target')
  const contentSha256 = reviewableContentSha256(document)
  if (contentSha256 !== control.review.contentSha256) throw new Error('REVIEW_CONTENT_CHANGED: submit the current content for review again')
  const timestamp = options.timestamp || new Date().toISOString()
  const existing = approvedActorsForContent(document, contentSha256)
  if (existing.includes(options.actor.id)) throw new Error(`Reviewer already approved this content: ${options.actor.id}`)
  const approvalCount = existing.length + 1
  const next = updateControl(control, {
    state: approvalCount >= control.policySnapshot.review.requiredApprovals ? 'approved' : 'review',
    internalRevision: document.revision + 1,
    updatedAt: timestamp,
    updatedBy: options.actor.id,
  })
  return recordReviewApprovalTransaction(document, {
    decision: 'approved',
    reviewedRevision: document.revision,
    note: options.note,
  }, {
    ...options,
    timestamp,
    message: options.message || `Approve release content ${contentSha256.slice(0, 12)}…`,
    documentMetadataPatch: { anxReleaseControl: next },
  })
}

export function requestReleaseChangesTransaction(document: AndocDocument, options: ReleaseMutationOptions & { note?: string }): AndocTransaction {
  const control = releaseControlState(document)
  assertHumanLifecycleActor(options.actor, control.policySnapshot)
  if (control.state !== 'review' && control.state !== 'approved') throw new Error(`Changes may only be requested from REVIEW or APPROVED state; current state is ${control.state}`)
  const timestamp = options.timestamp || new Date().toISOString()
  const next = updateControl(control, {
    state: 'working',
    internalRevision: document.revision + 1,
    updatedAt: timestamp,
    updatedBy: options.actor.id,
    review: null,
  })
  return recordReviewApprovalTransaction(document, {
    decision: 'changes-requested',
    reviewedRevision: document.revision,
    note: options.note,
  }, {
    ...options,
    timestamp,
    message: options.message || `Request changes to WORKING v${control.workingVersion}`,
    documentMetadataPatch: { anxReleaseControl: next },
  })
}

export async function prepareReleasePackage(pkg: AndocPackage, options: ReleaseSigningOptions): Promise<PreparedReleaseResult> {
  const control = releaseControlState(pkg.document)
  assertHumanLifecycleActor(options.actor, control.policySnapshot)
  if (control.state !== 'approved') throw new Error(`Release requires APPROVED state; current state is ${control.state}`)
  if (!control.review) throw new Error('Release requires a bound review target')
  const contentSha256 = reviewableContentSha256(pkg.document)
  if (contentSha256 !== control.review.contentSha256) throw new Error('REVIEW_CONTENT_CHANGED: submit the current content for review again')
  const approvals = approvedActorsForContent(pkg.document, contentSha256)
  if (approvals.length < control.policySnapshot.review.requiredApprovals) {
    throw new Error(`RELEASE_APPROVALS_INCOMPLETE: requires ${control.policySnapshot.review.requiredApprovals}, found ${approvals.length}`)
  }
  const changeSummary = options.changeSummary.trim()
  if (control.policySnapshot.changeLogRequired && !changeSummary) throw new Error('RELEASE_CHANGE_LOG_REQUIRED: enter a concise release change summary')
  const timestamp = options.timestamp || new Date().toISOString()
  const releaseRevision = computeNextReleaseRevision(control.releaseRevision, control.policySnapshot, control.releaseLog, options.requestedReleaseRevision)
  const logEntry: AnxReleaseLogEntry = {
    releaseRevision,
    priorReleaseRevision: control.releaseLog.length ? control.releaseRevision : null,
    changeSummary,
    releasedAt: timestamp,
    releasedBy: structuredClone(options.actor),
    sourceInternalRevision: pkg.document.revision,
    releasedInternalRevision: pkg.document.revision + 1,
    contentSha256,
  }
  const next = updateControl(control, {
    releaseRevision,
    baseReleaseRevision: releaseRevision,
    nextReleaseRevision: computeNextReleaseRevision(releaseRevision, control.policySnapshot, [...control.releaseLog, logEntry]),
    state: 'released',
    internalRevision: pkg.document.revision + 1,
    updatedAt: timestamp,
    updatedBy: options.actor.id,
    review: null,
    releaseLog: [...control.releaseLog, logEntry],
  })
  const transaction = controlTransaction(
    pkg.document,
    next,
    options,
    options.message || `Release ${control.policySnapshot.releaseScheme.label || 'Rev'} ${releaseRevision}: ${changeSummary}`,
    timestamp,
  )
  const released = await transactAndocPackage(pkg, transaction)
  const finalized = await finalizeAndoc(released.packageBytes, {
    privateKeyPem: options.privateKeyPem,
    keyId: options.keyId,
    role: options.role,
    actor: structuredClone(options.actor),
    createdAt: timestamp,
    policy: control.policySnapshot.finalization,
  })
  return {
    ...finalized,
    document: released.document,
    transaction,
    releaseControl: next,
  }
}

export async function releaseAndocPackage(pkg: AndocPackage, options: ReleaseSigningOptions): Promise<ReleaseResult> {
  const prepared = await prepareReleasePackage(pkg, options)
  if (!prepared.verification.valid) throw new Error(`RELEASE_FINALIZATION_INCOMPLETE: ${prepared.verification.status}`)
  return prepared
}

export async function deriveNextWorkingCopy(
  input: string | Uint8Array,
  options: ReleaseMutationOptions & { parentMode?: 'embedded' | 'reference'; parentUri?: string },
): Promise<DeriveNextWorkingResult> {
  const parentBytes = typeof input === 'string'
    ? new Uint8Array(await readFile(input))
    : new Uint8Array(input)
  const parent = await readAndoc(parentBytes)
  const control = releaseControlState(parent.document)
  assertHumanLifecycleActor(options.actor, control.policySnapshot)
  if (control.state !== 'released' || !parent.finalizations.length) throw new Error('A new working copy requires a finalized RELEASED package')
  const timestamp = options.timestamp || new Date().toISOString()
  const next = updateControl(control, {
    state: 'working',
    workingVersion: 0,
    baseReleaseRevision: control.releaseRevision,
    nextReleaseRevision: computeNextReleaseRevision(control.releaseRevision, control.policySnapshot, control.releaseLog),
    internalRevision: parent.document.revision + 1,
    updatedAt: timestamp,
    updatedBy: options.actor.id,
    review: null,
  })
  const derived = await deriveAndocDraft(parentBytes, {
    actor: structuredClone(options.actor),
    derivedAt: timestamp,
    parentMode: options.parentMode,
    parentUri: options.parentUri,
    documentMetadataPatch: { anxReleaseControl: next },
  })
  const pkg = await readAndoc(derived.packageBytes)
  return { ...derived, document: pkg.document, releaseControl: releaseControlState(pkg.document) }
}

function resolveRevisionPolicy(candidate: unknown): AnxRevisionPolicy {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return structuredClone(defaultControlledDocumentRevisionPolicy)
  const raw = candidate as Partial<AnxRevisionPolicy>
  const merged: AnxRevisionPolicy = {
    ...structuredClone(defaultControlledDocumentRevisionPolicy),
    ...structuredClone(raw),
    schema: ANX_REVISION_POLICY_SCHEMA,
    id: raw.id || defaultControlledDocumentRevisionPolicy.id,
    label: raw.label || raw.id || defaultControlledDocumentRevisionPolicy.label,
    releaseScheme: { ...structuredClone(defaultControlledDocumentRevisionPolicy.releaseScheme), ...(structuredClone(raw.releaseScheme) || {}) },
    workingScheme: { ...structuredClone(defaultControlledDocumentRevisionPolicy.workingScheme), ...(structuredClone(raw.workingScheme) || {}) },
    review: { ...structuredClone(defaultControlledDocumentRevisionPolicy.review), ...(structuredClone(raw.review) || {}) },
    finalization: { ...structuredClone(defaultControlledDocumentRevisionPolicy.finalization), ...(structuredClone(raw.finalization) || {}) },
    retention: { ...structuredClone(defaultControlledDocumentRevisionPolicy.retention), ...(structuredClone(raw.retention) || {}) },
  }
  return validateRevisionPolicy(merged)
}

function validateReleaseScheme(candidate: unknown): AnxReleaseScheme {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Revision policy requires a release scheme')
  const value = candidate as Partial<AnxReleaseScheme>
  if (!['integer', 'alphabetic', 'lookup', 'semantic', 'date', 'explicit'].includes(String(value.kind))) throw new Error(`Unsupported release scheme: ${String(value.kind)}`)
  if (!value.first?.trim()) throw new Error('Release scheme requires a first identifier')
  if (value.kind === 'integer' && (!Number.isInteger(value.increment ?? 1) || Number(value.increment ?? 1) < 1 || !/^-?\d+$/.test(value.first))) {
    throw new Error('Integer release scheme requires an integer first value and positive increment')
  }
  if (value.kind === 'alphabetic' && !/^[A-Z]+$/i.test(value.first)) throw new Error('Alphabetic release scheme requires an A-Z first value')
  if (value.kind === 'lookup' && (!Array.isArray(value.values) || !value.values.length || !value.values.includes(value.first) || new Set(value.values).size !== value.values.length)) {
    throw new Error('Lookup release scheme requires unique values containing the first identifier')
  }
  if (value.kind === 'semantic' && !/^\d+\.\d+\.\d+$/.test(value.first)) throw new Error('Semantic release scheme requires an x.y.z first value')
  if ((value.kind === 'date' || value.kind === 'explicit') && !value.pattern?.trim()) throw new Error(`${value.kind} release scheme requires an explicit validation pattern`)
  if (value.pattern) {
    try { new RegExp(value.pattern) } catch { throw new Error('Release scheme pattern must be a valid regular expression') }
  }
  return structuredClone(value as AnxReleaseScheme)
}

function computeNextReleaseRevision(
  current: string,
  policy: AnxRevisionPolicy,
  releaseLog: AnxReleaseLogEntry[],
  requested?: string,
): string {
  const scheme = policy.releaseScheme
  if (!releaseLog.length) {
    const first = requested?.trim() || scheme.first
    assertRequestedRevision(first, scheme)
    if (first !== scheme.first && scheme.kind !== 'date' && scheme.kind !== 'explicit') throw new Error(`First release must be ${scheme.first}`)
    return first
  }
  if (scheme.kind === 'date' || scheme.kind === 'explicit') {
    const next = requested?.trim()
    if (!next) throw new Error(`${scheme.kind} release policy requires an explicit next release identifier`)
    assertRequestedRevision(next, scheme)
    if (next === current) throw new Error('Next release identifier must differ from the current release')
    return next
  }
  const next = scheme.kind === 'integer'
    ? String(Number.parseInt(current, 10) + (scheme.increment || 1))
    : scheme.kind === 'alphabetic'
      ? incrementAlphabetic(current)
      : scheme.kind === 'lookup'
        ? nextLookup(current, scheme.values || [])
        : incrementSemantic(current, scheme.component || 'minor')
  if (requested?.trim() && requested.trim() !== next) throw new Error(`Next release identifier is determined by policy as ${next}`)
  return next
}

function assertRequestedRevision(value: string, scheme: AnxReleaseScheme): void {
  if (scheme.pattern && !new RegExp(scheme.pattern).test(value)) throw new Error(`Release identifier does not match policy pattern: ${value}`)
}

function incrementAlphabetic(value: string): string {
  if (!/^[A-Z]+$/i.test(value)) throw new Error(`Cannot increment alphabetic release identifier: ${value}`)
  const chars = value.toUpperCase().split('')
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (chars[index] !== 'Z') {
      chars[index] = String.fromCharCode(chars[index]!.charCodeAt(0) + 1)
      return chars.join('')
    }
    chars[index] = 'A'
  }
  return `A${chars.join('')}`
}

function nextLookup(current: string, values: string[]): string {
  const index = values.indexOf(current)
  if (index < 0 || index + 1 >= values.length) throw new Error(`Lookup release scheme has no successor for ${current}`)
  return values[index + 1]!
}

function incrementSemantic(current: string, component: 'major' | 'minor' | 'patch'): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) throw new Error(`Cannot increment semantic release identifier: ${current}`)
  let major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3])
  if (component === 'major') { major += 1; minor = 0; patch = 0 }
  else if (component === 'minor') { minor += 1; patch = 0 }
  else patch += 1
  return `${major}.${minor}.${patch}`
}

function approvedActorsForContent(document: AndocDocument, contentSha256: string): string[] {
  return [...new Set(reviewState(document).approvals
    .filter(approval => approval.decision === 'approved' && approval.contentSha256 === contentSha256)
    .map(approval => approval.reviewer.id))]
}

function releaseGates(document: AndocDocument, control: AnxReleaseControl): Record<string, boolean> {
  const state = reviewState(document)
  return {
    annotationsResolved: !control.policySnapshot.review.requireResolvedAnnotations || state.annotations.every(item => item.status === 'resolved'),
    proposalsDecided: !control.policySnapshot.review.requireDecidedProposals || state.proposals.every(item => item.status !== 'open'),
    contentMatchesReview: Boolean(control.review && control.review.contentSha256 === reviewableContentSha256(document)),
  }
}

function allowedLifecycleActions(
  document: AndocDocument,
  control: AnxReleaseControl,
  gates: Record<string, boolean>,
  approvalCount: number,
): string[] {
  if (control.state === 'released') return ['derive-working-copy']
  if (control.state === 'working') return [
    ...(control.releaseLog.length ? [] : ['apply-policy']),
    ...(gates.annotationsResolved && gates.proposalsDecided ? ['submit-review'] : []),
  ]
  if (control.state === 'review') return [
    ...(gates.contentMatchesReview && approvalCount < control.policySnapshot.review.requiredApprovals ? ['approve'] : []),
    'request-changes',
  ]
  if (control.state === 'approved') return gates.contentMatchesReview ? ['release', 'request-changes'] : ['request-changes']
  return []
}

function controlTransaction(
  document: AndocDocument,
  control: AnxReleaseControl,
  options: ReleaseMutationOptions,
  message: string,
  timestamp: string,
): AndocTransaction {
  return {
    schema: 'andoc.transaction.v1',
    id: options.id || `lifecycle-${sha256(Buffer.from(canonicalJson({ documentId: document.documentId, revision: document.revision, actor: options.actor, timestamp, state: control.state }))).slice(0, 24)}`,
    baseRevision: document.revision,
    actor: structuredClone(options.actor),
    timestamp,
    message,
    operations: [{ op: 'setDocument', patch: { metadata: { anxReleaseControl: control } } }],
  }
}

function updateControl(control: AnxReleaseControl, patch: Partial<AnxReleaseControl>): AnxReleaseControl {
  return structuredClone({ ...control, ...patch })
}

function assertHumanLifecycleActor(actor: AndocActor, policy: AnxRevisionPolicy): void {
  if (actor.type !== 'human') {
    throw new Error(policy.agentAuthority === 'advisory-only'
      ? 'AGENT_RELEASE_AUTHORITY_DENIED: this policy permits agents to advise only'
      : 'HUMAN_RELEASE_AUTHORITY_REQUIRED: reference Studio lifecycle actions require a human actor')
  }
}

function scalarRevision(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback
}

function isReleaseState(value: unknown): value is AnxReleaseState {
  return value === 'working' || value === 'review' || value === 'approved' || value === 'released' || value === 'superseded'
}

function validReleaseReview(value: unknown): value is AnxReleaseReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<AnxReleaseReview>
  return typeof candidate.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(candidate.contentSha256)
    && Number.isInteger(candidate.submittedRevision) && typeof candidate.submittedAt === 'string'
    && Boolean(candidate.submittedBy?.id)
}
