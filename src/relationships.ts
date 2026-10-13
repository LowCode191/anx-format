import type { AndocActor, AndocDocument } from './types.js'

export const ANX_RELATIONSHIPS_METADATA_KEY = 'anxRelationships'
export const ANX_RELATIONSHIPS_SCHEMA = 'anx.relationships.v1' as const

export const ANX_RELATIONSHIP_TYPES = [
  'references',
  'governed-by',
  'derived-from',
  'supersedes',
  'claims-conformance-to',
] as const

export type AnxRelationshipType = typeof ANX_RELATIONSHIP_TYPES[number]
export type AnxRelationshipAuthorityStatus = 'human-approved' | 'agent-suggested'
export type AnxRelationshipResolutionStatus = 'resolved' | 'metadata-only' | 'unresolved' | 'restricted'

export interface AnxRelationshipTarget {
  kind: 'internal-document' | 'external-document'
  identifier: string
  title: string
  revision?: string
  section?: string
  publisher?: string
  uri?: string
}

export interface AnxRelationshipResolution {
  status: AnxRelationshipResolutionStatus
  contentAvailable: boolean
  resolvedDocumentId?: string
}

export interface AnxRelationshipAuthority {
  status: AnxRelationshipAuthorityStatus
  assertedBy: AndocActor
  assertedAt: string
  approvedBy?: AndocActor
  approvedAt?: string
}

export interface AnxDocumentRelationship {
  id: string
  type: AnxRelationshipType
  status: 'active' | 'removed'
  source?: {
    anchorId?: string
  }
  target: AnxRelationshipTarget
  resolution: AnxRelationshipResolution
  authority: AnxRelationshipAuthority
  createdAt: string
  updatedAt: string
  note?: string
  removedAt?: string
  removedBy?: AndocActor
}

export interface AnxDocumentRelationships {
  schema: typeof ANX_RELATIONSHIPS_SCHEMA
  relationships: AnxDocumentRelationship[]
}

export interface AnxRelationshipQuery {
  types?: AnxRelationshipType[]
  includeRemoved?: boolean
  limit?: number
}

export interface AnxRelationshipCitation {
  uri: string
  documentId: string
  revision: number
  relationshipId: string
  evidenceType: 'relationship'
  relationshipType: AnxRelationshipType
  status: AnxDocumentRelationship['status']
  target: AnxRelationshipTarget
  resolution: AnxRelationshipResolution
  authority: AnxRelationshipAuthority
}

export function emptyDocumentRelationships(): AnxDocumentRelationships {
  return { schema: ANX_RELATIONSHIPS_SCHEMA, relationships: [] }
}

export function documentRelationshipsState(document: AndocDocument): AnxDocumentRelationships {
  const candidate = document.metadata[ANX_RELATIONSHIPS_METADATA_KEY]
  if (candidate === undefined) return emptyDocumentRelationships()
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Invalid ANX document relationships metadata')
  }
  const value = candidate as Partial<AnxDocumentRelationships>
  if (value.schema !== ANX_RELATIONSHIPS_SCHEMA || !Array.isArray(value.relationships)) {
    throw new Error('Invalid ANX document relationships metadata')
  }
  return structuredClone(value as AnxDocumentRelationships)
}

export function relationshipCitation(
  document: AndocDocument,
  relationship: AnxDocumentRelationship,
): AnxRelationshipCitation {
  return {
    uri: `anx://${document.documentId}/revisions/${document.revision}/relationships/${encodeURIComponent(relationship.id)}`,
    documentId: document.documentId,
    revision: document.revision,
    relationshipId: relationship.id,
    evidenceType: 'relationship',
    relationshipType: relationship.type,
    status: relationship.status,
    target: structuredClone(relationship.target),
    resolution: structuredClone(relationship.resolution),
    authority: structuredClone(relationship.authority),
  }
}

export function documentRelationships(
  document: AndocDocument,
  query: AnxRelationshipQuery = {},
): Record<string, unknown> {
  const state = documentRelationshipsState(document)
  const selectedTypes = new Set(query.types || [])
  const maximum = Math.max(1, Math.min(query.limit ?? 100, 250))
  const eligible = state.relationships.filter(relationship => {
    if (!query.includeRemoved && relationship.status !== 'active') return false
    return !selectedTypes.size || selectedTypes.has(relationship.type)
  })
  const returned = eligible.slice(0, maximum).map(relationship => ({
    ...structuredClone(relationship),
    citation: relationshipCitation(document, relationship),
    agentUse: {
      relationshipIsDocumentAssertion: true,
      targetContentAvailable: relationship.resolution.contentAvailable,
      targetContentRestricted: relationship.resolution.status === 'restricted',
      verificationRequired: !relationship.resolution.contentAvailable
        || relationship.type === 'claims-conformance-to',
      guidance: relationship.resolution.contentAvailable
        ? relationship.type === 'claims-conformance-to'
          ? 'The document claims conformance. Verify the claim against retained evidence before presenting it as established compliance.'
          : 'The relationship is an approved document assertion. Use the target content itself for claims about the target.'
        : 'The target content is not available to this agent. Disclose that limitation and do not infer the target document’s requirements or conclusions.',
    },
  }))
  const active = state.relationships.filter(relationship => relationship.status === 'active')
  return {
    schema: 'anx.relationships.response.v1',
    sourceSchema: state.schema,
    document: {
      id: document.documentId,
      revision: document.revision,
      title: document.title,
    },
    counts: {
      total: state.relationships.length,
      active: active.length,
      removed: state.relationships.length - active.length,
      humanApproved: active.filter(relationship => relationship.authority.status === 'human-approved').length,
      agentSuggested: active.filter(relationship => relationship.authority.status === 'agent-suggested').length,
      external: active.filter(relationship => relationship.target.kind === 'external-document').length,
      contentUnavailable: active.filter(relationship => !relationship.resolution.contentAvailable).length,
    },
    returned: returned.length,
    truncated: eligible.length > returned.length,
    relationships: returned,
    claimBoundary: 'Relationships are revision-bound assertions made by this document. They do not prove the target content, target authenticity, legal authority, licensing rights, or compliance.',
  }
}

export function relationshipById(
  document: AndocDocument,
  relationshipId: string,
): AnxDocumentRelationship {
  const relationship = documentRelationshipsState(document).relationships.find(candidate => candidate.id === relationshipId)
  if (!relationship) throw new Error(`Document relationship not found: ${relationshipId}`)
  return relationship
}
