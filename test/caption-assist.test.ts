import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  andocRegions,
  captionAssistedRegionEvidence,
  packAndoc,
  readAndoc,
  type AndocDocument,
} from '../src/index.js'

const encoder = new TextEncoder()

async function fixtureDocument(): Promise<AndocDocument> {
  const document = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8')) as AndocDocument
  document.metadata.layout = { sourcePageSizes: { '1': { width: 612, height: 792 } } }
  document.metadata.anxRegionEvidence = {
    schema: 'anx.region-evidence.v1',
    regions: [{
      id: 'region-figure-parent',
      kind: 'figure',
      page: 1,
      bbox: [60, 100, 500, 400],
      coordinateOrigin: 'TOPLEFT',
      status: 'verified',
      description: 'Agent-native architecture diagram',
      provenance: { method: 'local-extraction', source: 'fixture', verified: true },
    }],
  }
  return document
}

function doclingSource(label = 'caption', text = 'Figure 1: Agent-native architecture.'): Uint8Array {
  return encoder.encode(JSON.stringify({
    texts: [{
      self_ref: '#/texts/0',
      label,
      text,
      prov: [{
        page_no: 1,
        bbox: { l: 70, b: 350, r: 490, t: 380, coord_origin: 'BOTTOMLEFT' },
      }],
    }],
  }))
}

test('Caption Assist verifies explicit retained captions and links only a unique nearby parent', async () => {
  const document = await fixtureDocument()
  const bytes = await packAndoc({
    document,
    sources: { 'sources/docling/document.json': doclingSource() },
  })
  const pkg = await readAndoc(bytes)
  const state = captionAssistedRegionEvidence(pkg)
  const caption = state.regions.find(region => region.structuredData?.captionAssist === true)

  assert.equal(state.captionAssist.sourceCaptions, 1)
  assert.equal(state.captionAssist.explicitSourceLabels, 1)
  assert.equal(state.captionAssist.addedCaptions, 1)
  assert.equal(state.captionAssist.autoVerified, 1)
  assert.equal(state.captionAssist.reviewRequired, 0)
  assert.equal(state.captionAssist.relationshipsResolved, 1)
  assert.equal(state.automaticCanonicalChange, false)
  assert.equal(caption?.kind, 'caption')
  assert.equal(caption?.status, 'verified')
  assert.equal(caption?.unattendedUse, 'allowed')
  assert.equal(caption?.parentRegionId, 'region-figure-parent')
  assert.equal(caption?.structuredData?.parentMatchState, 'unique-compatible-parent')
  assert.equal(caption?.provenance.source, 'sources/docling/document.json')
})

test('Caption Assist keeps prefix-only inferences review-required and does not assert an uncertain parent', async () => {
  const document = await fixtureDocument()
  const primary = (document.metadata.anxRegionEvidence as { regions: Array<Record<string, unknown>> }).regions[0]!
  primary.bbox = [60, 100, 270, 400]
  document.metadata.anxRegionEvidence = {
    schema: 'anx.region-evidence.v1',
    regions: [
      ...(document.metadata.anxRegionEvidence as { regions: unknown[] }).regions,
      {
        id: 'region-figure-secondary',
        kind: 'figure',
        page: 1,
        bbox: [290, 100, 500, 400],
        coordinateOrigin: 'TOPLEFT',
        status: 'verified',
        provenance: { method: 'local-extraction', source: 'fixture', verified: true },
      },
    ],
  }
  const pkg = await readAndoc(await packAndoc({
    document,
    sources: { 'sources/docling/document.json': doclingSource('text') },
  }))
  const state = captionAssistedRegionEvidence(pkg)
  const caption = state.regions.find(region => region.structuredData?.captionAssist === true)

  assert.equal(state.captionAssist.prefixInferences, 1)
  assert.equal(state.captionAssist.reviewRequired, 1)
  assert.equal(state.captionAssist.relationshipsResolved, 0)
  assert.equal(caption?.status, 'candidate')
  assert.equal(caption?.unattendedUse, 'review-required')
  assert.equal(caption?.parentRegionId, undefined)
  assert.equal(caption?.structuredData?.parentMatchState, 'ambiguous-compatible-parent')
  assert.equal(typeof caption?.structuredData?.suggestedParentRegionId, 'string')
})

test('Caption Assist preserves an existing human caption and exposes additions through agent tools', async () => {
  const document = await fixtureDocument()
  const metadataEvidence = document.metadata.anxRegionEvidence as { schema: string; regions: unknown[] }
  metadataEvidence.regions.push({
    id: 'region-human-caption',
    kind: 'caption',
    page: 1,
    bbox: [70, 350, 490, 380],
    coordinateOrigin: 'BOTTOMLEFT',
    status: 'verified',
    description: 'Figure 1: Agent-native architecture.',
    provenance: { method: 'human', source: 'studio', verified: true },
  })
  const root = await mkdtemp(path.join(tmpdir(), 'anx-caption-assist-'))
  const packagePath = path.join(root, 'caption-assist.anx')
  await writeFile(packagePath, await packAndoc({
    document,
    sources: { 'sources/docling/document.json': doclingSource() },
  }))

  const direct = captionAssistedRegionEvidence(await readAndoc(packagePath))
  assert.equal(direct.captionAssist.addedCaptions, 0)
  assert.equal(direct.captionAssist.duplicatesSuppressed, 1)
  assert.equal(direct.regions.filter(region => region.kind === 'caption').length, 1)

  const agent = await andocRegions(packagePath, { kinds: ['caption'] }) as {
    captionAssist: { duplicatesSuppressed: number; automaticCanonicalChange: boolean }
    regions: Array<{ id: string }>
  }
  assert.equal(agent.captionAssist.duplicatesSuppressed, 1)
  assert.equal(agent.captionAssist.automaticCanonicalChange, false)
  assert.deepEqual(agent.regions.map(region => region.id), ['region-human-caption'])
})
