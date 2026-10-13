import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { ANX_MEDIA_TYPE, createStandaloneViewerServer, evaluateAnxReadConformance, packAnx, readAnx, type AnxDocument } from '../src/index.js'

async function fixturePackage(): Promise<Uint8Array> {
  const document = JSON.parse(await readFile(new URL('../conformance/fixtures/read-core.document.json', import.meta.url), 'utf8')) as AnxDocument
  return packAnx({ document })
}

test('reference conformance runner qualifies a valid core package through ANX-C3', async () => {
  const bytes = await fixturePackage()
  const report = await evaluateAnxReadConformance(bytes, 'ANX-C3')

  assert.equal(report.passed, true)
  assert.equal(report.achievedClass, 'ANX-C3')
  assert.equal(report.schema, 'anx.conformance-report.v1')
  assert.equal(report.documentId, 'anx-conformance-read-core')
  assert.ok(report.checks.every(check => check.passed))
  assert.match(report.claimBoundary, /C4 mapping and C5 editing/)
  assert.equal((await readAnx(bytes)).manifest.mediaType, ANX_MEDIA_TYPE)
})

test('standalone viewer serves only read surfaces for a valid ANX package', async () => {
  const pkg = await readAnx(await fixturePackage())
  const server = createStandaloneViewerServer(pkg)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  const root = `http://127.0.0.1:${port}`
  try {
    const shell = await fetch(`${root}/`)
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /ANX Read Conformance - ANX Viewer/)

    const view = await fetch(`${root}/view.html`)
    assert.equal(view.status, 200)
    assert.match(await view.text(), /data-andoc-id="paragraph-authority"/)

    const canonical = await fetch(`${root}/document.json`)
    assert.equal(canonical.status, 200)
    assert.equal((await canonical.json() as { documentId: string }).documentId, 'anx-conformance-read-core')

    const mutation = await fetch(`${root}/document.json`, { method: 'POST' })
    assert.equal(mutation.status, 405)
    assert.equal(await mutation.text(), 'Read-only viewer')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
