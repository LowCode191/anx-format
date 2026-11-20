import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  addReviewAnnotationTransaction,
  addReviewProposalTransaction,
  AGN_REVIEW_METADATA_KEY,
  andocApply,
  ANX_REGION_CORRECTIONS_METADATA_KEY,
  ANX_RELATIONSHIPS_METADATA_KEY,
  ANX_VIEW_CONTENT_SECURITY_POLICY,
  applyTransaction,
  createStandaloneViewerServer,
  decideReviewProposalTransaction,
  HUMAN_DECISION_METADATA_KEYS,
  HUMAN_ONLY_METADATA_KEYS,
  humanViewStatus,
  packAndoc,
  ProtectedMetadataError,
  readAndoc,
  recordReviewApprovalTransaction,
  releaseControlState,
  sha256,
  validateAndoc,
  verifyAndocFinalization,
  type AndocActor,
  type AndocDocument,
  type AndocManifest,
  type AndocOperation,
  type AndocTransaction,
  type AnxDocumentRelationships,
} from '../src/index.js'
import { confinedPath } from '../src/path-confinement.js'

const workspace = path.resolve(import.meta.dirname, '..')
const timestamp = '2026-11-20T12:00:00.000Z'
const agent: AndocActor = { type: 'agent', id: 'test-agent' }
const human: AndocActor = { type: 'human', id: 'reviewer' }

async function fixtureDocument(): Promise<AndocDocument> {
  return JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8')) as AndocDocument
}

/** Rewrites package entries the way a foreign writer could: bytes changed, manifest hash and size kept honest. */
function rewriteEntries(packageBytes: Uint8Array, changes: Record<string, Uint8Array | null>): Uint8Array {
  const files = unzipSync(packageBytes)
  const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as AndocManifest
  for (const [entryPath, bytes] of Object.entries(changes)) {
    if (bytes === null) {
      delete files[entryPath]
      manifest.entries = manifest.entries.filter(entry => entry.path !== entryPath)
      continue
    }
    files[entryPath] = bytes
    const entry = manifest.entries.find(candidate => candidate.path === entryPath)
    assert(entry, `fixture has no manifest entry for ${entryPath}`)
    entry.sha256 = sha256(bytes)
    entry.size = bytes.length
  }
  files['manifest.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`)
  return zipSync(files)
}

function transaction(document: AndocDocument, actor: AndocActor, operations: AndocOperation[]): AndocTransaction {
  return { schema: 'andoc.transaction.v1', id: `tx-${actor.type}-${document.revision}`, baseRevision: document.revision, actor, timestamp, operations }
}

function setMetadata(document: AndocDocument, actor: AndocActor, metadata: Record<string, unknown>): AndocTransaction {
  return transaction(document, actor, [{ op: 'setDocument', patch: { metadata } }])
}

function assertProtected(run: () => unknown, metadataKey: string): void {
  assert.throws(run, (error: unknown) => {
    assert(error instanceof ProtectedMetadataError, `expected ProtectedMetadataError, got ${String(error)}`)
    assert.equal(error.code, 'PROTECTED_METADATA')
    assert.equal(error.metadataKey, metadataKey)
    return true
  })
}

async function listen(server: ReturnType<typeof createStandaloneViewerServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

/** node:http, not fetch, so the Host header sent is exactly the one given. */
function get(port: number, requestPath: string, host?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path: requestPath, method: 'GET', headers: host ? { host } : {} }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

const hostileView = strToU8('<!doctype html><html><head><title>AGN Sample</title></head><body><h1>AGN Sample</h1><p>HOSTILE-VIEW-MARKER unrelated to the canonical text</p><script>document.title="SCRIPT-RAN"</script></body></html>')

test('a stored view that differs from the canonical document is disclosed and never served', async () => {
  const document = await fixtureDocument()
  const honest = await packAndoc({ document })
  assert.equal(humanViewStatus(await readAndoc(honest)).matchesCanonical, true)

  const hostile = rewriteEntries(honest, { 'views/document.html': hostileView })
  // The stored view is a hash-declared cache. Older packages carry views from older
  // renderers, so a differing view is not a validation failure; it is reported.
  assert.equal((await validateAndoc(hostile)).ok, true)
  const pkg = await readAndoc(hostile)
  const status = humanViewStatus(pkg)
  assert.equal(status.matchesCanonical, false)
  assert.equal(status.storedSha256, sha256(hostileView))
  assert.match(status.guidance, /Render from document\.json/)
  assert.equal((await verifyAndocFinalization(pkg)).humanViewMatchesCanonical, false)

  const server = createStandaloneViewerServer(pkg)
  const port = await listen(server)
  try {
    const view = await get(port, '/view.html')
    assert.equal(view.status, 200)
    assert.doesNotMatch(view.body, /HOSTILE-VIEW-MARKER|SCRIPT-RAN/)
    assert.match(view.body, /data-andoc-id="paragraph-1"/)
    assert.equal(view.headers['content-security-policy'], ANX_VIEW_CONTENT_SECURITY_POLICY)
    assert.match(ANX_VIEW_CONTENT_SECURITY_POLICY, /default-src 'none'/)
    assert.match(ANX_VIEW_CONTENT_SECURITY_POLICY, /sandbox allow-scripts allow-downloads$/)
    assert.doesNotMatch(ANX_VIEW_CONTENT_SECURITY_POLICY, /script-src[^;]*unsafe-inline/)

    // Every inline script the renderer emits must be the one the policy allows by hash.
    const scripts = [...view.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!)
    assert.equal(scripts.length, 1)
    const hash = createHash('sha256').update(scripts[0]!).digest('base64')
    assert(ANX_VIEW_CONTENT_SECURITY_POLICY.includes(`script-src 'sha256-${hash}'`))

    const shell = await get(port, '/')
    assert.match(shell.body, /<iframe[^>]* sandbox="allow-scripts allow-downloads"/)
    assert.doesNotMatch(shell.body, /allow-same-origin/)
    assert.match(String(shell.headers['content-security-policy']), /frame-ancestors 'none'/)

    const canonical = await get(port, '/document.json')
    assert.match(String(canonical.headers['content-security-policy']), /sandbox/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('the viewer refuses unknown Host names and serves non-image assets as downloads', async () => {
  const document = await fixtureDocument()
  const page = strToU8('<html><script>document.title="ASSET-SCRIPT"</script></html>')
  const vector = strToU8('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  document.assets.page = { id: 'page', packagePath: 'assets/page.html', mediaType: 'text/html', sha256: sha256(page), size: page.length }
  document.assets.vector = { id: 'vector', packagePath: 'assets/vector.svg', mediaType: 'image/svg+xml', sha256: sha256(vector), size: vector.length }
  const pkg = await readAndoc(await packAndoc({ document, assets: { page, vector } }))
  const server = createStandaloneViewerServer(pkg)
  const port = await listen(server)
  try {
    for (const requestPath of ['/', '/view.html', '/document.json', '/assets/vector.svg']) {
      assert.equal((await get(port, requestPath, 'evil.example')).status, 403, requestPath)
      assert.equal((await get(port, requestPath, `evil.example:${port}`)).status, 403, requestPath)
      assert.equal((await get(port, requestPath, `127.0.0.1:${port + 1}`)).status, 403, requestPath)
    }
    assert.equal((await get(port, '/health', `localhost:${port}`)).status, 200)
    assert.equal((await get(port, '/health', `127.0.0.1:${port}`)).status, 200)

    const html = await get(port, '/assets/page.html')
    assert.equal(html.status, 200)
    assert.equal(html.headers['content-type'], 'application/octet-stream')
    assert.match(String(html.headers['content-disposition']), /^attachment; filename="page\.html"$/)

    const svg = await get(port, '/assets/vector.svg')
    assert.equal(svg.headers['content-type'], 'image/svg+xml')
    assert.equal(svg.headers['content-disposition'], undefined)
    // Opened directly, an SVG is a document. The sandbox policy stops its script.
    assert.match(String(svg.headers['content-security-policy']), /default-src 'none'.*sandbox$/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('packages without the required history or human-view entry fail validation', async () => {
  const honest = await packAndoc({ document: await fixtureDocument() })
  for (const requiredPath of ['views/document.html', 'revisions/transactions.jsonl']) {
    const result = await validateAndoc(rewriteEntries(honest, { [requiredPath]: null }))
    assert.equal(result.ok, false, requiredPath)
    assert.deepEqual(result.issues.filter(issue => issue.code === 'missing_required_entry').map(issue => issue.path), [requiredPath])
    await assert.rejects(readAndoc(rewriteEntries(honest, { [requiredPath]: null })), /missing_required_entry/)
  }
})

test('an agent cannot write release state, and a human can', async () => {
  const document = await fixtureDocument()
  const forged = { ...releaseControlState(document), state: 'released', releaseRevision: '7' }

  assertProtected(() => applyTransaction(document, setMetadata(document, agent, { anxReleaseControl: forged })), 'anxReleaseControl')
  assertProtected(() => applyTransaction(document, transaction(document, agent, [{ op: 'replaceDocumentMetadata', metadata: { ...document.metadata, anxReleaseControl: forged } }])), 'anxReleaseControl')
  for (const type of ['system', 'import'] as const) {
    assertProtected(() => applyTransaction(document, setMetadata(document, { type, id: 'automation' }, { anxReleaseControl: forged })), 'anxReleaseControl')
  }

  const byHuman = applyTransaction(document, setMetadata(document, human, { anxReleaseControl: forged }))
  assert.equal((byHuman.metadata.anxReleaseControl as { state: string }).state, 'released')
  // Once set by a human, an agent can neither change nor drop it, but unrelated edits still work.
  assertProtected(() => applyTransaction(byHuman, transaction(byHuman, agent, [{ op: 'replaceDocumentMetadata', metadata: { author: 'x' } }])), 'anxReleaseControl')
  const edited = applyTransaction(byHuman, setMetadata(byHuman, agent, { purpose: 'agent note' }))
  assert.equal(edited.metadata.purpose, 'agent note')
  assert.deepEqual(edited.metadata.anxReleaseControl, byHuman.metadata.anxReleaseControl)
})

test('the agent write tool leaves the package untouched when it refuses protected metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'anx-protected-'))
  try {
    const packagePath = path.join(directory, 'document.anx')
    const document = await fixtureDocument()
    await writeFile(packagePath, await packAndoc({ document }))
    const before = sha256(await readFile(packagePath))
    const forged = { ...releaseControlState(document), state: 'released', releaseRevision: '7' }
    await assert.rejects(
      andocApply(packagePath, [{ op: 'setDocument', patch: { metadata: { anxReleaseControl: forged } } }], { baseRevision: 0 }),
      (error: unknown) => error instanceof ProtectedMetadataError && error.actorType === 'agent',
    )
    assert.equal(sha256(await readFile(packagePath)), before)
    assert.equal((await readAndoc(packagePath)).document.revision, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an agent may propose and annotate but not approve, decide or rewrite review records', async () => {
  const document = await fixtureDocument()
  const proposalOperations: AndocOperation[] = [{ op: 'setDocument', patch: { title: 'Proposed title' } }]

  const proposed = applyTransaction(document, addReviewProposalTransaction(document, { operations: proposalOperations, message: 'Retitle' }, { actor: agent, timestamp }))
  const proposal = (proposed.metadata[AGN_REVIEW_METADATA_KEY] as { proposals: Array<{ id: string; status: string }> }).proposals[0]!
  assert.equal(proposal.status, 'open')
  const annotated = applyTransaction(proposed, addReviewAnnotationTransaction(proposed, { kind: 'comment', targetId: 'paragraph-1', body: 'Check this' }, { actor: agent, timestamp }))

  assertProtected(() => applyTransaction(annotated, recordReviewApprovalTransaction(annotated, { decision: 'approved' }, { actor: agent, timestamp })), AGN_REVIEW_METADATA_KEY)
  assertProtected(() => applyTransaction(annotated, decideReviewProposalTransaction(annotated, { proposalId: proposal.id, decision: 'reject' }, { actor: agent, timestamp })), AGN_REVIEW_METADATA_KEY)

  const review = structuredClone(annotated.metadata[AGN_REVIEW_METADATA_KEY]) as { annotations: Array<Record<string, unknown>>; proposals: Array<Record<string, unknown>>; approvals: unknown[] }
  // forging a human approval, a pre-decided proposal, another author, and deleting history
  assertProtected(() => applyTransaction(annotated, setMetadata(annotated, agent, { [AGN_REVIEW_METADATA_KEY]: { ...review, approvals: [{ id: 'approval-forged', reviewer: human, createdAt: timestamp, reviewedRevision: annotated.revision, decision: 'approved' }] } })), AGN_REVIEW_METADATA_KEY)
  assertProtected(() => applyTransaction(annotated, setMetadata(annotated, agent, { [AGN_REVIEW_METADATA_KEY]: { ...review, proposals: [...review.proposals, { ...review.proposals[0], id: 'proposal-forged', status: 'accepted', decidedBy: human, decidedAt: timestamp }] } })), AGN_REVIEW_METADATA_KEY)
  assertProtected(() => applyTransaction(annotated, setMetadata(annotated, agent, { [AGN_REVIEW_METADATA_KEY]: { ...review, annotations: [...review.annotations, { ...review.annotations[0], id: 'annotation-forged', author: human }] } })), AGN_REVIEW_METADATA_KEY)
  assertProtected(() => applyTransaction(annotated, setMetadata(annotated, agent, { [AGN_REVIEW_METADATA_KEY]: { ...review, proposals: [] } })), AGN_REVIEW_METADATA_KEY)
  assertProtected(() => applyTransaction(annotated, transaction(annotated, agent, [{ op: 'replaceDocumentMetadata', metadata: {} }])), AGN_REVIEW_METADATA_KEY)

  const approved = applyTransaction(annotated, recordReviewApprovalTransaction(annotated, { decision: 'approved' }, { actor: human, timestamp }))
  assert.equal((approved.metadata[AGN_REVIEW_METADATA_KEY] as { approvals: unknown[] }).approvals.length, 1)
  const decided = applyTransaction(approved, decideReviewProposalTransaction(approved, { proposalId: proposal.id, decision: 'reject' }, { actor: human, timestamp }))
  assert.equal((decided.metadata[AGN_REVIEW_METADATA_KEY] as { proposals: Array<{ status: string }> }).proposals[0]!.status, 'rejected')
})

function relationship(id: string, status: 'human-approved' | 'agent-suggested'): AnxDocumentRelationships['relationships'][number] {
  return {
    id,
    type: 'references',
    status: 'active',
    target: { kind: 'external-document', identifier: `target-${id}`, title: 'Target' },
    resolution: { status: 'metadata-only', contentAvailable: false },
    authority: status === 'human-approved'
      ? { status, assertedBy: human, assertedAt: timestamp, approvedBy: human, approvedAt: timestamp }
      : { status, assertedBy: agent, assertedAt: timestamp },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

test('an agent may suggest relationships but not approve, alter or remove approved ones', async () => {
  const document = await fixtureDocument()
  const state = (relationships: AnxDocumentRelationships['relationships']): Record<string, unknown> => ({ [ANX_RELATIONSHIPS_METADATA_KEY]: { schema: 'anx.relationships.v1', relationships } })
  const approved = relationship('relationship-approved', 'human-approved')
  const suggested = relationship('relationship-suggested', 'agent-suggested')

  assertProtected(() => applyTransaction(document, setMetadata(document, agent, state([approved]))), ANX_RELATIONSHIPS_METADATA_KEY)
  assertProtected(() => applyTransaction(document, setMetadata(document, agent, state([{ ...suggested, authority: { ...suggested.authority, assertedBy: human } }]))), ANX_RELATIONSHIPS_METADATA_KEY)

  const base = applyTransaction(document, setMetadata(document, human, state([approved])))
  const withSuggestion = applyTransaction(base, setMetadata(base, agent, state([approved, suggested])))
  assert.equal((withSuggestion.metadata[ANX_RELATIONSHIPS_METADATA_KEY] as AnxDocumentRelationships).relationships.length, 2)
  // an agent may revise its own suggestion
  applyTransaction(withSuggestion, setMetadata(withSuggestion, agent, state([approved, { ...suggested, note: 'revised', updatedAt: timestamp }])))

  assertProtected(() => applyTransaction(withSuggestion, setMetadata(withSuggestion, agent, state([suggested]))), ANX_RELATIONSHIPS_METADATA_KEY)
  assertProtected(() => applyTransaction(withSuggestion, setMetadata(withSuggestion, agent, state([{ ...approved, type: 'claims-conformance-to' }, suggested]))), ANX_RELATIONSHIPS_METADATA_KEY)
  assertProtected(() => applyTransaction(withSuggestion, setMetadata(withSuggestion, agent, state([approved, { ...suggested, authority: { ...suggested.authority, status: 'human-approved', approvedBy: human, approvedAt: timestamp } }]))), ANX_RELATIONSHIPS_METADATA_KEY)
  assertProtected(() => applyTransaction(withSuggestion, transaction(withSuggestion, agent, [{ op: 'replaceDocumentMetadata', metadata: {} }])), ANX_RELATIONSHIPS_METADATA_KEY)
})

test('an agent cannot write human page-object corrections, and the guarded keys match the modules that own them', async () => {
  const document = await fixtureDocument()
  assertProtected(() => applyTransaction(document, setMetadata(document, agent, { [ANX_REGION_CORRECTIONS_METADATA_KEY]: { schema: 'anx.region-corrections.v1', entries: [] } })), ANX_REGION_CORRECTIONS_METADATA_KEY)
  assert.deepEqual([...HUMAN_ONLY_METADATA_KEYS], ['anxReleaseControl', ANX_REGION_CORRECTIONS_METADATA_KEY])
  assert.deepEqual([...HUMAN_DECISION_METADATA_KEYS], [AGN_REVIEW_METADATA_KEY, ANX_RELATIONSHIPS_METADATA_KEY])
  assert('anxReleaseControl' in applyTransaction(document, setMetadata(document, human, { anxReleaseControl: releaseControlState(document) })).metadata)
})

test('path confinement follows symbolic links', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'anx-confine-'))
  try {
    const root = path.join(base, 'root')
    const outside = path.join(base, 'outside')
    await mkdir(path.join(root, 'nested'), { recursive: true })
    await mkdir(path.join(root, '..data'))
    await mkdir(outside)
    await writeFile(path.join(root, 'inside.anx'), 'x')
    await writeFile(path.join(root, '..data', 'dotted.anx'), 'x')
    await writeFile(path.join(outside, 'secret.anx'), 'x')
    await symlink(path.join(outside, 'secret.anx'), path.join(root, 'leak.anx'))
    await symlink(outside, path.join(root, 'linked-directory'))
    await symlink(path.join(outside, 'not-created-yet.pdf'), path.join(root, 'dangling.pdf'))
    await symlink(path.join(root, 'inside.anx'), path.join(root, 'alias.anx'))

    assert.equal(confinedPath(root, 'inside.anx'), path.join(root, 'inside.anx'))
    assert.equal(confinedPath(root, path.join(root, 'nested', 'new-output.pdf')), path.join(root, 'nested', 'new-output.pdf'))
    assert.equal(confinedPath(root, 'not/created/yet.anx'), path.join(root, 'not', 'created', 'yet.anx'))
    assert.equal(confinedPath(root, '..data/dotted.anx'), path.join(root, '..data', 'dotted.anx'))
    assert.equal(confinedPath(root, 'alias.anx'), path.join(root, 'alias.anx'))
    assert.equal(confinedPath(root, '.'), root)

    for (const escape of ['../outside/secret.anx', path.join(outside, 'secret.anx'), 'leak.anx', 'linked-directory/secret.anx', 'linked-directory/new.pdf', 'dangling.pdf', 'nested/../../outside/secret.anx']) {
      assert.throws(() => confinedPath(root, escape), /Path is outside the configured ANX workspace/, escape)
    }
    assert.throws(() => confinedPath(path.join(base, 'missing-root'), 'a.anx'), /does not exist/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

for (const server of ['mcp-server', 'evidence-mcp-server']) {
  test(`stdio: ${server} refuses a symbolic link that leaves the allowed root`, { timeout: 60000 }, async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'anx-mcp-link-'))
    const root = path.join(base, 'root')
    await mkdir(root)
    await writeFile(path.join(root, 'inside.anx'), await readFile(path.join(workspace, 'examples/sample.anx')))
    await symlink(path.join(workspace, 'examples/sample.anx'), path.join(root, 'leak.anx'))
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', path.join(workspace, 'src', `${server}.ts`)],
      cwd: workspace, env: { PATH: process.env.PATH || '', ANX_ALLOWED_ROOT: root },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'anx-link-check', version: '1.0.0' })
    const name = server === 'mcp-server' ? 'andoc_open' : 'anx_search'
    const call = (documentPath: string) => client.callTool({ name, arguments: { documentPath, ...(name === 'anx_search' ? { query: 'ANX' } : {}) } })
    try {
      await client.connect(transport)
      assert.notEqual((await call('inside.anx')).isError, true)
      const denied = await call('leak.anx')
      assert.equal(denied.isError, true)
      assert.match(JSON.stringify(denied.content), /outside the configured/)
    } finally {
      await client.close()
      await transport.close()
      await rm(base, { recursive: true, force: true })
    }
  })
}
