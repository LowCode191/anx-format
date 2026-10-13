import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  composeAnxAgentResponse,
  normalizeAnxAgentModelResponseForHost,
  projectAnxAgentResponseSchemaForProvider,
  requireValidAnxAgentModelResponse,
  requireValidAnxAgentModelResponseV2,
  requireValidAnxAgentResponse,
  validateAnxAgentModelResponse,
  validateAnxAgentModelResponseV2,
  validateAnxAgentResponse,
  validateAnxAgentResponseAgainstTableBundle,
  type AnxAgentModelResponse,
  type AnxAgentResponse,
} from '../src/agent-response.js'

const tableCitation = 'anx://pdf-123/revisions/0/regions/region-table-1'
const noteCitation = 'anx://pdf-123/revisions/0/regions/region-note-1'

function validResponse(): AnxAgentResponse {
  return {
    schema: 'anx.agent-response.v1',
    documentId: 'pdf-123',
    task: {
      id: 'TABLE-T1',
      answer: 'The table has 4 rows and 3 columns and requires review.',
      citations: [tableCitation, noteCitation],
      evidenceJudgment: 'The table is a candidate; its linked note is verified.',
      evidence: {
        schema: 'anx.agent-response-evidence.v1',
        representation: 'anx-native',
        sourceBaseline: {
          status: 'UNVERIFIED_SOURCE',
          trusted: false,
          issuerVerified: false,
        },
        canonicalContentChangedAutomatically: false,
        items: [{
          role: 'primary',
          evidenceId: 'region-table-1',
          citation: tableCitation,
          semanticType: 'table',
          sourceRepresentation: 'mixed',
          dataState: 'structured-unverified',
          textQuality: 'not-applicable',
          evidenceStatus: 'candidate',
          unattendedUse: 'review-required',
          safeForUnattendedAcceptance: false,
          reviewRequired: true,
          dimensions: { rowCount: 4, columnCount: 3, disclosure: 'complete' },
          anchorStatus: 'not-applicable',
        }, {
          role: 'supporting',
          evidenceId: 'region-note-1',
          citation: noteCitation,
          semanticType: 'note',
          sourceRepresentation: 'not-applicable',
          dataState: 'not-applicable',
          textQuality: 'not-applicable',
          evidenceStatus: 'verified',
          unattendedUse: 'allowed',
          safeForUnattendedAcceptance: true,
          reviewRequired: false,
          dimensions: null,
          anchorStatus: 'resolved',
        }],
      },
    },
    limitations: ['Exact table cells remain unverified.'],
  }
}

function validModelResponse(): AnxAgentModelResponse {
  const response = validResponse()
  return {
    schema: 'anx.agent-model-response.v1',
    documentId: response.documentId,
    task: {
      id: response.task.id,
      answer: response.task.answer,
      citations: [...response.task.citations],
      evidenceJudgment: response.task.evidenceJudgment,
    },
    limitations: [...response.limitations],
  }
}

function tableBundle(): Record<string, unknown> {
  return {
    schema: 'anx.table-answer-evidence.v1',
    sourceBaseline: {
      status: 'UNVERIFIED_SOURCE',
      trusted: false,
      issuerVerified: false,
    },
    automaticCanonicalChange: false,
    tables: [{
      id: 'region-table-1',
      dimensions: { rowCount: 4, columnCount: 3, disclosure: 'complete' },
      evidence: {
        status: 'candidate',
        unattendedUse: 'review-required',
        tableEvidence: {
          semanticType: 'table',
          sourceRepresentation: 'mixed',
          dataState: 'structured-unverified',
        },
      },
      citation: tableCitation,
      agentUse: {
        reviewRequired: true,
        safeForUnattendedAcceptance: false,
      },
      linkedEvidence: [{
        id: 'region-note-1',
        kind: 'note',
        evidence: {
          status: 'verified',
          unattendedUse: 'allowed',
          anchorStatus: 'resolved',
        },
        citation: noteCitation,
        agentUse: {
          reviewRequired: false,
          safeForUnattendedAcceptance: true,
        },
      }],
    }],
  }
}

test('agent response schema requires a complete machine evidence envelope', async () => {
  const schema = JSON.parse(await readFile(
    path.join(import.meta.dirname, '../schemas/anx.agent-response.v1.schema.json'),
    'utf8',
  ))
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  const response = validResponse()
  assert.equal(validate(response), true, JSON.stringify(validate.errors))
  assert.equal(validateAnxAgentResponse(response, {
    expectedDocumentId: 'pdf-123',
    expectedTaskId: 'TABLE-T1',
    expectedRevision: 0,
  }).valid, true)

  const incomplete = structuredClone(response) as unknown as {
    task: { evidence: { items: Array<Record<string, unknown>> } }
  }
  delete incomplete.task.evidence.items[0]!.sourceRepresentation
  assert.equal(validate(incomplete), false)
  assert.equal(validateAnxAgentResponse(incomplete).valid, false)
})

test('provider-facing model response is compact and runtime composition restores the full contract', async () => {
  const schema = JSON.parse(await readFile(
    path.join(import.meta.dirname, '../schemas/anx.agent-model-response.v1.schema.json'),
    'utf8',
  ))
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  const modelResponse = validModelResponse()
  assert.equal(validate(modelResponse), true, JSON.stringify(validate.errors))
  assert.equal(validateAnxAgentModelResponse(modelResponse, {
    expectedDocumentId: 'pdf-123',
    expectedTaskId: 'TABLE-T1',
    expectedRevision: 0,
  }).valid, true)
  assert.equal('evidence' in modelResponse.task, false)

  const evidence = validResponse().task.evidence
  const composed = composeAnxAgentResponse(modelResponse, evidence, {
    expectedDocumentId: 'pdf-123',
    expectedTaskId: 'TABLE-T1',
    expectedRevision: 0,
  })
  assert.equal(composed.schema, 'anx.agent-response.v1')
  assert.deepEqual(composed.task.evidence, evidence)
  assert.equal(validateAnxAgentResponse(composed, { expectedRevision: 0 }).valid, true)

  const duplicate = validModelResponse()
  duplicate.task.citations.push(tableCitation)
  assert.throws(
    () => requireValidAnxAgentModelResponse(duplicate),
    /must not contain duplicates/,
  )
  const revisionDrift = validModelResponse()
  revisionDrift.task.citations[0] = 'anx://pdf-123/revisions/7/regions/region-table-1'
  assert.equal(validateAnxAgentModelResponse(revisionDrift, { expectedRevision: 0 }).valid, false)
})

test('v2 provider response delegates the complete machine citation list to deterministic runtime evidence', async () => {
  const schema = JSON.parse(await readFile(
    path.join(import.meta.dirname, '../schemas/anx.agent-model-response.v2.schema.json'),
    'utf8',
  ))
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  const legacy = validModelResponse()
  const modelResponse = {
    schema: 'anx.agent-model-response.v2',
    documentId: legacy.documentId,
    task: {
      id: legacy.task.id,
      answer: legacy.task.answer,
      evidenceJudgment: legacy.task.evidenceJudgment,
    },
    limitations: legacy.limitations,
  }
  assert.equal(validate(modelResponse), true, JSON.stringify(validate.errors))
  assert.equal(requireValidAnxAgentModelResponseV2(modelResponse).schema, 'anx.agent-model-response.v2')
  assert.equal('citations' in modelResponse.task, false)

  const evidence = validResponse().task.evidence
  const composed = composeAnxAgentResponse(modelResponse, evidence, {
    expectedDocumentId: 'pdf-123',
    expectedTaskId: 'TABLE-T1',
    expectedRevision: 0,
  })
  assert.deepEqual(composed.task.citations, evidence.items.map(item => item.citation))
  assert.equal(validateAnxAgentResponse(composed, { expectedRevision: 0 }).valid, true)

  const omittedLegacyCitation = validModelResponse()
  omittedLegacyCitation.task.citations.pop()
  const legacyComposed = composeAnxAgentResponse(omittedLegacyCitation, evidence, {
    expectedRevision: 0,
  })
  assert.deepEqual(legacyComposed.task.citations, evidence.items.map(item => item.citation))
})

test('host normalization owns response identity and separates technical citations from human fields', () => {
  const raw = {
    schema: 'anx.agent-model-response.v2',
    documentId: 'NIST-T3',
    task: {
      id: 'provider-invented-task',
      answer: [
        'The result is supported by',
        '[Revision 0 table evidence](anx://pdf-123/revisions/0/regions/region-table-1).',
        'See (source citation: `anx://pdf-123/revisions/0/regions/region-table-1`).',
        'Normal link: [NIST](https://www.nist.gov/).',
      ].join(' '),
      evidenceJudgment: 'Candidate evidence anx://pdf-123/revisions/0/regions/region-table-1 requires review.',
    },
    limitations: [
      'Machine pointer: anx://pdf-123/revisions/0/regions/region-table-1',
      'No change to https://example.com/reference.',
    ],
  }
  const rawClone = structuredClone(raw)
  const normalized = normalizeAnxAgentModelResponseForHost(raw, {
    expectedDocumentId: 'pdf-123',
    expectedTaskId: 'TABLE-T1',
  })
  assert.deepEqual(raw, rawClone)
  assert.deepEqual(normalized.audit, {
    strategy: 'deterministic-host-v1',
    documentIdentityRebound: true,
    taskIdentityRebound: true,
    technicalCitationsRemoved: 4,
    humanFieldsChanged: 3,
  })
  const response = requireValidAnxAgentModelResponseV2(normalized.response, {
    expectedDocumentId: 'pdf-123',
    expectedTaskId: 'TABLE-T1',
  })
  assert.equal(response.documentId, 'pdf-123')
  assert.equal(response.task.id, 'TABLE-T1')
  assert.doesNotMatch(JSON.stringify(response), /anx:\/\//)
  assert.match(response.task.answer, /Revision 0 table evidence/)
  assert.doesNotMatch(response.task.answer, /source citation/)
  assert.match(response.task.answer, /\[NIST\]\(https:\/\/www\.nist\.gov\/\)/)
  assert.equal(response.limitations[1], 'No change to https://example.com/reference.')
})

test('host normalization does not make malformed provider responses valid', () => {
  const normalized = normalizeAnxAgentModelResponseForHost({
    schema: 'anx.agent-model-response.v2',
    documentId: 'wrong',
    task: {
      id: 'wrong',
      answer: 42,
      evidenceJudgment: 'No citation.',
      unexpected: true,
    },
    limitations: ['Known limitation.'],
  }, {
    expectedDocumentId: 'pdf-123',
    expectedTaskId: 'TABLE-T1',
  })
  assert.equal(
    validateAnxAgentModelResponseV2(normalized.response, {
      expectedDocumentId: 'pdf-123',
      expectedTaskId: 'TABLE-T1',
    }).valid,
    false,
  )
})

test('provider schema projection preserves runtime safety while removing unsupported Codex keywords', async () => {
  const schema = JSON.parse(await readFile(
    path.join(import.meta.dirname, '../schemas/anx.agent-model-response.v1.schema.json'),
    'utf8',
  )) as Record<string, unknown>
  assert.match(JSON.stringify(schema), /"uniqueItems":true/)
  const codexSchema = projectAnxAgentResponseSchemaForProvider(schema, 'codex')
  assert.doesNotMatch(JSON.stringify(codexSchema), /"uniqueItems":true/)
  assert.equal(codexSchema.$schema, undefined)
  assert.equal(codexSchema.$id, undefined)
  assert.equal(
    ((codexSchema.properties as Record<string, Record<string, unknown>>).schema).type,
    'string',
  )
  assert.match(JSON.stringify(schema), /"uniqueItems":true/)

  const duplicate = validResponse()
  duplicate.task.citations.push(tableCitation)
  assert.equal(validateAnxAgentResponse(duplicate).valid, false)
})

test('agent response validator rejects duplicate, unbound, revision-drifted, and contradictory evidence', () => {
  const response = validResponse()
  response.task.citations.push(tableCitation)
  response.task.evidence.items[0]!.safeForUnattendedAcceptance = true
  response.task.evidence.items[1]!.citation = 'anx://pdf-123/revisions/2/regions/region-note-1'
  const result = validateAnxAgentResponse(response, { expectedRevision: 0 })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some(error => error.includes('duplicates')))
  assert.ok(result.errors.some(error => error.includes('cannot be unattended-safe')))
  assert.ok(result.errors.some(error => error.includes('not listed')))
})

test('every human citation maps one-to-one to a unique machine evidence item', () => {
  const missing = validResponse()
  missing.task.evidence.items.pop()
  const missingResult = validateAnxAgentResponse(missing)
  assert.equal(missingResult.valid, false)
  assert.ok(missingResult.errors.some(error => error.includes('has no machine evidence item')))

  const duplicate = validResponse()
  duplicate.task.evidence.items[1] = {
    ...duplicate.task.evidence.items[0]!,
    role: 'supporting',
  }
  const duplicateResult = validateAnxAgentResponse(duplicate)
  assert.equal(duplicateResult.valid, false)
  assert.ok(duplicateResult.errors.some(error => error.includes('duplicate evidenceId')))
  assert.ok(duplicateResult.errors.some(error => error.includes('duplicate citation')))
})

test('table evidence binding validates exact fields and fails closed on an altered disclosure', () => {
  const response = requireValidAnxAgentResponse(validResponse())
  const bound = validateAnxAgentResponseAgainstTableBundle(response, tableBundle())
  assert.deepEqual(bound, {
    valid: true,
    errors: [],
    expectedItems: 2,
    matchedItems: 2,
  })

  response.task.evidence.items[0]!.dataState = 'structured-verified'
  const altered = validateAnxAgentResponseAgainstTableBundle(response, tableBundle())
  assert.equal(altered.valid, false)
  assert.ok(altered.errors.some(error => error.includes('dataState')))

  const wrongRepresentation = validResponse()
  wrongRepresentation.task.evidence.representation = 'source-text'
  const representationResult = validateAnxAgentResponseAgainstTableBundle(
    wrongRepresentation,
    tableBundle(),
  )
  assert.equal(representationResult.valid, false)
  assert.ok(representationResult.errors.some(error => error.includes('representation')))
})
