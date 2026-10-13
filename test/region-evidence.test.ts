import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { andocCite, andocRegions, anxPageEvidence, applyTransaction, packAndoc, regionEvidenceState, validateDocument, type AndocDocument } from '../src/index.js'

async function regionFixture(): Promise<AndocDocument> {
  const document = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures/sample.document.json'), 'utf8')) as AndocDocument
  document.metadata.layout = { sourcePageSizes: { '1': { width: 612, height: 792 }, '2': { width: 612, height: 792 } } }
  document.metadata.anxRegionEvidence = {
    schema: 'anx.region-evidence.v1',
    regions: [
      {
        id: 'region-signature-1', kind: 'signature', page: 2, bbox: [70, 100, 250, 165], coordinateOrigin: 'TOPLEFT', status: 'verified',
        description: 'Handwritten signature above the printed officer name.',
        transcription: 'J. Example',
        provenance: { method: 'human', source: 'source-page-review', verified: true, capturedAt: '2026-07-23T12:00:00.000Z' },
      },
      {
        id: 'region-map-1', kind: 'map', page: 2, bbox: [280, 220, 560, 620], coordinateOrigin: 'TOPLEFT', status: 'abstained',
        description: 'Map labels are too dense for unattended extraction.',
        provenance: { method: 'agent-vision', source: 'local-vision-candidate', verified: false, confidence: 0.42 },
      },
      {
        id: 'bad-region', kind: 'equation', page: 1, bbox: [10, 10, 10, 20], status: 'candidate',
        provenance: { method: 'local-extraction', source: 'fixture', verified: false },
      },
      {
        id: 'region-off-page', kind: 'handwriting', page: 3, bbox: [10, 10, 100, 100], status: 'candidate',
        provenance: { method: 'local-extraction', source: 'fixture', verified: false },
      },
      {
        id: 'region-outside-page', kind: 'figure', page: 2, bbox: [700, 800, 900, 1000], status: 'candidate',
        provenance: { method: 'local-extraction', source: 'fixture', verified: false },
      },
    ],
  }
  const chart = document.blocks.find(block => block.id === 'chart-1')!
  chart.provenance = { kind: 'imported', sourceId: 'source-pdf', sourceUri: 'fixture.pdf', page: 1, bbox: [61.2, 396, 306, 712.8], confidence: 0.9 }
  chart.attrs = { coordinateOrigin: 'BOTTOMLEFT' }
  return document
}

test('region evidence preserves type, geometry, provenance, review state, and explicit abstention', async () => {
  const document = await regionFixture()
  const state = regionEvidenceState(document)

  assert.equal(state.schema, 'anx.region-evidence.v1')
  assert.equal(state.automaticCanonicalChange, false)
  assert.equal(state.summary.total, 3)
  assert.equal(state.summary.byKind.chart, 1)
  assert.equal(state.summary.byKind.signature, 1)
  assert.equal(state.summary.abstained, 1)
  assert.equal(state.summary.reviewRequired, 1)
  assert.equal(state.issues.length, 3)
  assert.match(state.issues[0]!.path, /bad|regions\[2\]\.id/)
  assert.match(state.issues[1]!.message, /exceeds the retained source page count/)
  assert.match(state.issues[2]!.message, /must overlap the retained source page/)

  const chart = state.regions.find(region => region.kind === 'chart')!
  assert.equal(chart.sourceBlockId, 'chart-1')
  assert.equal(chart.unattendedUse, 'review-required')
  assert.deepEqual(chart.displayBox, { leftPercent: 10, topPercent: 10, widthPercent: 40, heightPercent: 40 })
  assert.deepEqual(chart.structuredData, { values: [{ surface: 'human', score: 1 }, { surface: 'agent', score: 1 }] })

  const signature = state.regions.find(region => region.kind === 'signature')!
  assert.equal(signature.status, 'verified')
  assert.equal(signature.unattendedUse, 'allowed')
  assert.equal(signature.identityClaim, 'not-established')

  const map = state.regions.find(region => region.kind === 'map')!
  assert.equal(map.status, 'abstained')
  assert.equal(map.unattendedUse, 'abstain')
  assert.equal(map.sourceBlockId, 'map-1')
  assert.equal(map.structuredData?.sourceBinding, 'stored-region-evidence')
  assert.match(state.claimBoundary, /signer identity/)
})

test('human page-object corrections retype, resize, create, and remove agent-visible regions transactionally', async () => {
  const document = await regionFixture()
  const corrections = {
    schema: 'anx.region-corrections.v1',
    entries: [
      {
        id: 'correction-chart-logo',
        regionId: 'region-chart-1',
        action: 'upsert',
        created: false,
        kind: 'logo',
        page: 1,
        bbox: [20, 30, 220, 150],
        coordinateOrigin: 'TOPLEFT',
        description: 'Human-corrected program logo',
        sourceRevision: 0,
        actor: { type: 'human', id: 'reviewer-1' },
        updatedAt: '2026-07-27T18:00:00.000Z',
      },
      {
        id: 'correction-created-map',
        regionId: 'region-human-map-1',
        action: 'upsert',
        created: true,
        kind: 'map',
        page: 2,
        bbox: [300, 200, 580, 700],
        coordinateOrigin: 'TOPLEFT',
        description: 'Human-created service area map',
        sourceRevision: 0,
        actor: { type: 'human', id: 'reviewer-1' },
        updatedAt: '2026-07-27T18:01:00.000Z',
      },
      {
        id: 'correction-remove-signature',
        regionId: 'region-signature-1',
        action: 'remove',
        created: false,
        kind: 'signature',
        page: 2,
        bbox: [70, 100, 250, 165],
        coordinateOrigin: 'TOPLEFT',
        sourceRevision: 0,
        actor: { type: 'human', id: 'reviewer-1' },
        updatedAt: '2026-07-27T18:02:00.000Z',
      },
    ],
  } as const
  const corrected = applyTransaction(document, {
    schema: 'andoc.transaction.v1',
    id: 'tx-human-region-corrections',
    baseRevision: 0,
    actor: { type: 'human', id: 'reviewer-1' },
    timestamp: '2026-07-27T18:03:00.000Z',
    message: 'Correct page objects',
    operations: [{ op: 'setDocument', patch: { metadata: { anxRegionCorrections: corrections } } }],
  })
  const validation = validateDocument(corrected)
  assert.equal(validation.ok, true)

  const state = regionEvidenceState(corrected)
  const logo = state.regions.find(region => region.id === 'region-chart-1')!
  assert.equal(logo.kind, 'logo')
  assert.deepEqual(logo.bbox, [20, 30, 220, 150])
  assert.equal(logo.status, 'verified')
  assert.equal(logo.unattendedUse, 'allowed')
  assert.equal(logo.provenance.method, 'human')
  assert.equal(logo.structuredData?.regionCorrectionAction, 'human-adjusted')

  const map = state.regions.find(region => region.id === 'region-human-map-1')!
  assert.equal(map.kind, 'map')
  assert.equal(map.status, 'verified')
  assert.equal(map.structuredData?.regionCorrectionAction, 'human-created')
  assert.equal(state.regions.some(region => region.id === 'region-signature-1'), false)

  const root = await mkdtemp(path.join(tmpdir(), 'anx-human-region-correction-'))
  const documentPath = path.join(root, 'corrected.anx')
  await writeFile(documentPath, await packAndoc({ document: corrected }))
  const agentPage = await anxPageEvidence(documentPath, 1, { kinds: ['logo'] }) as {
    regions: Array<{ id: string; kind: string; agentUse: { safeForUnattendedAcceptance: boolean } }>
  }
  assert.deepEqual(agentPage.regions.map(region => [region.id, region.kind]), [['region-chart-1', 'logo']])
  assert.equal(agentPage.regions[0]?.agentUse.safeForUnattendedAcceptance, true)
})

test('human-created captions remain visible semantic parts without duplicating canonical block text', async () => {
  const document = await regionFixture()
  const corrected = applyTransaction(document, {
    schema: 'andoc.transaction.v1',
    id: 'tx-human-caption-region',
    baseRevision: 0,
    actor: { type: 'human', id: 'reviewer-1' },
    timestamp: '2026-07-27T18:04:00.000Z',
    message: 'Add missing caption geometry',
    operations: [{
      op: 'setDocument',
      patch: {
        metadata: {
          anxRegionCorrections: {
            schema: 'anx.region-corrections.v1',
            entries: [{
              id: 'correction-created-caption',
              regionId: 'region-human-caption-1',
              action: 'upsert',
              created: true,
              kind: 'caption',
              page: 1,
              bbox: [62, 720, 300, 748],
              coordinateOrigin: 'TOPLEFT',
              description: 'Figure 1. Agent-native document architecture.',
              sourceRevision: 0,
              actor: { type: 'human', id: 'reviewer-1' },
              updatedAt: '2026-07-27T18:04:00.000Z',
            }],
          },
        },
      },
    }],
  })

  const caption = regionEvidenceState(corrected, { page: 1, kinds: ['caption'], includeParts: false }).regions[0]
  assert.equal(caption?.kind, 'caption')
  assert.equal(caption?.semanticLevel, 'part')
  assert.equal(caption?.defaultVisibility, 'visible')
  assert.equal(caption?.description, 'Figure 1. Agent-native document architecture.')
  assert.equal(caption?.structuredData?.regionRole, 'caption')
  assert.equal(caption?.structuredData?.regionCorrectionAction, 'human-created')
  assert.equal(caption?.unattendedUse, 'allowed')
})

test('human-created text recovery distinguishes transcribed text from geometry-only review evidence', async () => {
  const document = await regionFixture()
  const corrected = applyTransaction(document, {
    schema: 'andoc.transaction.v1',
    id: 'tx-human-text-recovery',
    baseRevision: 0,
    actor: { type: 'human', id: 'reviewer-1' },
    timestamp: '2026-07-27T20:14:00.000Z',
    message: 'Recover missing text regions',
    operations: [{
      op: 'setDocument',
      patch: {
        metadata: {
          anxRegionCorrections: {
            schema: 'anx.region-corrections.v1',
            entries: [
              {
                id: 'correction-created-text-transcribed',
                regionId: 'region-human-text-transcribed',
                action: 'upsert',
                created: true,
                kind: 'text',
                page: 1,
                bbox: [62, 650, 420, 690],
                coordinateOrigin: 'TOPLEFT',
                description: 'This paragraph was missing from the imported text layer.',
                sourceRevision: 0,
                actor: { type: 'human', id: 'reviewer-1' },
                updatedAt: '2026-07-27T20:14:00.000Z',
              },
              {
                id: 'correction-created-text-geometry',
                regionId: 'region-human-text-geometry',
                action: 'upsert',
                created: true,
                kind: 'text',
                page: 1,
                bbox: [62, 700, 420, 735],
                coordinateOrigin: 'TOPLEFT',
                sourceRevision: 0,
                actor: { type: 'human', id: 'reviewer-1' },
                updatedAt: '2026-07-27T20:14:00.000Z',
              },
            ],
          },
        },
      },
    }],
  })

  const state = regionEvidenceState(corrected, { page: 1, kinds: ['text'] })
  const transcribed = state.regions.find(region => region.id === 'region-human-text-transcribed')
  const geometryOnly = state.regions.find(region => region.id === 'region-human-text-geometry')
  assert.equal(transcribed?.status, 'verified')
  assert.equal(transcribed?.unattendedUse, 'allowed')
  assert.equal(transcribed?.description, 'This paragraph was missing from the imported text layer.')
  assert.equal(transcribed?.structuredData?.regionRole, 'text-recovery')
  assert.equal(transcribed?.structuredData?.textRecoveryState, 'human-transcribed')
  assert.equal(geometryOnly?.status, 'candidate')
  assert.equal(geometryOnly?.unattendedUse, 'review-required')
  assert.equal(geometryOnly?.description, undefined)
  assert.equal(geometryOnly?.structuredData?.regionRole, 'text-recovery')
  assert.equal(geometryOnly?.structuredData?.textRecoveryState, 'geometry-only')
  assert.equal(state.summary.byKind.text, 2)
})

test('human-created Note regions expose footnote/endnote subtype and require both text and a stable anchor for unattended use', async () => {
  const document = await regionFixture()
  const corrected = applyTransaction(document, {
    schema: 'andoc.transaction.v1',
    id: 'tx-human-note-regions',
    baseRevision: 0,
    actor: { type: 'human', id: 'reviewer-1' },
    timestamp: '2026-07-27T21:00:00.000Z',
    message: 'Recover linked notes',
    operations: [{
      op: 'setDocument',
      patch: {
        metadata: {
          anxRegionCorrections: {
            schema: 'anx.region-corrections.v1',
            entries: [
              {
                id: 'correction-created-footnote',
                regionId: 'region-human-footnote',
                action: 'upsert',
                created: true,
                kind: 'note',
                noteKind: 'footnote',
                anchorBlockId: 'paragraph-1',
                page: 1,
                bbox: [62, 690, 420, 720],
                coordinateOrigin: 'TOPLEFT',
                description: '1. Values are unaudited.',
                sourceRevision: 0,
                actor: { type: 'human', id: 'reviewer-1' },
                updatedAt: '2026-07-27T21:00:00.000Z',
              },
              {
                id: 'correction-created-endnote',
                regionId: 'region-human-endnote',
                action: 'upsert',
                created: true,
                kind: 'note',
                noteKind: 'endnote',
                page: 1,
                bbox: [62, 730, 420, 760],
                coordinateOrigin: 'TOPLEFT',
                description: 'A. Supplemental release condition.',
                sourceRevision: 0,
                actor: { type: 'human', id: 'reviewer-1' },
                updatedAt: '2026-07-27T21:01:00.000Z',
              },
            ],
          },
        },
      },
    }],
  })

  const state = regionEvidenceState(corrected, { page: 1, kinds: ['note'] })
  const footnote = state.regions.find(region => region.id === 'region-human-footnote')
  const endnote = state.regions.find(region => region.id === 'region-human-endnote')
  assert.equal(footnote?.status, 'verified')
  assert.equal(footnote?.unattendedUse, 'allowed')
  assert.equal(footnote?.structuredData?.noteKind, 'footnote')
  assert.deepEqual(footnote?.structuredData?.anchorBlockIds, ['paragraph-1'])
  assert.equal(footnote?.structuredData?.anchorStatus, 'resolved')
  assert.equal(endnote?.status, 'candidate')
  assert.equal(endnote?.unattendedUse, 'review-required')
  assert.equal(endnote?.structuredData?.noteKind, 'endnote')
  assert.equal(endnote?.structuredData?.anchorStatus, 'unanchored')
  assert.equal(state.summary.byKind.note, 2)
})

test('region correction validation rejects duplicate targets, empty boxes, and future source revisions', async () => {
  const document = await regionFixture()
  document.metadata.anxRegionCorrections = {
    schema: 'anx.region-corrections.v1',
    entries: [
      {
        id: 'correction-one',
        regionId: 'region-chart-1',
        action: 'upsert',
        created: false,
        kind: 'chart',
        page: 1,
        bbox: [20, 20, 20, 80],
        coordinateOrigin: 'TOPLEFT',
        sourceRevision: 9,
        actor: { type: 'human', id: 'reviewer-1' },
        updatedAt: '2026-07-27T18:00:00.000Z',
      },
      {
        id: 'correction-two',
        regionId: 'region-chart-1',
        action: 'remove',
        created: false,
        kind: 'chart',
        page: 1,
        bbox: [20, 20, 80, 80],
        coordinateOrigin: 'TOPLEFT',
        sourceRevision: 0,
        actor: { type: 'human', id: 'reviewer-1' },
        updatedAt: '2026-07-27T18:01:00.000Z',
      },
    ],
  }
  const validation = validateDocument(document)
  assert.equal(validation.ok, false)
  assert.ok(validation.issues.some(issue => issue.code === 'empty_region_correction_bbox'))
  assert.ok(validation.issues.some(issue => issue.code === 'future_region_correction_revision'))
  assert.ok(validation.issues.some(issue => issue.code === 'duplicate_region_correction_target'))
})

test('region evidence queries stay compact, page-bound, and agent-readable', async () => {
  const document = await regionFixture()
  const root = await mkdtemp(path.join(tmpdir(), 'anx-regions-'))
  const documentPath = path.join(root, 'regions.anx')
  await writeFile(documentPath, await packAndoc({ document }))

  const result = await andocRegions(documentPath, { page: 2, kinds: ['signature', 'map'] }) as {
    document: { id: string; revision: number }
    regions: Array<{ kind: string; page: number; unattendedUse: string }>
    summary: { total: number }
    automaticCanonicalChange: boolean
  }
  assert.deepEqual(result.document, { id: 'agn-sample', revision: 0, title: 'AGN Sample' })
  assert.equal(result.summary.total, 2)
  assert.deepEqual(result.regions.map(region => region.kind), ['signature', 'map'])
  assert.ok(result.regions.every(region => region.page === 2))
  assert.deepEqual(result.regions.map(region => region.unattendedUse), ['allowed', 'abstain'])
  assert.equal(result.automaticCanonicalChange, false)
})

test('page evidence binds canonical text and visual claims to independently resolvable citations', async () => {
  const document = await regionFixture()
  const paragraph = document.blocks.find(block => block.id === 'paragraph-1')!
  paragraph.provenance = {
    kind: 'imported',
    sourceUri: 'fixture.pdf',
    page: 2,
    bbox: [70, 180, 540, 220],
  }
  const root = await mkdtemp(path.join(tmpdir(), 'anx-page-evidence-'))
  const documentPath = path.join(root, 'page-evidence.anx')
  await writeFile(documentPath, await packAndoc({ document }))

  const result = await anxPageEvidence(documentPath, 2, {
    kinds: ['signature', 'map'],
    mode: 'standard',
  }) as {
    schema: string
    page: number
    textQuality: string
    blocks: Array<{ nodeId: string; citation: { uri: string } }>
    regions: Array<{
      id: string
      citation: { uri: string; regionId: string; evidenceType: string; unattendedUse: string }
      agentUse: { directCitation: string; reviewRequired: boolean; safeForUnattendedAcceptance: boolean }
    }>
    summary: { canonicalBlocks: number; semanticRegions: number; reviewRequiredRegions: number; abstainedRegions: number }
    automaticCanonicalChange: boolean
    citationGuidance: string
  }

  assert.equal(result.schema, 'anx.page-evidence.v1')
  assert.equal(result.page, 2)
  assert.equal(result.blocks[0]?.nodeId, 'paragraph-1')
  assert.match(result.blocks[0]!.citation.uri, /\/blocks\/paragraph-1$/)
  assert.deepEqual(result.regions.map(region => region.id), ['region-signature-1', 'region-map-1'])
  assert.ok(result.regions.every(region => region.citation.evidenceType === 'region'))
  assert.match(result.regions[0]!.citation.uri, /\/regions\/region-signature-1$/)
  assert.equal(result.regions[0]!.agentUse.directCitation, result.regions[0]!.citation.uri)
  assert.equal(result.regions[0]!.agentUse.safeForUnattendedAcceptance, true)
  assert.equal(result.regions[1]!.agentUse.safeForUnattendedAcceptance, false)
  assert.equal(result.summary.canonicalBlocks, 1)
  assert.equal(result.summary.semanticRegions, 2)
  assert.equal(result.summary.reviewRequiredRegions, 0)
  assert.equal(result.summary.abstainedRegions, 1)
  assert.equal(result.automaticCanonicalChange, false)
  assert.match(result.citationGuidance, /contextual block citations as substitutes/)

  const resolved = await andocCite(documentPath, 'region-signature-1')
  assert.equal(resolved.uri, result.regions[0]!.citation.uri)
  assert.equal('regionId' in resolved ? resolved.regionId : null, 'region-signature-1')
})

test('page evidence budgets long pages while retaining headings and source order', async () => {
  const document = await regionFixture()
  document.blocks = Array.from({ length: 60 }, (_, index): AndocDocument['blocks'][number] => ({
    id: `page-block-${index + 1}`,
    type: index === 55 ? 'heading' : 'paragraph',
    ...(index === 55 ? { level: 2 as const } : {}),
    content: [{ text: index === 55 ? 'Late critical section' : `Routine page text ${index + 1}` }],
    provenance: { kind: 'imported', sourceUri: 'fixture.pdf', page: 2, bbox: [40, 40 + index, 560, 50 + index] },
  }))
  const root = await mkdtemp(path.join(tmpdir(), 'anx-page-budget-'))
  const documentPath = path.join(root, 'page-budget.anx')
  await writeFile(documentPath, await packAndoc({ document }))

  const result = await anxPageEvidence(documentPath, 2) as {
    blocks: Array<{ nodeId: string }>
    summary: { canonicalBlocks: number; returnedBlocks: number; blocksTruncated: boolean; blockSelection: string }
  }
  assert.equal(result.summary.canonicalBlocks, 60)
  assert.equal(result.summary.returnedBlocks, 32)
  assert.equal(result.summary.blocksTruncated, true)
  assert.ok(result.blocks.some(block => block.nodeId === 'page-block-56'))
  assert.deepEqual(
    result.blocks.map(block => Number.parseInt(block.nodeId.replace('page-block-', ''), 10)),
    [...result.blocks.map(block => Number.parseInt(block.nodeId.replace('page-block-', ''), 10))].sort((left, right) => left - right),
  )
  assert.match(result.summary.blockSelection, /bounded-priority/)
})

test('region evidence uses only explicit retained semantic labels for derived image types', async () => {
  const document = await regionFixture()
  document.blocks.push(
    {
      id: 'image-explicit-map',
      type: 'image',
      assetId: 'asset-missing-map',
      alt: 'geographical_map from page 2',
      provenance: { kind: 'imported', sourceUri: 'fixture.pdf', page: 2, bbox: [20, 20, 300, 300] },
    },
    {
      id: 'image-unlabeled-signature',
      type: 'image',
      assetId: 'asset-missing-signature',
      alt: 'Imported visual from page 2',
      provenance: { kind: 'imported', sourceUri: 'fixture.pdf', page: 2, bbox: [320, 20, 500, 80] },
    },
  )

  const state = regionEvidenceState(document, { page: 2 })
  const map = state.regions.find(region => region.sourceBlockId === 'image-explicit-map')!
  const unlabeled = state.regions.find(region => region.sourceBlockId === 'image-unlabeled-signature')!

  assert.equal(map.kind, 'map')
  assert.equal(map.unattendedUse, 'review-required')
  assert.equal(unlabeled.kind, 'figure')
  assert.equal(unlabeled.identityClaim, undefined)
})

test('canonical table geometry replaces duplicate picture-table evidence', async () => {
  const document = await regionFixture()
  const table = document.blocks.find(block => block.id === 'table-1')
  assert.ok(table?.type === 'table')
  table.provenance = { kind: 'imported', sourceUri: 'fixture.pdf', page: 2, bbox: [60, 300, 560, 620] }
  table.attrs = { coordinateOrigin: 'BOTTOMLEFT' }
  const stored = document.metadata.anxRegionEvidence as { regions: Array<Record<string, unknown>> }
  stored.regions.push({
    id: 'region-picture-table-duplicate',
    kind: 'figure',
    page: 2,
    bbox: [60, 300, 560, 620],
    coordinateOrigin: 'BOTTOMLEFT',
    status: 'verified',
    description: 'table from page 2',
    structuredData: {
      regionRole: 'docling-source-visual',
      rawVisualClass: 'table',
      pictureReference: '#/pictures/2',
      sourceGeometry: 'pdf-image-placement',
    },
    provenance: { method: 'human', source: 'studio-table-classification', verified: true, notes: 'A human verified semantic Table type and geometry, not extracted cell values.' },
  })

  const state = regionEvidenceState(document, { page: 2 })
  const tables = state.regions.filter(region => region.kind === 'table')
  assert.equal(tables.length, 1)
  assert.equal(tables[0]?.sourceBlockId, 'table-1')
  assert.equal(tables[0]?.description, 'Machine-readable table')
  assert.equal(tables[0]?.structuredData?.regionRole, 'canonical-table')
  assert.equal(tables[0]?.structuredData?.rowCount, 3)
  assert.equal(tables[0]?.structuredData?.columnCount, 2)
  assert.equal(tables[0]?.structuredData?.tableId, 'table-1')
  assert.equal(tables[0]?.structuredData?.coincidentPictureTableEvidence, true)
  assert.deepEqual(tables[0]?.structuredData?.tableEvidence, {
    schema: 'anx.table-evidence.v1',
    semanticType: 'table',
    sourceRepresentation: 'image-based-with-structured-extraction',
    dataState: 'structured-unverified',
    cellStructureAvailable: true,
    cellStructureVerified: false,
    agentUse: 'source-review-required',
    guidance: 'Machine-structured cells are available, but exact values and spans require source review before quoting, comparison, or calculation.',
  })
  assert.equal(state.regions.some(region => region.id === 'region-picture-table-duplicate'), false)
})

test('table evidence separates an image-based semantic table from verified cell structure', async () => {
  const document = await regionFixture()
  const stored = document.metadata.anxRegionEvidence as { regions: Array<Record<string, unknown>> }
  stored.regions.push({
    id: 'region-picture-table-image-only',
    kind: 'table',
    page: 2,
    bbox: [80, 220, 520, 460],
    coordinateOrigin: 'BOTTOMLEFT',
    status: 'observed',
    description: 'Table 7. Screenshot of the source comparison matrix.',
    structuredData: {
      regionRole: 'docling-source-visual',
      rawVisualClass: 'table',
      pictureReference: '#/pictures/7',
      sourceGeometry: 'pdf-image-placement',
    },
    provenance: { method: 'imported', source: 'fixture.pdf', verified: false, notes: 'Docling classification: table' },
  })

  const state = regionEvidenceState(document, { page: 2 })
  const imageTable = state.regions.find(region => region.id === 'region-picture-table-image-only')
  assert.ok(imageTable)
  assert.deepEqual(imageTable.structuredData?.tableEvidence, {
    schema: 'anx.table-evidence.v1',
    semanticType: 'table',
    sourceRepresentation: 'image-based',
    dataState: 'visual-only',
    cellStructureAvailable: false,
    cellStructureVerified: false,
    agentUse: 'extraction-required',
    guidance: 'This is semantically a table but is retained as image evidence only. Do not infer, quote, compare, or calculate cell values until extraction and verification are complete.',
  })

  const root = await mkdtemp(path.join(tmpdir(), 'anx-image-table-'))
  const packagePath = path.join(root, 'image-table.anx')
  await writeFile(packagePath, await packAndoc({ document }))
  const pageEvidence = await anxPageEvidence(packagePath, 2, { kinds: ['table'] }) as {
    regions: Array<{
      id: string
      structuredData: { tableEvidence: { dataState: string } }
      agentUse: { instruction: string; reviewRequired: boolean; safeForUnattendedAcceptance: boolean }
    }>
  }
  const agentTable = pageEvidence.regions.find(region => region.id === 'region-picture-table-image-only')
  assert.equal(agentTable?.structuredData.tableEvidence.dataState, 'visual-only')
  assert.equal(agentTable?.agentUse.reviewRequired, true)
  assert.equal(agentTable?.agentUse.safeForUnattendedAcceptance, false)
  assert.match(agentTable?.agentUse.instruction || '', /Do not infer, quote, compare, or calculate cell values/)
})

test('overlapping canonical table and visual objects coalesce into one source-bound page object', async () => {
  const document = await regionFixture()
  const table = document.blocks.find(block => block.id === 'table-1')
  assert.ok(table?.type === 'table')
  table.provenance = { kind: 'imported', sourceUri: 'fixture.pdf', page: 2, bbox: [60, 300, 560, 620] }
  table.attrs = { coordinateOrigin: 'BOTTOMLEFT' }
  document.blocks.push({
    id: 'image-figure-table',
    type: 'image',
    assetId: 'asset-source-pdf',
    alt: 'Figure 4. Signals generated from a fan-out of hypothesized words.',
    caption: [{ text: 'Figure 4. Signals generated from a fan-out of hypothesized words.' }],
    provenance: { kind: 'imported', sourceUri: 'fixture.pdf', page: 2, bbox: [60, 300, 560, 620] },
    attrs: { coordinateOrigin: 'BOTTOMLEFT' },
  })

  const state = regionEvidenceState(document, { page: 2 })
  const merged = state.regions.find(region => region.id === 'region-image-figure-table')

  assert.ok(merged)
  assert.equal(state.regions.some(region => region.id === 'region-table-1'), false)
  assert.equal(merged.kind, 'figure')
  assert.equal(merged.status, 'observed')
  assert.equal(merged.unattendedUse, 'review-required')
  assert.deepEqual(merged.sourceBlockIds, ['image-figure-table', 'table-1'])
  assert.deepEqual(merged.structuredData?.mergedSourceBlockIds, ['image-figure-table', 'table-1'])
  assert.deepEqual(merged.structuredData?.mergedKinds, ['figure', 'table'])
  assert.match(merged.provenance.notes || '', /Coalesced overlapping figure and table/)
})

test('four-panel captions disclose one observed panel, a parent group, and three inferred panel candidates', async () => {
  const document = await regionFixture()
  document.blocks.push({
    id: 'chart-four-panel',
    type: 'chart',
    alt: 'Four component charts',
    caption: [{ text: 'Figure 2. Annual demand for (clockwise from top left) turbines, foundations, vessels, and cables.' }],
    spec: { schema: 'andoc.chart.v1', chartType: 'bar-chart', data: null },
    provenance: { kind: 'imported', sourceUri: 'fixture.pdf', page: 1, bbox: [78, 392, 305, 550], confidence: 0.99 },
    attrs: { coordinateOrigin: 'BOTTOMLEFT' },
  })

  const state = regionEvidenceState(document, { page: 1 })
  const related = state.regions.filter(region => region.sourceBlockId === 'chart-four-panel')
  const parent = related.find(region => region.structuredData?.regionRole === 'multi-panel-parent-candidate')
  const inferred = related.filter(region => region.structuredData?.regionRole === 'multi-panel-child-candidate')

  assert.equal(related.length, 5)
  assert.equal(related.filter(region => region.status === 'observed').length, 1)
  assert.equal(parent?.kind, 'figure')
  assert.equal(parent?.status, 'candidate')
  assert.equal(parent?.structuredData?.expectedPanelCount, 4)
  assert.equal(inferred.length, 3)
  assert.ok(inferred.every(region => region.kind === 'chart' && region.status === 'candidate'))
  assert.match(state.claimBoundary, /Inferred multi-panel candidates are disclosed/)
})

test('explicit left and right captions disclose the missing horizontal panel as a review-required candidate', async () => {
  const document = await regionFixture()
  document.blocks.push({
    id: 'chart-horizontal-pair',
    type: 'chart',
    alt: 'Cable throughput pair',
    caption: [{ text: 'Figure A7. Array cables (left) and export cables (right).' }],
    spec: { schema: 'andoc.chart.v1', chartType: 'bar-chart', data: null },
    provenance: { kind: 'imported', sourceUri: 'fixture.pdf', page: 2, bbox: [77.5, 143.28, 300.42, 315.76], confidence: 0.51 },
    attrs: { coordinateOrigin: 'BOTTOMLEFT' },
  })

  const state = regionEvidenceState(document, { page: 2 })
  const related = state.regions.filter(region => region.sourceBlockId === 'chart-horizontal-pair')
  const parent = related.find(region => region.structuredData?.regionRole === 'multi-panel-parent-candidate')
  const inferred = related.find(region => region.structuredData?.regionRole === 'multi-panel-child-candidate')

  assert.equal(related.length, 3)
  assert.equal(related.filter(region => region.status === 'observed').length, 1)
  assert.equal(parent?.structuredData?.expectedPanelCount, 2)
  assert.equal(inferred?.kind, 'chart')
  assert.equal(inferred?.status, 'candidate')
  assert.equal(inferred?.unattendedUse, 'review-required')
  assert.deepEqual(inferred?.bbox, [311.58, 143.28, 534.5, 315.76])
  assert.match(inferred?.provenance.notes || '', /mirrored/)
})
