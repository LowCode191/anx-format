import { strToU8, zipSync } from 'fflate'
import type { AndocBlock, AndocDocument, ListItem, TextRun } from './types.js'
import type { AndocPackage } from './package.js'

const FIXED_ZIP_TIME = new Date('1980-01-02T00:00:00.000Z')

export interface PortableExportResult {
  bytes: Uint8Array
  mediaType: string
  extension: 'docx' | 'md' | 'jsonl'
  revision: number
  warnings: string[]
}

export function exportAnxMarkdown(pkg: AndocPackage): PortableExportResult {
  const lines = [`# ${pkg.document.title}`, '', `<!-- ANX ${pkg.document.documentId} revision ${pkg.document.revision} -->`, '']
  for (const block of pkg.document.blocks) lines.push(...markdownBlock(block), '')
  return { bytes: strToU8(`${lines.join('\n').trim()}\n`), mediaType: 'text/markdown; charset=utf-8', extension: 'md', revision: pkg.document.revision, warnings: ['Visual assets are represented by stable ANX asset references; export the package assets separately when standalone media files are required.'] }
}

export function exportAnxJsonl(pkg: AndocPackage): PortableExportResult {
  const records: unknown[] = [{ schema: 'anx.jsonl.v1', recordType: 'document', documentId: pkg.document.documentId, revision: pkg.document.revision, title: pkg.document.title, locale: pkg.document.locale, metadata: pkg.document.metadata }]
  pkg.document.blocks.forEach((block, index) => {
    records.push({ schema: 'anx.jsonl.v1', recordType: 'block', documentId: pkg.document.documentId, revision: pkg.document.revision, index, nodeId: block.id, block })
    if (block.type === 'table') block.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => records.push({ schema: 'anx.jsonl.v1', recordType: 'table-cell', documentId: pkg.document.documentId, revision: pkg.document.revision, blockId: block.id, nodeId: cell.id, rowIndex, columnIndex, cell })))
  })
  return { bytes: strToU8(`${records.map(record => JSON.stringify(record)).join('\n')}\n`), mediaType: 'application/x-ndjson; charset=utf-8', extension: 'jsonl', revision: pkg.document.revision, warnings: [] }
}

export function exportAnxDocx(pkg: AndocPackage): PortableExportResult {
  const media: Array<{ relationshipId: string; target: string; mediaType: string; bytes: Uint8Array; alt: string; widthEmu: number; heightEmu: number }> = []
  let drawingId = 1
  const body: string[] = [paragraphXml([{ text: pkg.document.title }], 'Title'), paragraphXml([{ text: `ANX revision ${pkg.document.revision}` }], 'Subtitle')]
  for (const block of pkg.document.blocks) {
    if (block.type === 'heading') body.push(paragraphXml(block.content, `Heading${Math.min(3, block.level)}`))
    else if (block.type === 'paragraph') body.push(paragraphXml(block.content))
    else if (block.type === 'list') body.push(...listXml(block.items, block.ordered, 0))
    else if (block.type === 'footnote') body.push(paragraphXml([{ text: `[${block.label}] `, marks: ['bold'] }, ...block.content], 'FootnoteText'))
    else if (block.type === 'extension') body.push(paragraphXml([{ text: `[${block.extensionId}@${block.version}] `, marks: ['bold'] }, ...block.fallback]))
    else if (block.type === 'table') {
      if (block.caption?.length) body.push(paragraphXml(block.caption, 'Caption'))
      body.push(tableXml(block.rows.map(row => row.map(cell => ({ text: runsText(cell.content), header: cell.header === true })))))
    } else if (block.type === 'image' || block.type === 'chart') {
      const assetId = block.type === 'image' ? block.assetId : block.fallbackAssetId
      const asset = assetId ? pkg.document.assets[assetId] : undefined
      const bytes = asset ? pkg.files[asset.packagePath] : undefined
      if (asset && bytes && (asset.mediaType === 'image/png' || asset.mediaType === 'image/jpeg')) {
        const dimensions = imageDimensions(bytes, asset.mediaType)
        const fitted = fitImage(dimensions.width, dimensions.height)
        const relationshipId = `rId${100 + media.length}`
        const extension = asset.mediaType === 'image/png' ? 'png' : 'jpg'
        const target = `media/${safeName(asset.id)}.${extension}`
        media.push({ relationshipId, target, mediaType: asset.mediaType, bytes, alt: block.alt, ...fitted })
        body.push(drawingXml(relationshipId, drawingId++, block.alt, fitted.widthEmu, fitted.heightEmu))
      } else body.push(paragraphXml([{ text: `[Visual: ${block.alt}]`, marks: ['italic'] }]))
      if (block.caption?.length) body.push(paragraphXml(block.caption, 'Caption'))
      if (block.type === 'chart') {
        const chartData = structuredChartData(block.spec)
        if (chartData) body.push(tableXml([chartData.columns.map(text => ({ text, header: true })), ...chartData.rows.map(row => row.map(value => ({ text: value === null ? '' : String(value), header: false })))]))
      }
    } else body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
  }

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypesXml(media)),
    '_rels/.rels': strToU8(packageRelationshipsXml()),
    'word/document.xml': strToU8(documentXml(body.join(''))),
    'word/_rels/document.xml.rels': strToU8(documentRelationshipsXml(media)),
    'word/styles.xml': strToU8(stylesXml()),
    'word/numbering.xml': strToU8(numberingXml()),
    'docProps/core.xml': strToU8(corePropertiesXml(pkg.document)),
    'docProps/app.xml': strToU8(appPropertiesXml()),
  }
  for (const item of media) files[`word/${item.target}`] = item.bytes
  const bytes = zipSync(Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))), { level: 6, mtime: FIXED_ZIP_TIME })
  return { bytes, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx', revision: pkg.document.revision, warnings: ['DOCX is a deterministic interoperability projection. ANX stable IDs, transaction semantics, source evidence, and finalization remain authoritative only in the .anx package.'] }
}

/** @deprecated Use exportAnxMarkdown. */
export const exportAgnMarkdown = exportAnxMarkdown
/** @deprecated Use exportAnxJsonl. */
export const exportAgnJsonl = exportAnxJsonl
/** @deprecated Use exportAnxDocx. */
export const exportAgnDocx = exportAnxDocx

function markdownBlock(block: AndocBlock): string[] {
  if (block.type === 'heading') return [`${'#'.repeat(block.level)} ${runsMarkdown(block.content)}`]
  if (block.type === 'paragraph') return [runsMarkdown(block.content)]
  if (block.type === 'list') return listMarkdown(block.items, block.ordered)
  if (block.type === 'footnote') return [`[^${block.label}]: ${runsMarkdown(block.content)}`]
  if (block.type === 'extension') return [`> ${runsMarkdown(block.fallback)}`, `> ANX extension: ${block.extensionId}@${block.version}`]
  if (block.type === 'image') return [`![${escapeMarkdown(block.alt)}](anx-asset:${block.assetId})`, ...(block.caption?.length ? [`*${runsMarkdown(block.caption)}*`] : [])]
  if (block.type === 'chart') {
    const lines = [`![${escapeMarkdown(block.alt)}](${block.fallbackAssetId ? `anx-asset:${block.fallbackAssetId}` : 'anx-chart:no-fallback'})`, ...(block.caption?.length ? [`*${runsMarkdown(block.caption)}*`] : [])]
    const data = structuredChartData(block.spec)
    if (data) lines.push('', ...markdownTable(data.columns, data.rows))
    return lines
  }
  if (block.type === 'table') return [...(block.caption?.length ? [`*${runsMarkdown(block.caption)}*`, ''] : []), ...markdownTable(block.rows[0]?.map(cell => runsText(cell.content)) || [], block.rows.slice(1).map(row => row.map(cell => runsText(cell.content))))]
  return ['---']
}

function listMarkdown(items: ListItem[], ordered: boolean, depth = 0): string[] {
  const result: string[] = []
  items.forEach((item, index) => {
    result.push(`${'  '.repeat(depth)}${ordered ? `${index + 1}.` : '-'} ${runsMarkdown(item.content)}`)
    if (item.children?.length) result.push(...listMarkdown(item.children, ordered, depth + 1))
  })
  return result
}

function markdownTable(columns: string[], rows: Array<Array<string | number | null>>): string[] {
  if (!columns.length) return ['<!-- Empty table -->']
  const header = `| ${columns.map(value => escapeMarkdownTable(String(value))).join(' | ')} |`
  const divider = `| ${columns.map(() => '---').join(' | ')} |`
  return [header, divider, ...rows.map(row => `| ${columns.map((_, index) => escapeMarkdownTable(String(row[index] ?? ''))).join(' | ')} |`)]
}

function runsMarkdown(runs: TextRun[]): string {
  return runs.map(run => {
    let text = escapeMarkdown(run.text)
    if (run.marks?.includes('code')) text = `\`${text.replaceAll('`', '\\`')}\``
    if (run.marks?.includes('bold')) text = `**${text}**`
    if (run.marks?.includes('italic')) text = `*${text}*`
    if (run.href) text = `[${text}](${run.href})`
    return text
  }).join('')
}

function paragraphXml(runs: TextRun[], style?: string, numbering?: { id: number; level: number }): string {
  const properties = style || numbering ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${numbering ? `<w:numPr><w:ilvl w:val="${numbering.level}"/><w:numId w:val="${numbering.id}"/></w:numPr>` : ''}</w:pPr>` : ''
  return `<w:p>${properties}${runs.map(runXml).join('')}</w:p>`
}

function runXml(run: TextRun): string {
  const marks = new Set(run.marks || [])
  const properties = [marks.has('bold') ? '<w:b/>' : '', marks.has('italic') ? '<w:i/>' : '', marks.has('underline') ? '<w:u w:val="single"/>' : '', marks.has('strike') ? '<w:strike/>' : '', marks.has('code') ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : '', marks.has('superscript') ? '<w:vertAlign w:val="superscript"/>' : '', marks.has('subscript') ? '<w:vertAlign w:val="subscript"/>' : ''].join('')
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`
}

function listXml(items: ListItem[], ordered: boolean, level: number): string[] {
  return items.flatMap(item => [paragraphXml(item.content, undefined, { id: ordered ? 2 : 1, level: Math.min(8, level) }), ...listXml(item.children || [], ordered, level + 1)])
}

function tableXml(rows: Array<Array<{ text: string; header: boolean }>>): string {
  const columns = Math.max(1, ...rows.map(row => row.length))
  const width = Math.floor(9360 / columns)
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')
  const rowXml = rows.map(row => `<w:tr>${Array.from({ length: columns }, (_, index) => {
    const cell = row[index] || { text: '', header: false }
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>${cell.header ? '<w:shd w:fill="F2F4F7"/>' : ''}</w:tcPr>${paragraphXml([{ text: cell.text, ...(cell.header ? { marks: ['bold'] as const } : {}) }])}</w:tc>`
  }).join('')}</w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblInd w:w="120" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B7C0CC"/><w:left w:val="single" w:sz="4" w:color="B7C0CC"/><w:bottom w:val="single" w:sz="4" w:color="B7C0CC"/><w:right w:val="single" w:sz="4" w:color="B7C0CC"/><w:insideH w:val="single" w:sz="4" w:color="D7DCE3"/><w:insideV w:val="single" w:sz="4" w:color="D7DCE3"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rowXml}</w:tbl>`
}

function drawingXml(relationshipId: string, drawingId: number, alt: string, widthEmu: number, heightEmu: number): string {
  const safeAlt = xmlEscape(alt)
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="${drawingId}" name="ANX visual ${drawingId}" descr="${safeAlt}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="ANX visual ${drawingId}" descr="${safeAlt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

function contentTypesXml(media: Array<{ mediaType: string }>): string {
  const defaults = new Set(media.map(item => item.mediaType === 'image/png' ? '<Default Extension="png" ContentType="image/png"/>' : '<Default Extension="jpg" ContentType="image/jpeg"/>'))
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...defaults].join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`
}

function packageRelationshipsXml(): string { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` }

function documentRelationshipsXml(media: Array<{ relationshipId: string; target: string }>): string { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${media.map(item => `<Relationship Id="${item.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${item.target}"/>`).join('')}</Relationships>` }

function documentXml(body: string): string { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>` }

function stylesXml(): string { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${styleXml('Normal','Normal',22,'000000',0,120,false)}${styleXml('Title','Title',48,'000000',0,160,true)}${styleXml('Subtitle','Subtitle',20,'666666',0,240,false)}${styleXml('Heading1','Heading 1',32,'2E74B5',320,160,true,1)}${styleXml('Heading2','Heading 2',26,'2E74B5',240,120,true,2)}${styleXml('Heading3','Heading 3',24,'1F4D78',160,80,true,3)}${styleXml('Caption','Caption',20,'555555',80,80,false)}${styleXml('FootnoteText','Footnote Text',18,'555555',0,80,false)}</w:styles>` }

function styleXml(id: string, name: string, size: number, color: string, before: number, after: number, bold: boolean, outline?: number): string { return `<w:style w:type="paragraph" w:styleId="${id}"${id === 'Normal' ? ' w:default="1"' : ''}><w:name w:val="${name}"/>${id === 'Normal' ? '' : '<w:basedOn w:val="Normal"/>'}<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="0" w:right="0" w:firstLine="0"/><w:jc w:val="left"/><w:spacing w:before="${before}" w:after="${after}" w:line="264" w:lineRule="auto"/>${outline ? `<w:outlineLvl w:val="${outline - 1}"/>` : ''}</w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/>${bold ? '<w:b/>' : ''}</w:rPr></w:style>` }

function numberingXml(): string { const levels = Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${720 + level * 360}"/></w:tabs><w:ind w:left="${720 + level * 360}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl>`).join(''); const decimal = Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${720 + level * 360}"/></w:tabs><w:ind w:left="${720 + level * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join(''); return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>${levels}</w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="multilevel"/>${decimal}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>` }

function corePropertiesXml(document: AndocDocument): string { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(document.title)}</dc:title><dc:creator>ANX deterministic exporter</dc:creator><cp:lastModifiedBy>ANX deterministic exporter</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${document.createdAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${document.updatedAt}</dcterms:modified><cp:revision>${document.revision}</cp:revision></cp:coreProperties>` }
function appPropertiesXml(): string { return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ANX</Application><AppVersion>0.4</AppVersion></Properties>` }

function structuredChartData(spec: Record<string, unknown>): { columns: string[]; rows: Array<Array<string | number | null>> } | null { const value = spec.data; if (!value || typeof value !== 'object' || Array.isArray(value)) return null; const data = value as Record<string, unknown>; if (!Array.isArray(data.columns) || !data.columns.every(item => typeof item === 'string') || !Array.isArray(data.rows)) return null; return { columns: data.columns as string[], rows: data.rows as Array<Array<string | number | null>> } }
function runsText(runs: TextRun[] | undefined): string { return (runs || []).map(run => run.text).join('') }
function escapeMarkdown(value: string): string { return value.replace(/([\\`*_[\]<>])/g, '\\$1').replaceAll('\n', '  \n') }
function escapeMarkdownTable(value: string): string { return escapeMarkdown(value).replaceAll('|', '\\|').replaceAll('\n', '<br>') }
function xmlEscape(value: string): string { return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;') }
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'asset' }
function imageDimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } { if (mediaType === 'image/png' && bytes.length >= 24) { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return { width: view.getUint32(16), height: view.getUint32(20) } } return { width: 1600, height: 900 } }
function fitImage(width: number, height: number): { widthEmu: number; heightEmu: number } { const maxWidth = 5.75 * 914400, maxHeight = 6.8 * 914400, scale = Math.min(maxWidth / Math.max(1, width), maxHeight / Math.max(1, height)); return { widthEmu: Math.round(width * scale), heightEmu: Math.round(height * scale) } }
