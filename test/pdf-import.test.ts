import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { Script } from 'node:vm'
import { strFromU8, strToU8, zipSync } from 'fflate'
import {
  normalizeDoclingDocument,
  packAndoc,
  readAndoc,
  regionEvidenceState,
  transactAndocPackage,
  validateAndoc,
  type AndocTransaction,
  type DoclingDocument,
} from '../src/index.js'

const fixtureRoot = path.join(import.meta.dirname, 'fixtures')
const importedAt = '2026-07-15T12:00:00.000Z'

test('Docling normalization preserves DOCX source identity, media type, and semantic blocks', async () => {
  const docxBytes = zipSync({ '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') })
  const normalized = normalizeDoclingDocument({
    schema_name: 'DoclingDocument',
    version: '1.9.0',
    name: 'office-plan',
    pages: { '1': {} },
    texts: [
      { self_ref: '#/texts/0', label: 'text', text: 'Office Import Plan', prov: [{ page_no: 1 }] },
      { self_ref: '#/texts/1', label: 'section_header', level: 1, text: 'Agent Experience', prov: [{ page_no: 1 }] },
      { self_ref: '#/texts/2', label: 'text', text: 'Agents can address this paragraph directly.', prov: [{ page_no: 1 }] },
    ],
  }, docxBytes, 'office-plan.docx', importedAt, false, {}, {}, 'docx')
  assert.match(normalized.document.documentId, /^docx-[a-f0-9]{24}$/)
  assert.equal(normalized.stats.sourceFormat, 'docx')
  assert.equal((normalized.document.metadata.source as Record<string, unknown>).mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(normalized.sourcePath, 'sources/original/office-plan.docx')
  assert.equal(normalized.document.title, 'Office Import Plan')
  assert.equal(normalized.document.blocks[0]?.type, 'heading')
  assert.equal(normalized.document.blocks[1]?.type === 'heading' ? normalized.document.blocks[1].level : null, 2)
  assert((normalized.document.metadata.importWarnings as string[]).some(warning => /promoted to the document title/.test(warning)))
  const pkg = await readAndoc(await packAndoc({ document: normalized.document, sources: normalized.sources }))
  assert.equal(pkg.manifest.entries.find(entry => entry.path.endsWith('.docx'))?.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
})

test('DOCX normalization recovers page provenance from native Word page breaks when Docling omits pages', () => {
  const docxBytes = zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Recovered Native Title</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Second-page operating detail.</w:t></w:r></w:p></w:body></w:document>'),
  })
  const normalized = normalizeDoclingDocument({
    name: 'native-page-map',
    texts: [
      { self_ref: '#/texts/0', label: 'text', text: 'Recovered Native Title' },
      { self_ref: '#/texts/1', label: 'text', text: 'Second-page operating detail.' },
    ],
  }, docxBytes, 'native-page-map.docx', importedAt, false, {}, {}, 'docx')
  const detail = normalized.document.blocks.find(block => block.type === 'paragraph')
  const importer = normalized.document.metadata.importer as Record<string, unknown>
  const pageMap = importer.docxNativePageMap as Record<string, unknown>
  assert.equal(normalized.document.title, 'Recovered Native Title')
  assert.equal(detail?.provenance?.page, 2)
  assert(normalized.document.blocks.some(block => block.type === 'pageBreak'))
  assert.equal((normalized.document.metadata.source as Record<string, unknown>).pageCount, 2)
  assert.equal(pageMap.method, 'native-explicit-page-breaks')
  assert.equal(pageMap.matchedTextItems, 2)
  assert((normalized.document.metadata.importWarnings as string[]).some(warning => /Native Word page-break markers/.test(warning)))
})

test('PPTX normalization selects the prominent slide title and recovers native cached chart data', () => {
  const pptxBytes = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'ppt/slides/charts/chart1.xml': strToU8('<?xml version="1.0"?><c:chartSpace xmlns:c="urn:chart"><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:v>Confidence</c:v></c:tx><c:cat><c:strLit><c:pt idx="0"><c:v>Locate</c:v></c:pt><c:pt idx="1"><c:v>Apply</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:pt idx="0"><c:v>92</c:v></c:pt><c:pt idx="1"><c:v>100</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'),
    'ppt/slides/_rels/slide3.xml.rels': strToU8('<Relationships><Relationship Target="charts/chart1.xml"/></Relationships>'),
  })
  const normalized = normalizeDoclingDocument({
    name: 'presentation-fixture',
    pages: { '1': {}, '2': {}, '3': {} },
    texts: [
      { self_ref: '#/texts/0', label: 'paragraph', text: 'Small eyebrow', prov: [{ page_no: 1, bbox: { l: 10, b: 680, r: 400, t: 710 } }] },
      { self_ref: '#/texts/1', label: 'paragraph', text: 'Prominent Presentation Title', prov: [{ page_no: 1, bbox: { l: 10, b: 350, r: 900, t: 650 } }] },
      { self_ref: '#/texts/2', label: 'paragraph', text: 'Body text', prov: [{ page_no: 1, bbox: { l: 10, b: 100, r: 800, t: 160 } }] },
    ],
  }, pptxBytes, 'presentation-fixture.pptx', importedAt, false, {}, {}, 'pptx')

  assert.equal(normalized.document.title, 'Prominent Presentation Title')
  assert.equal(normalized.document.blocks.find(block => block.type === 'heading')?.type, 'heading')
  const chart = normalized.document.blocks.find(block => block.type === 'chart')
  assert.ok(chart?.type === 'chart')
  assert.equal(chart.provenance?.page, 3)
  assert.equal(chart.spec.chartType, 'bar')
  assert.deepEqual(chart.spec.data, { columns: ['Category', 'Confidence'], rows: [['Locate', 92], ['Apply', 100]] })
  assert.equal(normalized.stats.chartBlocks, 1)
  assert.equal(normalized.stats.chartBlocksWithData, 1)
})

test('XLSX normalization uses the first structured cell as its document title', () => {
  const xlsxBytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>') })
  const normalized = normalizeDoclingDocument({
    name: 'spreadsheet-file-name',
    pages: { '1': {} },
    tables: [{ self_ref: '#/tables/0', data: { grid: [[{ text: 'Operational Workbook Title', column_header: true }], [{ text: 'Metric' }]] } }],
  }, xlsxBytes, 'spreadsheet-file-name.xlsx', importedAt, false, {}, {}, 'xlsx')

  assert.equal(normalized.document.title, 'Operational Workbook Title')
  assert((normalized.document.metadata.importWarnings as string[]).some(warning => /spreadsheet cell/.test(warning)))
})

test('DOCX normalization follows the Docling body tree and excludes table descendants and Word furniture', () => {
  const docxBytes = zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/header1.xml': strToU8('<w:hdr xmlns:w="urn:test"><w:p><w:r><w:t>Running header</w:t></w:r></w:p></w:hdr>'),
    'word/footer1.xml': strToU8('<w:ftr xmlns:w="urn:test"><w:p><w:r><w:t>Controlled footer</w:t></w:r></w:p></w:ftr>'),
  })
  const normalized = normalizeDoclingDocument({
    schema_name: 'DoclingDocument',
    version: '1.9.0',
    name: 'ordered-office-fixture',
    body: { self_ref: '#/body', children: [{ $ref: '#/texts/0' }, { $ref: '#/texts/1' }, { $ref: '#/groups/0' }, { $ref: '#/groups/1' }] },
    furniture: { self_ref: '#/furniture', children: [] },
    groups: [
      { self_ref: '#/groups/0', name: 'metadata', parent: { $ref: '#/body' }, children: [{ $ref: '#/texts/2' }, { $ref: '#/texts/3' }] },
      { self_ref: '#/groups/1', name: 'section', parent: { $ref: '#/body' }, children: [{ $ref: '#/texts/4' }] },
      { self_ref: '#/groups/2', name: 'rich_cell_group', parent: { $ref: '#/tables/0' }, children: [{ $ref: '#/texts/8' }] },
    ],
    texts: [
      { self_ref: '#/texts/0', label: 'text', text: 'Ordered Office Fixture', parent: { $ref: '#/body' }, children: [] },
      { self_ref: '#/texts/1', label: 'text', text: 'Subtitle', parent: { $ref: '#/body' }, children: [] },
      { self_ref: '#/texts/2', label: 'text', text: 'Purpose:', parent: { $ref: '#/groups/0' }, children: [] },
      { self_ref: '#/texts/3', label: 'text', text: 'Verify canonical order', parent: { $ref: '#/groups/0' }, children: [] },
      { self_ref: '#/texts/4', label: 'section_header', level: 1, text: 'Structured Operations', parent: { $ref: '#/groups/1' }, children: [{ $ref: '#/texts/5' }, { $ref: '#/texts/6' }] },
      { self_ref: '#/texts/5', label: 'text', text: 'Table 1. Agent-addressable values.', parent: { $ref: '#/texts/4' }, children: [{ $ref: '#/tables/0' }] },
      { self_ref: '#/texts/6', label: 'section_header', level: 2, text: 'Acceptance', parent: { $ref: '#/texts/4' }, children: [{ $ref: '#/texts/7' }, { $ref: '#/texts/9' }, { $ref: '#/texts/10' }] },
      { self_ref: '#/texts/7', label: 'text', text: 'The structure remains synchronized.', parent: { $ref: '#/texts/6' }, children: [] },
      { self_ref: '#/texts/8', label: 'text', text: 'Metric', parent: { $ref: '#/groups/2' }, children: [] },
      { self_ref: '#/texts/9', label: 'text', text: 'Running header', parent: { $ref: '#/texts/6' }, children: [] },
      { self_ref: '#/texts/10', label: 'text', text: 'Controlled footer', parent: { $ref: '#/texts/6' }, children: [] },
    ],
    tables: [{
      self_ref: '#/tables/0',
      label: 'table',
      parent: { $ref: '#/texts/5' },
      children: [{ $ref: '#/groups/2' }],
      data: { grid: [[{ text: 'Metric', column_header: true }, { text: 'Status', column_header: true }], [{ text: 'Order' }, { text: 'Ready' }]] },
    }],
  }, docxBytes, 'ordered-office-fixture.docx', importedAt, false, {}, {}, 'docx')

  const signatures = normalized.document.blocks.map(block => block.type === 'table'
    ? 'table:Metric|Status'
    : block.type === 'heading' || block.type === 'paragraph'
      ? `${block.type}:${block.content.map(run => run.text).join('')}`
      : block.type)
  assert.deepEqual(signatures, [
    'heading:Ordered Office Fixture',
    'paragraph:Subtitle',
    'paragraph:Purpose:',
    'paragraph:Verify canonical order',
    'heading:Structured Operations',
    'paragraph:Table 1. Agent-addressable values.',
    'table:Metric|Status',
    'heading:Acceptance',
    'paragraph:The structure remains synchronized.',
  ])
  assert.equal(normalized.document.blocks.filter(block => block.type === 'paragraph' && block.content[0]?.text === 'Metric').length, 0)
  assert.equal(normalized.document.blocks.some(block => block.type === 'paragraph' && /Running header|Controlled footer/.test(block.content[0]?.text || '')), false)
})

const doclingFixture: DoclingDocument = {
  schema_name: 'DoclingDocument',
  version: '1.9.0',
  name: 'pdf-import-fixture',
  pages: { '1': { size: { width: 612, height: 792 } }, '2': { size: { width: 612, height: 792 } } },
  texts: [
    { self_ref: '#/texts/3', label: 'section_header', text: 'Agent Experience', level: 1, prov: [{ page_no: 1, bbox: { l: 72, b: 270, r: 300, t: 300, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/0', label: 'title', text: 'ANDoc PDF Import Fixture', prov: [{ page_no: 1, bbox: { l: 72, b: 700, r: 420, t: 730, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/4', label: 'title', text: 'Second Page', prov: [{ page_no: 2, bbox: { l: 72, b: 700, r: 250, t: 730, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/1', label: 'text', text: 'A controlled paragraph for extraction.', prov: [{ page_no: 1, bbox: { l: 72, b: 650, r: 360, t: 680, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/5', label: 'text', text: 'The original source remains embedded.', prov: [{ page_no: 2, bbox: { l: 72, b: 650, r: 360, t: 680, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/6', label: 'text', text: 'Heading', prov: [{ page_no: 1, bbox: { l: 80, b: 500, r: 250, t: 530, coord_origin: 'BOTTOMLEFT' } }] },
  ],
  tables: [{
    self_ref: '#/tables/0',
    label: 'table',
    prov: [{ page_no: 1, bbox: { l: 72, b: 360, r: 500, t: 600, coord_origin: 'BOTTOMLEFT' } }],
    data: {
      grid: [
        [{ text: 'Block', column_header: true }, { text: 'Agent value', column_header: true }],
        [
          { text: 'Stable navigation', bbox: { l: 300, b: 500, r: 500, t: 530, coord_origin: 'BOTTOMLEFT' } },
          { text: 'Heading', bbox: { l: 72, b: 500, r: 250, t: 530, coord_origin: 'BOTTOMLEFT' } },
        ],
        [{ text: 'Table' }, { text: 'Typed rows and cells' }],
      ],
    },
  }],
  pictures: [{ self_ref: '#/pictures/0', image: { uri: 'data:image/png;base64,omitted' } }],
}

const mediaDoclingFixture: DoclingDocument = {
  schema_name: 'DoclingDocument',
  version: '1.9.0',
  name: 'pdf-media-fixture',
  pages: { '1': {}, '2': {} },
  texts: [
    { self_ref: '#/texts/0', label: 'section_header', text: 'ANDoc PDF Media Fixture', prov: [{ page_no: 1, bbox: { l: 72, b: 700, r: 430, t: 730, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/1', label: 'section_header', text: 'Site Image', prov: [{ page_no: 1, bbox: { l: 72, b: 640, r: 240, t: 670, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/2', label: 'caption', text: 'Figure 1. North Ridge wind generation site.', prov: [{ page_no: 1, bbox: { l: 72, b: 300, r: 360, t: 325, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/3', label: 'section_header', text: 'Generation Chart', prov: [{ page_no: 2, bbox: { l: 72, b: 700, r: 290, t: 730, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/4', label: 'caption', text: 'Figure 2. Monthly net generation chart in MWh.', prov: [{ page_no: 2, bbox: { l: 72, b: 300, r: 390, t: 325, coord_origin: 'BOTTOMLEFT' } }] },
    { self_ref: '#/texts/5', label: 'text', text: 'Visual assets and source evidence survive every revision.', prov: [{ page_no: 2, bbox: { l: 72, b: 250, r: 430, t: 275, coord_origin: 'BOTTOMLEFT' } }] },
  ],
  pictures: [
    {
      self_ref: '#/pictures/0',
      label: 'picture',
      prov: [{ page_no: 1, bbox: { l: 72, b: 330, r: 540, t: 620, coord_origin: 'BOTTOMLEFT' } }],
      captions: [{ $ref: '#/texts/2' }],
      image: { mimetype: 'image/png', uri: 'photo.png', dpi: 144, size: { width: 900, height: 420 } },
      meta: { classification: { predictions: [{ class_name: 'photograph', confidence: 0.98 }] } },
    },
    {
      self_ref: '#/pictures/1',
      label: 'picture',
      prov: [{ page_no: 2, bbox: { l: 72, b: 330, r: 540, t: 680, coord_origin: 'BOTTOMLEFT' } }],
      captions: [{ $ref: '#/texts/4' }],
      image: { mimetype: 'image/png', uri: 'chart.png', dpi: 144, size: { width: 900, height: 480 } },
      meta: {
        classification: { predictions: [{ class_name: 'bar_chart', confidence: 0.999 }] },
        tabular_chart: { title: 'Monthly Generation', chart_data: { columns: ['month', 'mwh'], rows: [['Jan', 42], ['Feb', 58], ['Mar', 73], ['Apr', 86], ['May', 78]] } },
      },
    },
  ],
}

test('PDF normalization preserves reading order, semantic tables, and page provenance', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-import-fixture.pdf')))
  const normalized = normalizeDoclingDocument(doclingFixture, pdfBytes, 'Fixture Source.pdf', importedAt, false)

  assert.equal(normalized.document.title, 'ANDoc PDF Import Fixture')
  assert.equal(normalized.document.documentId.match(/^pdf-[a-f0-9]{24}$/)?.[0], normalized.document.documentId)
  assert.deepEqual(normalized.document.blocks.map(block => block.type), [
    'heading', 'paragraph', 'table', 'heading', 'pageBreak', 'heading', 'paragraph',
  ])

  const table = normalized.document.blocks.find(block => block.type === 'table')
  assert.ok(table && table.type === 'table')
  assert.equal(table.rows[0]?.[0]?.header, true)
  assert.equal(table.rows[1]?.[0]?.content[0]?.text, 'Heading')
  assert.equal(table.rows[1]?.[1]?.content[0]?.text, 'Stable navigation')
  assert.equal(table.rows[1]?.[0]?.attrs?.sourceGridColumn, 1)
  assert.deepEqual(table.rows[1]?.[0]?.attrs?.sourceCellBBox, [72, 500, 250, 530])
  assert.equal(normalized.document.blocks.filter(block => block.type === 'paragraph' && block.content[0]?.text === 'Heading').length, 0)
  assert.equal(table.rows[2]?.[1]?.content[0]?.text, 'Typed rows and cells')
  assert.match(table.rows[2]?.[1]?.id || '', /^cell-[a-f0-9]{16}$/)
  assert.notEqual(table.rows[2]?.[1]?.id, table.rows[2]?.[0]?.id)
  assert.equal(table.rows[2]?.[1]?.provenance?.page, 1)
  assert.deepEqual(table.rows[2]?.[1]?.provenance?.bbox, [72, 360, 500, 600])
  assert.equal(table.rows[2]?.[1]?.attrs?.sourceRow, 2)
  assert.equal(table.rows[2]?.[1]?.attrs?.sourceColumn, 1)
  assert.equal(table.provenance?.page, 1)
  assert.deepEqual(table.provenance?.bbox, [72, 360, 500, 600])
  assert.equal(normalized.document.blocks.at(-1)?.provenance?.page, 2)
  assert.equal((normalized.document.metadata.importer as Record<string, unknown>).ocrRequested, false)
  const layout = normalized.document.metadata.layout as Record<string, unknown>
  assert.equal(layout.defaultView, 'page')
  assert.deepEqual((layout.sourcePageSizes as Record<string, unknown>)['1'], { width: 612, height: 792 })
  assert.equal(normalized.stats.pictureItemsNotYetMapped, 1)
})

test('PDF normalization preserves note subtype and only verifies deterministic anchors while promoting conservative numbered headings', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-import-fixture.pdf')))
  const normalized = normalizeDoclingDocument({
    schema_name: 'DoclingDocument',
    version: '1.9.0',
    name: 'linked-note-fixture',
    pages: { '1': { size: { width: 612, height: 792 } }, '2': { size: { width: 612, height: 792 } } },
    texts: [
      { self_ref: '#/texts/0', label: 'title', text: 'Linked Note Fixture', prov: [{ page_no: 1, bbox: { l: 72, b: 720, r: 360, t: 748, coord_origin: 'BOTTOMLEFT' } }] },
      { self_ref: '#/texts/1', label: 'text', text: '13. Goal-Question-Metric', prov: [{ page_no: 1, bbox: { l: 72, b: 660, r: 340, t: 690, coord_origin: 'BOTTOMLEFT' } }] },
      { self_ref: '#/texts/2', label: 'footnote', text: '[1] Values are unaudited.', parent: { $ref: '#/body' }, prov: [{ page_no: 1, bbox: { l: 72, b: 80, r: 320, t: 100, coord_origin: 'BOTTOMLEFT' } }] },
      { self_ref: '#/texts/3', label: 'endnote', text: 'A Supplemental release condition.', prov: [{ page_no: 2, bbox: { l: 72, b: 80, r: 360, t: 100, coord_origin: 'BOTTOMLEFT' } }] },
    ],
    tables: [{
      self_ref: '#/tables/0',
      label: 'table',
      footnotes: [{ $ref: '#/texts/2' }],
      prov: [{ page_no: 1, bbox: { l: 72, b: 300, r: 500, t: 620, coord_origin: 'BOTTOMLEFT' } }],
      data: { grid: [[{ text: 'Metric', column_header: true }, { text: 'Value', column_header: true }], [{ text: 'Accuracy' }, { text: '98%' }]] },
    }],
  }, pdfBytes, 'linked-note-fixture.pdf', importedAt, false)

  const heading = normalized.document.blocks.find(block => block.type === 'heading' && block.attrs?.sectionNumber === '13')
  assert.equal(heading?.type, 'heading')
  assert.equal(heading?.type === 'heading' ? heading.level : null, 1)
  assert.equal(heading?.attrs?.headingDetection, 'deterministic-numbered-heading')

  const notes = normalized.document.blocks.filter(block => block.type === 'footnote')
  assert.equal(notes.length, 2)
  assert.equal(notes[0]?.noteKind, 'footnote')
  assert.equal(notes[0]?.label, '[1]')
  assert.equal(notes[0]?.anchorStatus, 'resolved')
  assert.deepEqual(notes[0]?.anchorIds, [normalized.document.blocks.find(block => block.type === 'table')?.id])
  assert.equal(notes[1]?.noteKind, 'endnote')
  assert.equal(notes[1]?.anchorStatus, 'unanchored')

  const state = regionEvidenceState(normalized.document, { kinds: ['note'] })
  assert.equal(state.regions.length, 2)
  assert.equal(state.regions[0]?.status, 'verified')
  assert.equal(state.regions[0]?.unattendedUse, 'allowed')
  assert.equal(state.regions[0]?.structuredData?.anchorStatus, 'resolved')
  assert.equal(state.regions[1]?.status, 'candidate')
  assert.equal(state.regions[1]?.unattendedUse, 'review-required')
  assert.equal(state.regions[1]?.structuredData?.noteKind, 'endnote')
})

test('PDF normalization repairs merged-cell duplication, reuses recurring logo bytes, and renders Page view by default', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-import-fixture.pdf')))
  const logoBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-photo.png')))
  const repeatedCell = {
    text: 'List of figures',
    col_span: 3,
    start_col_offset_idx: 0,
    start_row_offset_idx: 0,
    column_header: true,
    bbox: { l: 72, b: 600, r: 540, t: 630, coord_origin: 'BOTTOMLEFT' },
  }
  const fixture: DoclingDocument = {
    name: 'page-fidelity-fixture',
    pages: {
      '1': { size: { width: 612, height: 792 } },
      '2': { size: { width: 612, height: 792 } },
      '3': { size: { width: 612, height: 792 } },
    },
    texts: [
      { self_ref: '#/texts/0', label: 'title', text: 'Page Fidelity Fixture', prov: [{ page_no: 1, bbox: { l: 72, b: 670, r: 420, t: 700, coord_origin: 'BOTTOMLEFT' } }] },
      { self_ref: '#/texts/1', label: 'text', text: 'Page two content.', prov: [{ page_no: 2, bbox: { l: 72, b: 620, r: 300, t: 650, coord_origin: 'BOTTOMLEFT' } }] },
      { self_ref: '#/texts/2', label: 'text', text: 'Page three content.', prov: [{ page_no: 3, bbox: { l: 72, b: 620, r: 300, t: 650, coord_origin: 'BOTTOMLEFT' } }] },
    ],
    tables: [{
      self_ref: '#/tables/0',
      prov: [{ page_no: 1, bbox: { l: 72, b: 560, r: 540, t: 630, coord_origin: 'BOTTOMLEFT' } }],
      data: { grid: [[repeatedCell, structuredClone(repeatedCell), structuredClone(repeatedCell)]] },
    }],
    pictures: [1, 2, 3].map((page, index) => ({
      self_ref: `#/pictures/${index}`,
      label: 'picture',
      prov: [{ page_no: page, bbox: { l: 460, b: 720, r: 540, t: 754, coord_origin: 'BOTTOMLEFT' } }],
      image: { mimetype: 'image/png', uri: `logo-${page}.png` },
      meta: { classification: { predictions: [{ class_name: 'logo', confidence: 0.99 }] } },
    })),
  }
  const normalized = normalizeDoclingDocument(fixture, pdfBytes, 'Page Fidelity.pdf', importedAt, false, {
    '#/pictures/0': { bytes: logoBytes, mediaType: 'image/png' },
    '#/pictures/1': { bytes: logoBytes, mediaType: 'image/png' },
    '#/pictures/2': { bytes: logoBytes, mediaType: 'image/png' },
  })

  const table = normalized.document.blocks.find(block => block.type === 'table')
  assert.ok(table?.type === 'table')
  assert.equal(table.rows[0]?.length, 1)
  assert.equal(table.rows[0]?.[0]?.colspan, 3)
  assert.equal(table.rows[0]?.[0]?.content[0]?.text, 'List of figures')

  const images = normalized.document.blocks.filter(block => block.type === 'image')
  assert.equal(images.length, 3)
  assert.equal(new Set(images.map(block => block.type === 'image' ? block.assetId : '')).size, 1)
  assert.equal(Object.keys(normalized.document.assets).length, 1)
  assert.equal(Object.keys(normalized.assets).length, 1)
  assert.deepEqual(images.map(block => block.attrs?.pageFurniture && (block.attrs.pageFurniture as Record<string, unknown>).occurrence), [1, 2, 3])

  const html = strFromU8((await readAndoc(await packAndoc({ document: normalized.document, assets: normalized.assets, sources: normalized.sources }))).files['views/document.html'])
  assert.match(html, /data-agn-view="page"/)
  assert.equal([...html.matchAll(/class="agn-page"/g)].length, 3)
  assert.equal([...html.matchAll(/<section class="agn-page"[^>]+data-agn-layout="geometry"/g)].length, 3)
  assert.ok([...html.matchAll(/data-agn-geometry="/g)].length >= 4)
  assert.match(html, /data-agn-title-geometry="true"/)
  assert.match(html, /style="--agn-x:[\d.]+%;--agn-y:[\d.]+%;--agn-w:[\d.]+%;--agn-h:[\d.]+%"/)
  assert.match(html, /style="--agn-page-aspect:612 \/ 792"/)
  assert.match(html, />Page<\/button><button[^>]+>Reflow<\/button><a[^>]+>Original<\/a>/)
  assert.equal([...html.matchAll(/<figure[^>]+data-agn-furniture="header-logo"/g)].length, 3)
  assert.match(html, /data-agn-recurring="true"\]:not\(\[data-agn-occurrence="1"\]\)/)
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1)
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    assert.doesNotThrow(() => new Script(match[1] || '', { filename: 'agn-human-view-inline.js' }))
  }
})

test('PDF import packages the original source, compact Docling JSON, and derived human view together', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-import-fixture.pdf')))
  const normalized = normalizeDoclingDocument(doclingFixture, pdfBytes, 'Fixture Source.pdf', importedAt)
  const packageBytes = await packAndoc({ document: normalized.document, sources: normalized.sources })
  const validation = await validateAndoc(packageBytes)
  const pkg = await readAndoc(packageBytes)

  assert.equal(validation.ok, true, JSON.stringify(validation.issues))
  assert.deepEqual(pkg.files[normalized.sourcePath], pdfBytes)
  assert.match(strFromU8(pkg.files['sources/docling/document.json']), /picture-exported-to-andoc-asset/)
  assert.doesNotMatch(strFromU8(pkg.files['sources/docling/document.json']), /data:image\/png/)
  assert.match(strFromU8(pkg.files['views/document.html']), /<table>/)
  assert.match(strFromU8(pkg.files['views/document.html']), /data-andoc-cell-id="cell-/)
  assert.match(strFromU8(pkg.files['views/document.html']), /data-andoc-document="pdf-/)
  assert.equal(pkg.manifest.entries.find(entry => entry.path === normalized.sourcePath)?.role, 'source')
  assert.equal(pkg.manifest.entries.find(entry => entry.path === normalized.sourcePath)?.mediaType, 'application/pdf')
  assert.equal(pkg.manifest.entries.find(entry => entry.path === normalized.sourcePath)?.size, pdfBytes.length)
})

test('an agent can update one imported table cell without rewriting the table or source PDF', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-import-fixture.pdf')))
  const normalized = normalizeDoclingDocument(doclingFixture, pdfBytes, 'Fixture Source.pdf', importedAt, false)
  const before = await readAndoc(await packAndoc({ document: normalized.document, sources: normalized.sources }))
  const table = before.document.blocks.find(block => block.type === 'table')
  assert.ok(table?.type === 'table')
  const target = table.rows[2]?.[1]
  assert.ok(target)
  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: 'tx-agent-table-cell-001',
    baseRevision: 0,
    actor: { type: 'agent', id: 'andoc-product-engineer' },
    timestamp: '2026-07-15T12:03:00.000Z',
    operations: [{ op: 'updateTableCell', tableId: table.id, cellId: target.id, content: [{ text: 'Stable targeted cell edit' }] }],
  }
  const result = await transactAndocPackage(before, transaction)
  const after = await readAndoc(result.packageBytes)
  const editedTable = after.document.blocks.find(block => block.id === table.id)
  assert.ok(editedTable?.type === 'table')
  assert.equal(editedTable.rows[2]?.[1]?.id, target.id)
  assert.equal(editedTable.rows[2]?.[1]?.content[0]?.text, 'Stable targeted cell edit')
  assert.equal(editedTable.rows[2]?.[0]?.content[0]?.text, 'Table')
  assert.deepEqual(after.files[normalized.sourcePath], before.files[normalized.sourcePath])
  assert.match(strFromU8(after.files['views/document.html']), /Stable targeted cell edit/)
  assert.equal((await validateAndoc(result.packageBytes)).ok, true)
})

test('PDF media normalization creates native image and chart blocks with integrity-checked assets', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-fixture.pdf')))
  const photoBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-photo.png')))
  const chartBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-chart.png')))
  const normalized = normalizeDoclingDocument(mediaDoclingFixture, pdfBytes, 'Media Fixture.pdf', importedAt, false, {
    '#/pictures/0': { bytes: photoBytes, mediaType: 'image/png' },
    '#/pictures/1': { bytes: chartBytes, mediaType: 'image/png' },
  }, { pictureClassificationRequested: true, pictureClassificationApplied: true })

  assert.deepEqual(normalized.document.blocks.map(block => block.type), [
    'heading', 'heading', 'image', 'pageBreak', 'heading', 'chart', 'paragraph',
  ])
  assert.equal(normalized.stats.imageBlocks, 1)
  assert.equal(normalized.stats.chartBlocks, 1)
  assert.equal(normalized.stats.chartBlocksWithData, 1)
  assert.equal(normalized.stats.pictureItemsNotYetMapped, 0)
  assert.equal(Object.keys(normalized.document.assets).length, 2)
  assert.equal(Object.keys(normalized.assets).length, 2)

  const image = normalized.document.blocks.find(block => block.type === 'image')
  const chart = normalized.document.blocks.find(block => block.type === 'chart')
  assert.ok(image && image.type === 'image')
  assert.ok(chart && chart.type === 'chart')
  assert.equal(image.caption?.[0]?.text, 'Figure 1. North Ridge wind generation site.')
  assert.equal(chart.caption?.[0]?.text, 'Figure 2. Monthly net generation chart in MWh.')
  assert.equal((chart.spec.extraction as Record<string, unknown>).status, 'structured-data-and-fallback')
  assert.deepEqual(chart.spec.data, { columns: ['month', 'mwh'], rows: [['Jan', 42], ['Feb', 58], ['Mar', 73], ['Apr', 86], ['May', 78]] })

  const packageBytes = await packAndoc({ document: normalized.document, assets: normalized.assets, sources: normalized.sources })
  const pkg = await readAndoc(packageBytes)
  const html = strFromU8(pkg.files['views/document.html'])
  assert.equal((await validateAndoc(packageBytes)).ok, true)
  assert.match(html, /data-andoc-chart-spec=/)
  assert.match(html, /assets\/pdf\/asset-/)
  assert.equal(pkg.manifest.entries.filter(entry => entry.role === 'asset').length, 2)
})

test('source-backed PDF normalization keeps typed visual regions without duplicate raster assets', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-fixture.pdf')))
  const normalized = normalizeDoclingDocument(
    mediaDoclingFixture,
    pdfBytes,
    'Media Fixture.pdf',
    importedAt,
    false,
    {},
    { pictureClassificationRequested: true, pictureClassificationApplied: true, visualAssetPolicy: 'source-backed' },
  )

  assert.equal(Object.keys(normalized.document.assets).length, 0)
  assert.equal(Object.keys(normalized.assets).length, 0)
  assert.equal(normalized.stats.imageBlocks, 0)
  assert.equal(normalized.stats.chartBlocks, 1)
  assert.equal(normalized.stats.pictureItems, 2)
  assert.equal(normalized.stats.pictureItemsNotYetMapped, 2)
  const importer = normalized.document.metadata.importer as Record<string, unknown>
  assert.equal(importer.visualAssetPolicy, 'source-backed')
  assert.equal(importer.visualAuthority, 'retained-source-pages')

  const chart = normalized.document.blocks.find(block => block.type === 'chart')
  assert.ok(chart?.type === 'chart')
  assert.equal(chart.fallbackAssetId, undefined)
  assert.equal((chart.spec.extraction as Record<string, unknown>).status, 'structured-data-and-source-region')
  const regions = regionEvidenceState(normalized.document)
  assert.equal(regions.summary.total, 4)
  assert.equal(regions.summary.byKind.figure, 1)
  assert.equal(regions.summary.byKind.chart, 1)
  assert.equal(regions.summary.byKind.caption, 2)
  assert.ok(regions.regions.every(region => region.unattendedUse === 'review-required'))
  const captions = regions.regions.filter(region => region.kind === 'caption')
  assert.ok(captions.every(region => region.semanticLevel === 'part' && region.defaultVisibility === 'visible'))
  assert.ok(captions.every(region => region.parentRegionId && region.sourceBlockId))
  assert.deepEqual(
    [...new Set(captions.map(region => region.structuredData?.canonicalTextOwner))].sort(),
    ['parent-block-caption', 'parent-region-description'],
  )

  const packageBytes = await packAndoc({ document: normalized.document, sources: normalized.sources })
  const pkg = await readAndoc(packageBytes)
  assert.equal((await validateAndoc(packageBytes)).ok, true)
  assert.equal(pkg.manifest.entries.filter(entry => entry.role === 'asset').length, 0)
  assert((normalized.document.metadata.importWarnings as string[]).some(warning => /without duplicate raster assets/.test(warning)))
})

test('PDF normalization preserves table captions and reconciles duplicate picture-table classifications', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-import-fixture.pdf')))
  const tableBox = { l: 71, b: 120, r: 541, t: 620, coord_origin: 'BOTTOMLEFT' as const }
  const fixture: DoclingDocument = {
    schema_name: 'DoclingDocument',
    version: '1.9.0',
    name: 'table-reconciliation-fixture',
    pages: { '1': { size: { width: 612, height: 792 } } },
    texts: [
      { self_ref: '#/texts/0', label: 'title', text: 'Table Reconciliation Fixture', prov: [{ page_no: 1, bbox: { l: 72, b: 700, r: 400, t: 730, coord_origin: 'BOTTOMLEFT' } }] },
      { self_ref: '#/texts/1', label: 'caption', text: 'Table 17. Medium-Term Actions', prov: [{ page_no: 1, bbox: { l: 72, b: 630, r: 400, t: 650, coord_origin: 'BOTTOMLEFT' } }] },
    ],
    tables: [{
      self_ref: '#/tables/0',
      label: 'table',
      captions: [{ $ref: '#/texts/1' }],
      prov: [{ page_no: 1, bbox: tableBox }],
      data: { grid: [[{ text: 'Action', column_header: true }, { text: 'Outcome', column_header: true }], [{ text: 'Build', column_header: false }, { text: 'Capacity', column_header: false }]] },
    }],
    pictures: [{
      self_ref: '#/pictures/0',
      label: 'picture',
      prov: [{ page_no: 1, bbox: tableBox }],
      meta: { classification: { predictions: [{ class_name: 'table', confidence: 0.999 }] } },
    }],
  }
  const normalized = normalizeDoclingDocument(
    fixture,
    pdfBytes,
    'Table Reconciliation.pdf',
    importedAt,
    false,
    {},
    { pictureClassificationRequested: true, pictureClassificationApplied: true, visualAssetPolicy: 'source-backed' },
  )

  const table = normalized.document.blocks.find(block => block.type === 'table')
  assert.ok(table?.type === 'table')
  assert.equal(table.caption?.[0]?.text, 'Table 17. Medium-Term Actions')
  assert.equal(normalized.document.blocks.some(block => block.type === 'paragraph' && block.content[0]?.text === 'Table 17. Medium-Term Actions'), false)
  assert.equal(normalized.stats.pictureItemsNotYetMapped, 0)
  const regions = regionEvidenceState(normalized.document)
  assert.equal(regions.summary.total, 2)
  assert.equal(regions.summary.byKind.table, 1)
  assert.equal(regions.summary.byKind.caption, 1)
  assert.equal(regions.summary.byKind.figure, 0)
  const tableRegion = regions.regions.find(region => region.kind === 'table')
  const captionRegion = regions.regions.find(region => region.kind === 'caption')
  assert.equal(tableRegion?.sourceBlockId, table.id)
  assert.equal(tableRegion?.description, 'Table 17. Medium-Term Actions')
  assert.equal(captionRegion?.sourceBlockId, table.id)
  assert.equal(captionRegion?.parentRegionId, tableRegion?.id)
  assert.equal(captionRegion?.description, 'Table 17. Medium-Term Actions')
  assert.equal(captionRegion?.transcription, undefined)
  assert.equal(captionRegion?.semanticLevel, 'part')
  assert.equal(captionRegion?.defaultVisibility, 'visible')
  assert((normalized.document.metadata.importWarnings as string[]).some(warning => /duplicate table picture detection.*reconciled/i.test(warning)))
})

test('an explicit chart caption preserves chart semantics when optional picture classification is unavailable', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-fixture.pdf')))
  const photoBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-photo.png')))
  const chartBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-chart.png')))
  const fallbackFixture = structuredClone(mediaDoclingFixture)
  const chartPicture = fallbackFixture.pictures?.[1]
  assert.ok(chartPicture)
  chartPicture.meta = {}

  const normalized = normalizeDoclingDocument(fallbackFixture, pdfBytes, 'Media Fixture.pdf', importedAt, false, {
    '#/pictures/0': { bytes: photoBytes, mediaType: 'image/png' },
    '#/pictures/1': { bytes: chartBytes, mediaType: 'image/png' },
  }, { pictureClassificationRequested: true, pictureClassificationApplied: false })
  const chart = normalized.document.blocks.find(block => block.type === 'chart')

  assert.ok(chart?.type === 'chart')
  assert.equal(chart.spec.chartType, 'chart')
  assert.equal(chart.spec.data, null)
  assert.equal((chart.spec.extraction as Record<string, unknown>).status, 'classified-fallback-only')
  assert.equal(chart.fallbackAssetId ? normalized.document.assets[chart.fallbackAssetId]?.sha256.length : 0, 64)
})

test('a shared media metadata transaction preserves media and original PDF bytes while advancing revision history', async () => {
  const pdfBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-fixture.pdf')))
  const photoBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-photo.png')))
  const chartBytes = new Uint8Array(await readFile(path.join(fixtureRoot, 'pdf-media-chart.png')))
  const normalized = normalizeDoclingDocument(mediaDoclingFixture, pdfBytes, 'Media Fixture.pdf', importedAt, false, {
    '#/pictures/0': { bytes: photoBytes, mediaType: 'image/png' },
    '#/pictures/1': { bytes: chartBytes, mediaType: 'image/png' },
  })
  const before = await readAndoc(await packAndoc({ document: normalized.document, assets: normalized.assets, sources: normalized.sources }))
  const image = before.document.blocks.find(block => block.type === 'image')
  assert.ok(image && image.type === 'image')
  const transaction: AndocTransaction = {
    schema: 'andoc.transaction.v1',
    id: 'tx-human-media-001',
    baseRevision: 0,
    actor: { type: 'human', id: 'local-human-editor' },
    timestamp: '2026-07-15T12:05:00.000Z',
    message: 'Human edits imported image metadata',
    operations: [{ op: 'updateMediaMetadata', targetId: image.id, patch: { alt: 'Human-reviewed North Ridge wind site', caption: [{ text: 'Updated without replacing image bytes.' }] } }],
  }
  const result = await transactAndocPackage(before, transaction)
  const after = await readAndoc(result.packageBytes)

  assert.equal(after.document.revision, 1)
  assert.equal(after.transactions.length, 1)
  assert.equal(after.transactions[0]?.id, transaction.id)
  const editedImage = after.document.blocks.find(block => block.id === image.id)
  assert.ok(editedImage?.type === 'image')
  assert.equal(editedImage.alt, 'Human-reviewed North Ridge wind site')
  assert.equal(editedImage.caption?.[0]?.text, 'Updated without replacing image bytes.')
  assert.equal(editedImage.provenance?.kind, 'human')
  assert.deepEqual(after.files[normalized.sourcePath], before.files[normalized.sourcePath])
  for (const asset of Object.values(before.document.assets)) assert.deepEqual(after.files[asset.packagePath], before.files[asset.packagePath])
  assert.equal((await validateAndoc(result.packageBytes)).ok, true)
})
