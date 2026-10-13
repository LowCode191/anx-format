import assert from 'node:assert/strict'
import test from 'node:test'
import { strToU8 } from 'fflate'
import { normalizeDoclingDocument, type DoclingDocument } from '../src/import-pdf.js'
import { PDF_PAGE_OBJECT_ANALYSIS_SCHEMA, type PdfPageObjectAnalysis } from '../src/pdf-page-objects.js'
import { regionEvidenceState } from '../src/region-evidence.js'

const pageSize = { width: 1224, height: 792 }

function provenance(page: number, bbox: [number, number, number, number]) {
  return [{ page_no: page, bbox: { l: bbox[0], b: bbox[1], r: bbox[2], t: bbox[3], coord_origin: 'BOTTOMLEFT' } }]
}

function picture(
  self_ref: string,
  page: number,
  bbox: [number, number, number, number],
  className: string,
  confidence: number,
  description = '',
) {
  return {
    self_ref,
    label: 'picture',
    prov: provenance(page, bbox),
    meta: {
      classification: { predictions: [{ class_name: className, confidence }] },
      ...(description ? { description: { text: description, created_by: 'regression-fixture' } } : {}),
    },
  }
}

function text(
  self_ref: string,
  page: number,
  bbox: [number, number, number, number],
  value: string,
  label = 'text',
) {
  return { self_ref, label, text: value, prov: provenance(page, bbox) }
}

test('NASA spread regressions preserve source hierarchy, tables, and composite figures', () => {
  const docling: DoclingDocument = {
    schema_name: 'DoclingDocument',
    version: '1.8.0',
    name: 'NASA page-object regression',
    pages: Object.fromEntries([8, 9, 10, 12, 28].map(page => [String(page), { page_no: page, size: pageSize }])),
    pictures: [
      picture('#/pictures/p8-inset', 8, [984, 206, 1195, 356], 'photograph', 0.86),
      picture('#/pictures/p9-flat', 9, [2, 5, 1222, 385], 'screenshot_from_computer', 0.35),
      picture('#/pictures/p10-left', 10, [3, 80, 613, 385], 'screenshot_from_manual', 0.49),
      picture('#/pictures/p10-right', 10, [612, 80, 1224, 385], 'photograph', 0.77),
      picture('#/pictures/p28-icon', 28, [703, 135, 760, 193], 'icon', 0.96),
    ],
    texts: [
      text('#/texts/p28-title', 28, [332, 181, 481, 194], 'Guiding Values & Principles', 'section_header'),
      text('#/texts/p28-h1', 28, [252, 144, 286, 162], 'Embrace Change', 'section_header'),
      text('#/texts/p28-h2', 28, [316, 144, 359, 170], 'Deliver Value Early and Often'),
      text('#/texts/p28-h3', 28, [381, 144, 429, 170], 'Collaborate with Stakeholders'),
      text('#/texts/p28-h4', 28, [448, 144, 482, 162], 'Empower Teams', 'section_header'),
      text('#/texts/p28-h5', 28, [513, 144, 550, 162], 'Measure and Learn', 'section_header'),
      text('#/texts/p28-b1', 28, [251, 55, 297, 131], 'Be flexible and adaptable. Welcome change as an opportunity to improve by continuously adapting plans based on feedback.'),
      text('#/texts/p28-b2', 28, [316, 48, 364, 131], 'Plan and break down work into small manageable chunks and deliver working products frequently to meet customer needs.'),
      text('#/texts/p28-b3', 28, [380, 48, 428, 132], 'Work with stakeholders to communicate regularly about progress and plans so they remain aligned and contribute to goals.'),
      text('#/texts/p28-b4', 28, [448, 55, 497, 131], 'An agile team is self-organizing, self-managing, and has authority to make data-informed decisions to achieve shared goals.'),
      text('#/texts/p28-b5', 28, [513, 40, 562, 131], 'Regularly measure and reflect on progress. Learn from intelligent mistakes and successful outcomes and adjust as needed.'),
    ],
  }
  const analysis: PdfPageObjectAnalysis = {
    schema: PDF_PAGE_OBJECT_ANALYSIS_SCHEMA,
    pages: 28,
    placedImages: [
      { page: 8, sourceName: 'p8-left', pixelWidth: 2400, pixelHeight: 3200, bbox: [0, 0, 612, 792], pageSize, areaRatio: 0.5 },
      { page: 8, sourceName: 'p8-right', pixelWidth: 1600, pixelHeight: 1000, bbox: [612, 0, 1224, 381], pageSize, areaRatio: 0.24 },
      { page: 8, sourceName: 'p8-inset', pixelWidth: 800, pixelHeight: 500, bbox: [984, 206, 1195, 356], pageSize, areaRatio: 0.033 },
      { page: 9, sourceName: 'p9-left', pixelWidth: 1900, pixelHeight: 1200, bbox: [0, 0, 612, 385], pageSize, areaRatio: 0.243 },
      { page: 9, sourceName: 'p9-right', pixelWidth: 2500, pixelHeight: 1600, bbox: [611, 0, 1224, 385], pageSize, areaRatio: 0.243 },
      { page: 10, sourceName: 'p10-left', pixelWidth: 1900, pixelHeight: 1080, bbox: [3, 35, 613, 385], pageSize, areaRatio: 0.224 },
      { page: 10, sourceName: 'p10-right', pixelWidth: 2500, pixelHeight: 1600, bbox: [611, 0, 1224, 385], pageSize, areaRatio: 0.243 },
      { page: 28, sourceName: 'p28-icon', pixelWidth: 64, pixelHeight: 64, bbox: [703, 135, 760, 193], pageSize, areaRatio: 0.0034 },
    ],
    vectorTableCandidates: [{
      page: 12,
      bbox: [46, 217, 329, 331],
      pageSize,
      horizontalRuleCount: 7,
      verticalRuleCount: 0,
    }],
  }

  const normalized = normalizeDoclingDocument(
    docling,
    strToU8('%PDF-1.7\n% compact regression fixture\n'),
    'nasa-page-object-regression.pdf',
    '2026-07-24T12:00:00.000Z',
    false,
    {},
    { visualAssetPolicy: 'source-backed', pageObjectAnalysis: analysis },
    'pdf',
  )

  const page8 = regionEvidenceState(normalized.document, { page: 8 })
  assert.equal(page8.summary.total, 4)
  assert.equal(page8.regions.filter(region => region.status === 'observed').length, 3)
  assert.ok(page8.regions.some(region => region.bbox[0] === 0 && region.bbox[3] === 792))
  assert.ok(page8.regions.some(region => region.bbox[0] === 984 && region.bbox[2] === 1195))

  const page9 = regionEvidenceState(normalized.document, { page: 9 })
  assert.equal(page9.summary.byKind.screenshot, 0)
  assert.equal(page9.regions.filter(region => region.structuredData?.regionRole === 'multi-panel-child-observed').length, 2)
  assert.equal(page9.regions.filter(region => region.structuredData?.regionRole === 'multi-panel-parent-candidate').length, 1)

  const page10 = regionEvidenceState(normalized.document, { page: 10 })
  assert.equal(page10.summary.byKind.screenshot, 0)
  assert.equal(page10.regions.filter(region => region.status === 'observed').length, 2)
  assert.ok(page10.regions.some(region => region.bbox[0] === 611 && region.bbox[1] === 0 && region.bbox[2] === 1224))
  assert.equal(page10.regions.filter(region => region.structuredData?.regionRole === 'source-visual-parent-candidate').length, 1)

  const page12 = regionEvidenceState(normalized.document, { page: 12 })
  assert.ok(page12.regions.some(region => region.kind === 'table' && region.structuredData?.regionRole === 'vector-table-candidate'))

  const page28 = regionEvidenceState(normalized.document, { page: 28 })
  assert.equal(page28.regions.filter(region => region.structuredData?.regionRole === 'text-grid-infographic-candidate').length, 1)
  assert.equal(page28.regions.filter(region => region.structuredData?.rawVisualClass === 'icon' && region.defaultVisibility === 'evidence-only').length, 1)
  assert.equal(regionEvidenceState(normalized.document, { page: 28, includeParts: false }).regions.filter(region => region.structuredData?.rawVisualClass === 'icon').length, 0)
  assert.match(String(page28.regions[0]?.description), /Guiding Values/)
  assert.equal(normalized.document.metadata.importer && (normalized.document.metadata.importer as Record<string, unknown>).pageObjectAnalysis !== null, true)
})

test('NASA semantic projection preserves cover art, complete panel bounds, visualizations, mixed tables, and specialized visual objects', () => {
  const portraitPictures = Array.from({ length: 12 }, (_, index) => {
    const column = index % 6
    const row = Math.floor(index / 6)
    return picture(
      `#/pictures/p37-portrait-${index + 1}`,
      37,
      [100 + column * 100, 420 - row * 115, 180 + column * 100, 500 - row * 115],
      'photograph',
      0.97,
      `Personnel portrait ${index + 1}`,
    )
  })
  const eventPictures = Array.from({ length: 8 }, (_, index) => {
    const column = index % 4
    const row = Math.floor(index / 4)
    return picture(
      `#/pictures/p27-event-${index + 1}`,
      27,
      [270 + column * 95, 400 - row * 100, 345 + column * 95, 475 - row * 100],
      'photograph',
      0.92,
      `Workshop event photograph ${index + 1}`,
    )
  })
  const docling: DoclingDocument = {
    schema_name: 'DoclingDocument',
    version: '1.8.0',
    name: 'NASA semantic page-object regression',
    pages: Object.fromEntries([1, 3, 15, 26, 27, 28, 33, 37, 40, 41].map(page => [String(page), { page_no: page, size: pageSize }])),
    pictures: [
      picture('#/pictures/p1-top', 1, [0, 550, 300, 792], 'photograph', 0.95, 'Cover artwork top section'),
      picture('#/pictures/p1-middle-a', 1, [0, 290, 430, 545], 'photograph', 0.95, 'Cover artwork middle layer one'),
      picture('#/pictures/p1-middle-b', 1, [210, 310, 500, 530], 'photograph', 0.94, 'Cover artwork middle layer two'),
      picture('#/pictures/p1-bottom', 1, [0, 0, 300, 280], 'photograph', 0.95, 'Cover artwork bottom section'),
      picture('#/pictures/p1-logo', 1, [1000, 40, 1130, 130], 'logo', 0.99, 'NASA logo'),
      picture('#/pictures/p3-sidebar', 3, [0, 360, 250, 792], 'full_page_image', 0.93, 'Left sidebar composite'),
      picture('#/pictures/p15-parent', 15, [100, 100, 650, 550], 'photograph', 0.95, 'Four-panel engineering figure'),
      picture('#/pictures/p26-left-a', 26, [0, 0, 360, 792], 'photograph', 0.94, 'Workshop montage left layer'),
      picture('#/pictures/p26-left-b', 26, [240, 0, 500, 792], 'photograph', 0.92, 'Workshop montage right layer'),
      picture('#/pictures/p26-right', 26, [700, 140, 1120, 510], 'photograph', 0.96, 'Workshop event photograph'),
      picture('#/pictures/p27-battery-logo', 27, [65, 320, 228, 413], 'logo', 0.998, 'NASA Aerospace Battery Workshop logo'),
      picture('#/pictures/p27-systems-logo', 27, [660, 609, 758, 707], 'logo', 0.941, 'NASA Systems Engineering logo'),
      ...eventPictures,
      picture('#/pictures/p28-agile-logo', 28, [35, 31, 213, 108], 'logo', 0.979, 'AGILE NASA Community of Practice logo'),
      ...Array.from({ length: 4 }, (_, index) => picture(
        `#/pictures/p28-table-icon-${index + 1}`,
        28,
        [680, 120 + index * 95, 730, 170 + index * 95],
        'icon',
        0.99,
        '',
      )),
      picture('#/pictures/p28-table-top-cell', 28, [680, 535, 730, 580], 'icon', 0.99, ''),
      picture('#/pictures/p28-table-bottom-cell', 28, [680, 90, 730, 130], 'logo', 0.99, ''),
      picture('#/pictures/p33-lunar-simulation', 33, [660, 100, 1180, 520], 'screenshot_from_computer', 0.755, 'Simulated terrain sequence used for lunar surface operations'),
      ...portraitPictures,
      picture('#/pictures/p40-nesc-logo', 40, [927, 599, 1038, 710], 'logo', 0.988, 'NASA Engineering and Safety Center logo'),
      picture('#/pictures/p40-qr', 40, [1093, 75, 1132, 114], 'qr_code', 1, 'QR code'),
      picture('#/pictures/p41-nesc-logo', 41, [33, 183, 147, 295], 'logo', 0.998, 'NASA Engineering and Safety Center logo'),
      picture('#/pictures/p41-collage-a', 41, [610, 90, 1000, 650], 'photograph', 0.95, 'Safety center collage layer one'),
      picture('#/pictures/p41-collage-b', 41, [860, 150, 1180, 610], 'photograph', 0.94, 'Safety center collage layer two'),
    ],
    texts: [
      text('#/texts/p26-left-panel-copy', 26, [295, 250, 580, 420], 'Workshop overview text completing the left spread panel'),
    ],
  }
  const analysis: PdfPageObjectAnalysis = {
    schema: PDF_PAGE_OBJECT_ANALYSIS_SCHEMA,
    pages: 41,
    placedImages: [
      { page: 15, sourceName: 'p15-a', pixelWidth: 800, pixelHeight: 600, bbox: [105, 105, 375, 315], pageSize, areaRatio: 0.0585 },
      { page: 15, sourceName: 'p15-b', pixelWidth: 800, pixelHeight: 600, bbox: [375, 105, 645, 315], pageSize, areaRatio: 0.0585 },
      { page: 15, sourceName: 'p15-c', pixelWidth: 800, pixelHeight: 600, bbox: [105, 315, 375, 545], pageSize, areaRatio: 0.064 },
      { page: 15, sourceName: 'p15-d', pixelWidth: 800, pixelHeight: 600, bbox: [375, 315, 645, 545], pageSize, areaRatio: 0.064 },
    ],
    vectorTableCandidates: [{
      page: 28,
      bbox: [650, 140, 780, 530],
      pageSize,
      horizontalRuleCount: 7,
      verticalRuleCount: 0,
    }],
  }

  const normalized = normalizeDoclingDocument(
    docling,
    strToU8('%PDF-1.7\n% semantic hierarchy regression fixture\n'),
    'nasa-semantic-page-object-regression.pdf',
    '2026-07-24T12:00:00.000Z',
    false,
    {},
    { visualAssetPolicy: 'source-backed', pageObjectAnalysis: analysis },
    'pdf',
  )

  const page1All = regionEvidenceState(normalized.document, { page: 1, includeParts: true })
  const page1Semantic = regionEvidenceState(normalized.document, { page: 1, includeParts: false })
  const cover = page1Semantic.regions.find(region => region.structuredData?.regionRole === 'cover-artwork-parent')
  assert.equal(page1Semantic.summary.total, 2)
  assert.ok(cover)
  assert.deepEqual(cover?.bbox, [0, 0, 500, 792])
  assert.equal(page1All.regions.filter(region => region.structuredData?.regionRole === 'cover-artwork-part').length, 3)
  assert.equal(page1Semantic.summary.byKind.logo, 1)

  const page3Semantic = regionEvidenceState(normalized.document, { page: 3, includeParts: false })
  assert.equal(page3Semantic.summary.total, 1)
  assert.equal(page3Semantic.regions[0]?.structuredData?.regionRole, 'sidebar-composite-candidate')
  assert.deepEqual(page3Semantic.regions[0]?.bbox, [0, 0, 250, 792])

  const page15All = regionEvidenceState(normalized.document, { page: 15, includeParts: true })
  const page15Semantic = regionEvidenceState(normalized.document, { page: 15, includeParts: false })
  assert.equal(page15All.regions.filter(region => region.semanticLevel === 'part').length, 4)
  assert.equal(page15Semantic.summary.total, 1)
  assert.equal(page15Semantic.regions[0]?.structuredData?.regionRole, 'multi-panel-parent-candidate')

  const page26Semantic = regionEvidenceState(normalized.document, { page: 26, includeParts: false })
  assert.equal(page26Semantic.summary.total, 2)
  const spreadPanel = page26Semantic.regions.find(region => region.structuredData?.regionRole === 'spread-panel-composite')
  assert.ok(spreadPanel)
  assert.deepEqual(spreadPanel?.bbox, [0, 0, 612, 792])

  const page27Semantic = regionEvidenceState(normalized.document, { page: 27, includeParts: false })
  assert.equal(page27Semantic.summary.byKind.logo, 2)
  assert.equal(page27Semantic.summary.byKind.roster, 0)

  const page28All = regionEvidenceState(normalized.document, { page: 28, includeParts: true })
  const page28Semantic = regionEvidenceState(normalized.document, { page: 28, includeParts: false })
  const mixedTable = page28Semantic.regions.find(region => region.kind === 'table')
  assert.equal(page28Semantic.summary.byKind.logo, 1)
  assert.equal(mixedTable?.structuredData?.regionRole, 'mixed-media-table')
  assert.equal(mixedTable?.structuredData?.mediaCellCount, 6)
  assert.equal(page28All.regions.filter(region => region.structuredData?.regionRole === 'table-cell-media').length, 6)
  assert.ok((mixedTable?.bbox[1] || Infinity) <= 80)
  assert.ok((mixedTable?.bbox[3] || 0) >= 590)

  const page33Semantic = regionEvidenceState(normalized.document, { page: 33, includeParts: false })
  assert.equal(page33Semantic.summary.byKind.visualization, 1)
  assert.equal(page33Semantic.summary.byKind.simulation, 0)
  assert.equal(page33Semantic.summary.byKind.screenshot, 0)
  assert.equal(page33Semantic.regions[0]?.structuredData?.visualSubtype, 'simulation')

  const page37All = regionEvidenceState(normalized.document, { page: 37, includeParts: true })
  const page37Semantic = regionEvidenceState(normalized.document, { page: 37, includeParts: false })
  const roster = page37Semantic.regions.find(region => region.kind === 'roster')
  assert.equal(page37Semantic.summary.total, 1)
  assert.equal(roster?.structuredData?.portraitCount, 12)
  assert.equal(page37All.regions.filter(region => region.parentRegionId === roster?.id).length, 12)

  const page40Semantic = regionEvidenceState(normalized.document, { page: 40, includeParts: false })
  assert.equal(page40Semantic.summary.byKind.logo, 1)
  assert.equal(page40Semantic.summary.byKind.qrCode, 1)
  assert.deepEqual(page40Semantic.regions.find(region => region.kind === 'qrCode')?.structuredData?.machineReadableCode, {
    symbology: 'QR',
    decodeStatus: 'not-decoded',
    payload: null,
  })

  const page41All = regionEvidenceState(normalized.document, { page: 41, includeParts: true })
  const page41Semantic = regionEvidenceState(normalized.document, { page: 41, includeParts: false })
  assert.equal(page41Semantic.summary.byKind.logo, 1)
  assert.equal(page41Semantic.regions.filter(region => region.structuredData?.regionRole === 'semantic-composite-parent').length, 1)
  assert.equal(page41All.regions.filter(region => region.structuredData?.regionRole === 'composite-source-part').length, 2)
})
