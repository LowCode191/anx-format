import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import { chartDataEvidenceFromSpec, structuredChartDataFromSpec } from './chart-data.js'
import { blocksForDerivedView } from './block-visibility.js'
import { readAndoc } from './package.js'
import type { AndocAsset, AndocBlock, AndocDocument, ListItem, TableCell, TextRun } from './types.js'

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 54
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const FOOTER_SPACE = 34
const STABLE_DATE = new Date('1980-01-02T00:00:00.000Z')

interface Fonts {
  regular: PDFFont
  bold: PDFFont
  italic: PDFFont
}

interface PreparedTableCell {
  cell: TableCell | undefined
  font: PDFFont
  lines: string[]
}

interface PreparedTableRow {
  cells: PreparedTableCell[]
  height: number
}

interface PdfExportInput {
  document: AndocDocument
  assets?: Record<string, Uint8Array>
}

export interface PdfExportResult {
  bytes: Uint8Array
  pageCount: number
  revision: number
}

export async function exportAndocPdf(input: string | Uint8Array): Promise<PdfExportResult> {
  const pkg = await readAndoc(input)
  const assets = Object.fromEntries(Object.values(pkg.document.assets).flatMap(asset => {
    const bytes = pkg.files[asset.packagePath]
    return bytes ? [[asset.id, bytes] as const] : []
  }))
  return renderAndocPdf({ document: pkg.document, assets })
}

export async function renderAndocPdf(input: PdfExportInput): Promise<PdfExportResult> {
  const pdf = await PDFDocument.create({ updateMetadata: false })
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  }
  const renderer = new Renderer(pdf, fonts, input.document, input.assets || {})
  await renderer.render()
  renderer.addFooters()

  const date = stableDocumentDate(input.document.updatedAt)
  pdf.setTitle(pdfText(input.document.title, fonts.regular))
  pdf.setAuthor('ANX')
  pdf.setCreator('Studio 0.4.0')
  pdf.setProducer('ANX deterministic PDF exporter')
  pdf.setCreationDate(date)
  pdf.setModificationDate(date)
  const bytes = await pdf.save({ useObjectStreams: false, objectsPerTick: Number.POSITIVE_INFINITY, addDefaultPage: false, updateFieldAppearances: false })
  return { bytes, pageCount: pdf.getPageCount(), revision: input.document.revision }
}

class Renderer {
  private page!: PDFPage
  private y = 0

  constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: Fonts,
    private readonly document: AndocDocument,
    private readonly assets: Record<string, Uint8Array>,
  ) {}

  async render(): Promise<void> {
    this.newPage()
    this.drawWrapped(this.document.title, { font: this.fonts.bold, size: 24, lineHeight: 29, color: rgb(0.05, 0.09, 0.16), after: 14 })
    for (const block of blocksForDerivedView(this.document)) await this.drawBlock(block)
  }

  addFooters(): void {
    const pages = this.pdf.getPages()
    pages.forEach((page, index) => {
      const label = `ANX | Revision ${this.document.revision} | Page ${index + 1} of ${pages.length}`
      const size = 8
      page.drawLine({ start: { x: MARGIN, y: 31 }, end: { x: PAGE_WIDTH - MARGIN, y: 31 }, thickness: 0.5, color: rgb(0.82, 0.84, 0.87) })
      page.drawText(pdfText(label, this.fonts.regular), { x: MARGIN, y: 18, size, font: this.fonts.regular, color: rgb(0.39, 0.42, 0.47) })
    })
  }

  private async drawBlock(block: AndocBlock): Promise<void> {
    switch (block.type) {
      case 'heading': {
        const sizes = [0, 20, 17, 14.5, 13, 12, 11]
        const size = sizes[block.level] || 12
        this.ensure(size * 2.5)
        this.y -= block.level === 1 ? 11 : 8
        this.drawWrapped(textFromRuns(block.content), { font: this.fonts.bold, size, lineHeight: size * 1.25, color: rgb(0.07, 0.12, 0.2), after: 6 })
        return
      }
      case 'paragraph':
        this.drawWrapped(textFromRuns(block.content), { font: this.fonts.regular, size: 10.5, lineHeight: 15, color: rgb(0.12, 0.14, 0.17), after: 8 })
        return
      case 'list':
        this.drawList(block.items, block.ordered, block.start || 1)
        return
      case 'footnote':
        this.drawWrapped(`${block.label} ${textFromRuns(block.content)}`, { font: this.fonts.italic, size: 8.5, lineHeight: 11, color: rgb(0.35, 0.37, 0.4), before: 2, after: 7 })
        return
      case 'extension':
        this.drawWrapped(`Extension fallback (${block.extensionId}@${block.version}): ${textFromRuns(block.fallback)}`, { font: this.fonts.regular, size: 9.5, lineHeight: 13, color: rgb(0.25, 0.27, 0.3), before: 3, after: 8 })
        return
      case 'table':
        this.drawTable(block.rows, block.caption)
        return
      case 'image':
        await this.drawMedia(block.assetId, block.alt, block.caption)
        return
      case 'chart': {
        if (block.fallbackAssetId) await this.drawMedia(block.fallbackAssetId, block.alt, block.caption)
        else this.drawPlaceholder(block.alt)
        const data = structuredChartDataFromSpec(block.spec)
        if (data) {
          const evidence = chartDataEvidenceFromSpec(block.spec)
          const label = `${evidence?.verified ? 'Verified' : 'Unverified'} structured chart data${evidence?.source ? ` | Source: ${evidence.source}` : ''}${typeof evidence?.confidence === 'number' ? ` | Confidence: ${Math.round(evidence.confidence * 100)}%` : ''}`
          this.drawWrapped(label, { font: this.fonts.bold, size: 8.5, lineHeight: 11, color: evidence?.verified ? rgb(0.04, 0.39, 0.3) : rgb(0.55, 0.3, 0.03), before: 3, after: 4 })
          const rows: TableCell[][] = [
            data.columns.map((column, index) => ({ id: `${block.id}-header-${index}`, header: true, content: [{ text: column }] })),
            ...data.rows.map((row, rowIndex) => row.map((value, columnIndex) => ({ id: `${block.id}-${rowIndex}-${columnIndex}`, content: [{ text: value === null ? '' : String(value) }] }))),
          ]
          this.drawTable(rows)
          if (evidence?.notes) this.drawWrapped(evidence.notes, { font: this.fonts.italic, size: 8.5, lineHeight: 11, color: rgb(0.35, 0.37, 0.4), after: 6 })
        }
        return
      }
      case 'pageBreak':
        this.newPage()
    }
  }

  private drawList(items: ListItem[], ordered: boolean, start: number, depth = 0): void {
    items.forEach((item, index) => {
      const marker = ordered ? `${start + index}.` : '•'
      const indent = Math.min(depth, 4) * 18
      this.drawWrapped(`${marker} ${textFromRuns(item.content)}`, {
        font: this.fonts.regular,
        size: 10.5,
        lineHeight: 15,
        color: rgb(0.12, 0.14, 0.17),
        x: MARGIN + indent,
        width: CONTENT_WIDTH - indent,
        after: item.children?.length ? 1 : 4,
      })
      if (item.children?.length) this.drawList(item.children, ordered, 1, depth + 1)
    })
    if (depth === 0) this.y -= 4
  }

  private drawWrapped(text: string, options: {
    font: PDFFont
    size: number
    lineHeight: number
    color: ReturnType<typeof rgb>
    before?: number
    after?: number
    x?: number
    width?: number
  }): void {
    const value = pdfText(text, options.font)
    if (!value) {
      this.y -= options.after || 0
      return
    }
    this.y -= options.before || 0
    const width = options.width || CONTENT_WIDTH
    const x = options.x || MARGIN
    const lines = wrapText(value, options.font, options.size, width)
    for (const line of lines) {
      this.ensure(options.lineHeight)
      this.page.drawText(line, { x, y: this.y - options.size, size: options.size, font: options.font, color: options.color })
      this.y -= options.lineHeight
    }
    this.y -= options.after || 0
  }

  private drawTable(rows: TableCell[][], caption?: TextRun[]): void {
    if (!rows.length) return
    const columns = Math.max(...rows.map(row => row.length), 1)
    const cellWidth = CONTENT_WIDTH / columns
    const fontSize = 8.5
    const lineHeight = 11
    const padding = 5
    const preparedRows: PreparedTableRow[] = rows.map(row => {
      const cells = Array.from({ length: columns }, (_, index) => {
        const cell = row[index]
        const font = cell?.header ? this.fonts.bold : this.fonts.regular
        return { cell, font, lines: wrapText(pdfText(cell ? textFromRuns(cell.content) : '', font), font, fontSize, cellWidth - padding * 2) }
      })
      return { cells, height: Math.max(24, ...cells.map(value => Math.max(1, value.lines.length) * lineHeight + padding * 2)) }
    })
    const captionValue = caption?.length ? pdfText(textFromRuns(caption), this.fonts.italic) : ''
    const captionHeight = captionValue
      ? wrapText(captionValue, this.fonts.italic, 8.5, CONTENT_WIDTH).length * 11 + 7
      : 0
    const bottom = MARGIN + FOOTER_SPACE
    const fullPageCapacity = PAGE_HEIGHT - MARGIN - bottom
    const totalHeight = 4 + preparedRows.reduce((sum, row) => sum + row.height, 0) + 5 + captionHeight
    if (totalHeight <= fullPageCapacity && this.y - totalHeight < bottom) this.newPage()
    this.y -= 4

    const repeatedHeader = rows[0]?.some(cell => cell?.header) ? preparedRows[0] : undefined
    preparedRows.forEach((row, rowIndex) => {
      const trailingHeight = rowIndex === preparedRows.length - 1 ? 5 + captionHeight : 0
      if (this.y - row.height - trailingHeight < bottom) {
        this.newPage()
        if (rowIndex > 0 && repeatedHeader && repeatedHeader.height + row.height + trailingHeight <= fullPageCapacity) {
          this.drawPreparedTableRow(repeatedHeader, cellWidth, fontSize, lineHeight, padding)
        }
      }
      this.drawPreparedTableRow(row, cellWidth, fontSize, lineHeight, padding)
    })
    this.y -= 5
    if (captionValue) {
      this.drawWrapped(captionValue, { font: this.fonts.italic, size: 8.5, lineHeight: 11, color: rgb(0.35, 0.37, 0.4), after: 7 })
    }
  }

  private drawPreparedTableRow(row: PreparedTableRow, cellWidth: number, fontSize: number, lineHeight: number, padding: number): void {
    const top = this.y
    row.cells.forEach(({ cell, font, lines }, index) => {
      const x = MARGIN + index * cellWidth
      if (cell?.header) this.page.drawRectangle({ x, y: top - row.height, width: cellWidth, height: row.height, color: rgb(0.91, 0.95, 0.97) })
      this.page.drawRectangle({ x, y: top - row.height, width: cellWidth, height: row.height, borderWidth: 0.5, borderColor: rgb(0.72, 0.74, 0.77) })
      lines.forEach((line, lineIndex) => this.page.drawText(line, { x: x + padding, y: top - padding - fontSize - lineIndex * lineHeight, size: fontSize, font, color: rgb(0.12, 0.14, 0.17) }))
    })
    this.y -= row.height
  }

  private async drawMedia(assetId: string, alt: string, caption?: TextRun[]): Promise<void> {
    const asset = this.document.assets[assetId]
    const bytes = this.assets[assetId]
    if (!asset || !bytes) {
      this.drawPlaceholder(alt)
      return
    }
    const image = await this.embedImage(asset, bytes)
    if (!image) {
      this.drawPlaceholder(`${alt} (${asset.mediaType} preview unavailable in PDF export)`)
      return
    }
    const maximumHeight = 290
    const scale = Math.min(CONTENT_WIDTH / image.width, maximumHeight / image.height, 1)
    const width = image.width * scale
    const height = image.height * scale
    if (this.y - height < MARGIN + FOOTER_SPACE) this.newPage()
    this.page.drawImage(image, { x: MARGIN + (CONTENT_WIDTH - width) / 2, y: this.y - height, width, height })
    this.y -= height + 4
    if (caption?.length) this.drawWrapped(textFromRuns(caption), { font: this.fonts.italic, size: 8.5, lineHeight: 11, color: rgb(0.35, 0.37, 0.4), after: 7 })
  }

  private async embedImage(asset: AndocAsset, bytes: Uint8Array) {
    if (asset.mediaType === 'image/png') return this.pdf.embedPng(bytes)
    if (asset.mediaType === 'image/jpeg' || asset.mediaType === 'image/jpg') return this.pdf.embedJpg(bytes)
    return null
  }

  private drawPlaceholder(label: string): void {
    const height = 92
    this.ensure(height + 10)
    this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: CONTENT_WIDTH, height, color: rgb(0.97, 0.97, 0.98), borderColor: rgb(0.65, 0.67, 0.7), borderWidth: 0.8, borderDashArray: [4, 3] })
    const lines = wrapText(pdfText(label, this.fonts.italic), this.fonts.italic, 9, CONTENT_WIDTH - 24)
    lines.slice(0, 5).forEach((line, index) => this.page.drawText(line, { x: MARGIN + 12, y: this.y - 23 - index * 13, size: 9, font: this.fonts.italic, color: rgb(0.35, 0.37, 0.4) }))
    this.y -= height + 8
  }

  private ensure(height: number): void {
    if (this.y - height < MARGIN + FOOTER_SPACE) this.newPage()
  }

  private newPage(): void {
    this.page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    this.y = PAGE_HEIGHT - MARGIN
  }
}

function textFromRuns(runs: TextRun[] = []): string {
  return runs.map(run => run.text).join('')
}

function stableDocumentDate(value: string): Date {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? STABLE_DATE : date
}

function pdfText(value: string, font: PDFFont): string {
  return [...value.normalize('NFKC')].map(character => {
    if (character === '\n' || character === '\t' || character === '\r') return character === '\t' ? ' ' : character
    try {
      font.encodeText(character)
      return character
    } catch {
      return '?'
    }
  }).join('')
}

function wrapText(value: string, font: PDFFont, size: number, maximumWidth: number): string[] {
  const paragraphs = value.split(/\r?\n/)
  const lines: string[] = []
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maximumWidth) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      if (font.widthOfTextAtSize(word, size) <= maximumWidth) {
        line = word
        continue
      }
      let fragment = ''
      for (const character of word) {
        const candidateFragment = fragment + character
        if (fragment && font.widthOfTextAtSize(candidateFragment, size) > maximumWidth) {
          lines.push(fragment)
          fragment = character
        } else fragment = candidateFragment
      }
      line = fragment
    }
    if (line || !words.length) lines.push(line)
    if (paragraphIndex < paragraphs.length - 1 && paragraph) lines.push('')
  })
  return lines.length ? lines : ['']
}
