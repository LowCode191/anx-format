#!/usr/bin/env node
// Downloads every manifest document from its publisher into corpus/sources and
// verifies the recorded SHA-256. Existing files with the right hash are kept.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = import.meta.dirname
const manifest = JSON.parse(await readFile(path.join(root, 'corpus/manifest.json'), 'utf8'))
const userAgent = 'anx-format-benchmark-fetch/1.0 (+https://github.com/LowCode191/anx-format)'
let failures = 0

for (const document of manifest.documents) {
  const target = path.join(root, document.sourcePath)
  await mkdir(path.dirname(target), { recursive: true })
  const existing = await readFile(target).catch(() => null)
  if (existing && sha256(existing) === document.sha256) {
    process.stdout.write(`[fetch] ${document.id} ok (cached)\n`)
    continue
  }
  process.stdout.write(`[fetch] ${document.id} ${document.downloadUrl}\n`)
  try {
    const response = await fetch(document.downloadUrl, { headers: { 'user-agent': userAgent, accept: '*/*' }, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const digest = sha256(bytes)
    if (digest !== document.sha256) throw new Error(`checksum mismatch: expected ${document.sha256}, got ${digest} (${bytes.byteLength} bytes). The publisher may have replaced the file; see the landing page ${document.landingPage}`)
    await writeFile(target, bytes)
    process.stdout.write(`[fetch] ${document.id} ok (${bytes.byteLength} bytes)\n`)
  } catch (error) {
    failures += 1
    process.stderr.write(`[fetch] ${document.id} FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

process.stdout.write(`[fetch] complete: ${manifest.documents.length - failures}/${manifest.documents.length} documents\n`)
if (failures) process.exitCode = 1

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
