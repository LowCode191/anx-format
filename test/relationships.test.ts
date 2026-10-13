import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  andocCite,
  anxRelationships,
  packAndoc,
  readAndoc,
  transactAndocPackage,
  validateDocument,
  validateRelationships,
  type AndocDocument,
  type AnxDocumentRelationships,
} from '../src/index.js'

const timestamp = '2026-07-27T12:00:00.000Z'

function relationshipState(): AnxDocumentRelationships {
  return {
    schema: 'anx.relationships.v1',
    relationships: [
      {
        id: 'relationship-iso-9001',
        type: 'governed-by',
        status: 'active',
        target: {
          kind: 'external-document',
          identifier: 'ISO 9001:2015',
          title: 'Quality management systems — Requirements',
          revision: '2015',
          section: 'Clause 7.5',
          publisher: 'ISO',
          uri: 'https://www.iso.org/standard/62085.html',
        },
        resolution: { status: 'metadata-only', contentAvailable: false },
        authority: {
          status: 'human-approved',
          assertedBy: { type: 'human', id: 'reviewer' },
          assertedAt: timestamp,
          approvedBy: { type: 'human', id: 'reviewer' },
          approvedAt: timestamp,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
        note: 'The standard is not stored in this repository.',
      },
      {
        id: 'relationship-internal-policy',
        type: 'references',
        status: 'active',
        target: {
          kind: 'internal-document',
          identifier: 'policy-quality-v4',
          title: 'Quality policy',
          revision: '4',
        },
        resolution: {
          status: 'resolved',
          contentAvailable: true,
          resolvedDocumentId: 'policy-quality-v4',
        },
        authority: {
          status: 'agent-suggested',
          assertedBy: { type: 'agent', id: 'reference-extractor' },
          assertedAt: timestamp,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  }
}

async function fixtureDocument(): Promise<AndocDocument> {
  return JSON.parse(
    await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8'),
  ) as AndocDocument
}

test('portable relationships survive packing and disclose unavailable external content', async () => {
  const document = await fixtureDocument()
  document.metadata.anxRelationships = relationshipState()
  assert.equal(validateDocument(document).ok, true)

  const bytes = await packAndoc({ document })
  const unpacked = await readAndoc(bytes)
  assert.deepEqual(unpacked.document.metadata.anxRelationships, relationshipState())

  const response = await anxRelationships(bytes) as {
    counts: { active: number; humanApproved: number; agentSuggested: number; contentUnavailable: number }
    relationships: Array<{
      id: string
      citation: { uri: string }
      agentUse: { targetContentAvailable: boolean; verificationRequired: boolean; guidance: string }
    }>
    claimBoundary: string
  }
  assert.deepEqual(response.counts, {
    total: 2,
    active: 2,
    removed: 0,
    humanApproved: 1,
    agentSuggested: 1,
    external: 1,
    contentUnavailable: 1,
  })
  const external = response.relationships.find(item => item.id === 'relationship-iso-9001')!
  assert.equal(external.agentUse.targetContentAvailable, false)
  assert.equal(external.agentUse.verificationRequired, true)
  assert.match(external.agentUse.guidance, /do not infer/)
  assert.match(response.claimBoundary, /do not prove the target content/)

  const citation = await andocCite(bytes, 'relationship-iso-9001')
  assert.equal(citation.evidenceType, 'relationship')
  assert.match(citation.uri, /\/relationships\/relationship-iso-9001$/)
})

test('relationship queries are bounded, type-aware, and hide tombstones by default', async () => {
  const document = await fixtureDocument()
  const state = relationshipState()
  state.relationships[1]!.status = 'removed'
  state.relationships[1]!.removedAt = timestamp
  state.relationships[1]!.removedBy = { type: 'human', id: 'reviewer' }
  document.metadata.anxRelationships = state
  const bytes = await packAndoc({ document })

  const active = await anxRelationships(bytes, { types: ['governed-by'] }) as { returned: number }
  assert.equal(active.returned, 1)
  const withRemoved = await anxRelationships(bytes, { includeRemoved: true, limit: 1 }) as {
    returned: number
    truncated: boolean
  }
  assert.equal(withRemoved.returned, 1)
  assert.equal(withRemoved.truncated, true)
})

test('one relationship working set commits as one validated package revision', async () => {
  const document = await fixtureDocument()
  const pkg = await readAndoc(await packAndoc({ document }))
  const state = relationshipState()
  const result = await transactAndocPackage(pkg, {
    schema: 'andoc.transaction.v1',
    id: 'tx-relationship-working-set',
    baseRevision: 0,
    actor: { type: 'human', id: 'local-human-studio' },
    timestamp,
    message: 'Save related documents working set',
    operations: [{ op: 'setDocument', patch: { metadata: { anxRelationships: state } } }],
  })

  assert.equal(result.document.revision, 1)
  assert.deepEqual(result.document.metadata.anxRelationships, state)
  const repacked = await readAndoc(result.packageBytes)
  assert.equal(repacked.transactions.length, 1)
  assert.deepEqual(repacked.document.metadata.anxRelationships, state)
})

test('relationship validation rejects ambiguous availability, unapproved authority, and incomplete tombstones', () => {
  const missingResolvedId = relationshipState()
  delete missingResolvedId.relationships[1]!.resolution.resolvedDocumentId
  assert.match(
    JSON.stringify(validateRelationships(missingResolvedId).issues),
    /relationship_resolved_document_missing/,
  )

  const missingApproval = relationshipState()
  delete missingApproval.relationships[0]!.authority.approvedBy
  assert.match(
    JSON.stringify(validateRelationships(missingApproval).issues),
    /relationship_approval_missing/,
  )

  const incompleteRemoval = relationshipState()
  incompleteRemoval.relationships[0]!.status = 'removed'
  assert.match(
    JSON.stringify(validateRelationships(incompleteRemoval).issues),
    /relationship_removal_missing/,
  )

  const mismatchedAvailability = relationshipState()
  mismatchedAvailability.relationships[0]!.resolution.contentAvailable = true
  assert.match(
    JSON.stringify(validateRelationships(mismatchedAvailability).issues),
    /relationship_content_resolution_mismatch/,
  )
})
