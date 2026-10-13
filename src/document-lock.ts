import { open, readFile, rm, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export interface DocumentLockOptions {
  retryIntervalMs?: number
  staleAfterMs?: number
  timeoutMs?: number
}

interface DocumentLockLease {
  handle: FileHandle
  lockPath: string
}

export class DocumentLockTimeoutError extends Error {
  readonly code = 'DOCUMENT_BUSY'

  constructor(
    public readonly documentPath: string,
    public readonly timeoutMs: number,
  ) {
    super(`Document remained busy for ${timeoutMs} ms: ${documentPath}`)
    this.name = 'DocumentLockTimeoutError'
  }
}

export async function withDocumentLocks<T>(
  documentPaths: string[],
  operation: () => Promise<T>,
  options: DocumentLockOptions = {},
): Promise<T> {
  const paths = [...new Set(documentPaths.map(value => path.resolve(value)))].sort()
  const leases: DocumentLockLease[] = []
  try {
    for (const documentPath of paths) leases.push(await acquireDocumentLock(documentPath, options))
    return await operation()
  } finally {
    for (const lease of leases.reverse()) await releaseDocumentLock(lease)
  }
}

async function acquireDocumentLock(documentPath: string, options: DocumentLockOptions): Promise<DocumentLockLease> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const retryIntervalMs = options.retryIntervalMs ?? 25
  const staleAfterMs = options.staleAfterMs ?? 60_000
  const lockPath = `${documentPath}.lock`
  const deadline = Date.now() + timeoutMs

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), documentPath }))
        return { handle, lockPath }
      } catch (error) {
        await handle.close()
        await rm(lockPath, { force: true })
        throw error
      }
    } catch (error) {
      if (!isFileExistsError(error)) throw error
      if (await removeStaleLock(lockPath, staleAfterMs)) continue
      if (Date.now() >= deadline) throw new DocumentLockTimeoutError(documentPath, timeoutMs)
      await delay(retryIntervalMs)
    }
  }
}

async function removeStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  try {
    const metadata = await stat(lockPath)
    const oldEnough = Date.now() - metadata.mtimeMs > staleAfterMs
    if (!oldEnough && await lockOwnerMayBeAlive(lockPath)) return false
    await rm(lockPath)
    return true
  } catch (error) {
    if (isFileMissingError(error)) return true
    throw error
  }
}

async function lockOwnerMayBeAlive(lockPath: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown }
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return true
    try {
      process.kill(Number(value.pid), 0)
      return true
    } catch (error) {
      return !isNoSuchProcessError(error)
    }
  } catch {
    // Unknown or partially written leases are governed by the age threshold.
    return true
  }
}

async function releaseDocumentLock(lease: DocumentLockLease): Promise<void> {
  try {
    await lease.handle.close()
  } finally {
    await rm(lease.lockPath, { force: true })
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function isFileMissingError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}
