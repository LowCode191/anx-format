import { canonicalJson } from './hash.js'
import type { AndocActor, AndocDocument } from './types.js'

/**
 * Metadata that records human authority: release state, human page-object
 * corrections, review decisions and approved relationships.
 *
 * These live in ordinary document metadata, so without this guard any transaction
 * could rewrite them, including one from an agent tool. The guard runs inside
 * applyTransaction and compares the document before and after, so it covers every
 * operation that can touch metadata.
 *
 * Limits: the actor type is asserted by whoever builds the transaction. The agent
 * surfaces (the agent tools and both MCP servers) always stamp `agent`, so this closes
 * the path where a model writes authority state through those tools. It is not a
 * defence against a writer with direct file access that claims to be human; only
 * finalization signatures checked against a verifier's trust store are.
 */
export const ANX_RELEASE_CONTROL_METADATA_KEY = 'anxReleaseControl'
const REGION_CORRECTIONS_METADATA_KEY = 'anxRegionCorrections'
const REVIEW_METADATA_KEY = 'agnReview'
const RELATIONSHIPS_METADATA_KEY = 'anxRelationships'

/** Keys only a human actor may create, change or remove. */
export const HUMAN_ONLY_METADATA_KEYS = [ANX_RELEASE_CONTROL_METADATA_KEY, REGION_CORRECTIONS_METADATA_KEY] as const

/** Keys a non-human actor may add to, but only with entries that carry no human decision. */
export const HUMAN_DECISION_METADATA_KEYS = [REVIEW_METADATA_KEY, RELATIONSHIPS_METADATA_KEY] as const

export class ProtectedMetadataError extends Error {
  readonly code = 'PROTECTED_METADATA'

  constructor(
    public readonly metadataKey: string,
    public readonly actorType: AndocActor['type'],
    reason: string,
  ) {
    super(`PROTECTED_METADATA: actor type "${actorType}" may not ${reason} (metadata.${metadataKey}). This state records human authority and needs a human transaction.`)
    this.name = 'ProtectedMetadataError'
  }
}

export function assertMetadataAuthority(before: AndocDocument, after: AndocDocument, actor: AndocActor): void {
  if (actor.type === 'human') return
  for (const key of HUMAN_ONLY_METADATA_KEYS) {
    if (!sameValue(before.metadata[key], after.metadata[key])) {
      throw new ProtectedMetadataError(key, actor.type, key === ANX_RELEASE_CONTROL_METADATA_KEY ? 'change release state, approvals or policy' : 'change human page-object corrections')
    }
  }
  assertReviewAuthority(before.metadata[REVIEW_METADATA_KEY], after.metadata[REVIEW_METADATA_KEY], actor)
  assertRelationshipAuthority(before.metadata[RELATIONSHIPS_METADATA_KEY], after.metadata[RELATIONSHIPS_METADATA_KEY], actor)
}

function assertReviewAuthority(before: unknown, after: unknown, actor: AndocActor): void {
  if (sameValue(before, after)) return
  const refuse = (reason: string): never => { throw new ProtectedMetadataError(REVIEW_METADATA_KEY, actor.type, reason) }
  if (!isRecord(after)) return refuse('remove or replace the review record')
  const previous = isRecord(before) ? before : {}
  if (!sameValue(previous.approvals ?? [], after.approvals ?? [])) refuse('add, change or remove review approvals')
  for (const key of Object.keys({ ...previous, ...after })) {
    if (key === 'annotations' || key === 'proposals' || key === 'approvals') continue
    if (isRecord(before) && !sameValue(previous[key], after[key])) refuse(`change the review record's ${key}`)
  }
  assertAppendOnly(previous.annotations, after.annotations, actor, 'review annotations', entry =>
    entry.status === 'open' && entry.resolvedBy === undefined && entry.resolvedAt === undefined, refuse)
  assertAppendOnly(previous.proposals, after.proposals, actor, 'review proposals', entry =>
    entry.status === 'open' && entry.decidedBy === undefined && entry.decidedAt === undefined && entry.appliedRevision === undefined, refuse)
}

function assertAppendOnly(
  before: unknown,
  after: unknown,
  actor: AndocActor,
  label: string,
  undecided: (entry: Record<string, unknown>) => boolean,
  refuse: (reason: string) => never,
): void {
  const previous = entriesById(before)
  if (after !== undefined && !Array.isArray(after)) refuse(`replace ${label} with a non-list value`)
  const current = entriesById(after)
  for (const [id, entry] of previous) {
    if (!current.has(id) || !sameValue(entry, current.get(id))) refuse(`change, resolve, decide or remove existing ${label}`)
  }
  for (const [id, entry] of current) {
    if (previous.has(id)) continue
    if (!undecided(entry)) refuse(`add ${label} that already carry a decision`)
    if (!sameValue(entry.author, actor)) refuse(`add ${label} under another author's name`)
  }
  if (Array.isArray(after) && current.size !== after.length) refuse(`add ${label} without a unique id`)
}

function assertRelationshipAuthority(before: unknown, after: unknown, actor: AndocActor): void {
  if (sameValue(before, after)) return
  const refuse = (reason: string): never => { throw new ProtectedMetadataError(RELATIONSHIPS_METADATA_KEY, actor.type, reason) }
  const previous = entriesById(isRecord(before) ? before.relationships : undefined)
  const afterList = isRecord(after) ? after.relationships : undefined
  if (after !== undefined && (!isRecord(after) || (afterList !== undefined && !Array.isArray(afterList)))) refuse('replace the relationship record with an unreadable value')
  const current = entriesById(afterList)
  if (Array.isArray(afterList) && current.size !== afterList.length) refuse('add relationships without a unique id')
  for (const [id, entry] of previous) {
    if (authorityStatus(entry) !== 'agent-suggested' && !sameValue(entry, current.get(id))) refuse('change or remove a human-approved relationship')
  }
  for (const [id, entry] of current) {
    if (sameValue(previous.get(id), entry)) continue
    const authority = isRecord(entry.authority) ? entry.authority : {}
    if (authority.status !== 'agent-suggested' || authority.approvedBy !== undefined || authority.approvedAt !== undefined) {
      refuse('create or approve a relationship; agents may only add agent-suggested candidates')
    }
    if (isRecord(authority.assertedBy) && authority.assertedBy.type === 'human') refuse('assert a relationship in a human\'s name')
  }
}

function authorityStatus(entry: Record<string, unknown>): unknown {
  return isRecord(entry.authority) ? entry.authority.status : undefined
}

function entriesById(value: unknown): Map<string, Record<string, unknown>> {
  const entries = new Map<string, Record<string, unknown>>()
  if (!Array.isArray(value)) return entries
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.id === 'string') entries.set(entry.id, entry)
  }
  return entries
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  return canonicalJson(left) === canonicalJson(right)
}
