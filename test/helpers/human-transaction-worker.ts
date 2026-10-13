import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { withDocumentLocks } from '../../src/document-lock.js'
import { readAndoc } from '../../src/package.js'
import { transactAndocPackage } from '../../src/revision.js'
import { RevisionConflictError } from '../../src/transaction.js'
import type { AndocTransaction } from '../../src/types.js'

const documentPath = process.argv[2]
if (!documentPath) throw new Error('A document path is required')

try {
  const result = await withDocumentLocks([documentPath], async () => {
    const pkg = await readAndoc(documentPath)
    const transaction: AndocTransaction = {
      schema: 'andoc.transaction.v1',
      id: 'tx-human-concurrent-test',
      baseRevision: 0,
      actor: { type: 'human', id: 'local-human-editor' },
      timestamp: '2026-07-17T12:00:00.000Z',
      message: 'Concurrent human title edit',
      operations: [{ op: 'setDocument', patch: { title: 'Human won the race' } }],
    }
    const applied = await transactAndocPackage(pkg, transaction)
    const temporaryPath = `${documentPath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, applied.packageBytes)
      await rename(temporaryPath, documentPath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
    return { ok: true, revision: applied.document.revision }
  })
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  if (!(error instanceof RevisionConflictError)) throw error
  process.stdout.write(JSON.stringify({
    ok: false,
    code: error.code,
    currentRevision: error.currentRevision,
    baseRevision: error.baseRevision,
  }))
}
