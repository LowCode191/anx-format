import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  appendAnxEvidenceTrace,
  citationsFromAnxEvidenceTrace,
  collectAnxEvidenceCitations,
  readAnxEvidenceTrace,
} from '../src/agent-evidence-trace.js'

test('evidence trace records canonical citation fields without copying derivation source citations', async () => {
  const table = 'anx://pdf-123/revisions/0/regions/table-1'
  const note = 'anx://pdf-123/revisions/0/regions/note-1'
  const source = 'anx://pdf-123/revisions/0/blocks/table-1'
  assert.deepEqual(collectAnxEvidenceCitations({
    tables: [{
      citation: table,
      sourceCitations: [source],
      linkedEvidence: [{ citation: note, sourceCitations: [source] }],
    }],
  }), [table, note])

  const directory = await mkdtemp(path.join(tmpdir(), 'anx-evidence-trace-test-'))
  const tracePath = path.join(directory, 'trace.jsonl')
  try {
    await appendAnxEvidenceTrace(tracePath, 'anx_table_evidence', {
      tables: [{
        citation: table,
        sourceCitations: [source],
        linkedEvidence: [{ citation: note }],
      }],
    })
    await appendAnxEvidenceTrace(tracePath, 'anx_cite', { uri: note })
    const records = await readAnxEvidenceTrace(tracePath)
    assert.equal(records.length, 2)
    assert.deepEqual(citationsFromAnxEvidenceTrace(records), [table, note])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
