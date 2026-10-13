import assert from 'node:assert/strict'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DocumentLockTimeoutError, withDocumentLocks } from '../src/document-lock.js'

test('a recent lock owned by a dead process is recovered without waiting for the age threshold', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-dead-lock-'))
  const documentPath = path.join(root, 'document.agn')
  await writeFile(documentPath, 'fixture')
  const deadPid = deadProcessId()
  await writeFile(`${documentPath}.lock`, JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString(), documentPath }))
  const startedAt = performance.now()
  const result = await withDocumentLocks([documentPath], async () => 'recovered', { staleAfterMs: 60_000, timeoutMs: 500 })
  assert.equal(result, 'recovered')
  assert.ok(performance.now() - startedAt < 500)
  await assert.rejects(stat(`${documentPath}.lock`), /ENOENT/)
})

test('a live lock times out without theft and operation failures still release their lease', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'andoc-live-lock-'))
  const documentPath = path.join(root, 'document.agn')
  await writeFile(documentPath, 'fixture')
  let signalAcquired!: () => void
  let signalRelease!: () => void
  const acquired = new Promise<void>(resolve => { signalAcquired = resolve })
  const release = new Promise<void>(resolve => { signalRelease = resolve })
  const holder = withDocumentLocks([documentPath], async () => {
    signalAcquired()
    await release
  })
  await acquired
  await assert.rejects(
    withDocumentLocks([documentPath], async () => undefined, { staleAfterMs: 60_000, timeoutMs: 75, retryIntervalMs: 5 }),
    error => error instanceof DocumentLockTimeoutError && error.code === 'DOCUMENT_BUSY',
  )
  signalRelease()
  await holder
  await assert.rejects(stat(`${documentPath}.lock`), /ENOENT/)
  await assert.rejects(withDocumentLocks([documentPath], async () => { throw new Error('intentional failure') }), /intentional failure/)
  await assert.rejects(stat(`${documentPath}.lock`), /ENOENT/)
})

function deadProcessId(): number {
  for (let candidate = 900_000; candidate < 1_000_000; candidate += 1) {
    try {
      process.kill(candidate, 0)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return candidate
    }
  }
  throw new Error('Unable to find an unused process id for the lock recovery test')
}
