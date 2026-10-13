import type { AndocBlock, AndocDocument, TextRun } from './types.js'
import { chartDataEvidenceFromSpec, structuredChartDataFromSpec } from './chart-data.js'
import { blocksForDerivedView } from './block-visibility.js'

const MARK_ORDER = ['code', 'bold', 'italic', 'underline', 'strike', 'subscript', 'superscript'] as const

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderText(runs: TextRun[] = []): string {
  return runs.map(run => {
    let value = escapeHtml(run.text)
    const marks = new Set(run.marks || [])
    for (const mark of MARK_ORDER) {
      if (!marks.has(mark)) continue
      const tag = mark === 'bold' ? 'strong'
        : mark === 'italic' ? 'em'
          : mark === 'underline' ? 'u'
            : mark === 'strike' ? 's'
              : mark === 'subscript' ? 'sub'
                : mark === 'superscript' ? 'sup'
                  : 'code'
      value = `<${tag}>${value}</${tag}>`
    }
    const href = run.href ? safeHref(run.href) : null
    if (href) value = `<a href="${escapeHtml(href)}">${value}</a>`
    return value
  }).join('')
}

function renderCaption(caption?: TextRun[]): string {
  return caption?.length ? `<figcaption>${renderText(caption)}</figcaption>` : ''
}

function renderListItems(items: Extract<AndocBlock, { type: 'list' }>['items'], ordered: boolean): string {
  const tag = ordered ? 'ol' : 'ul'
  return items.map(item => `<li data-andoc-list-item-id="${escapeHtml(item.id)}">${renderText(item.content)}${item.children?.length ? `<${tag} class="andoc-nested-list">${renderListItems(item.children, ordered)}</${tag}>` : ''}</li>`).join('')
}

function listTextLength(items: Extract<AndocBlock, { type: 'list' }>['items']): number {
  return items.reduce((sum, item) => sum
    + item.content.reduce((itemSum, run) => itemSum + run.text.length, 0)
    + listTextLength(item.children || []), 0)
}

function renderChartData(block: Extract<AndocBlock, { type: 'chart' }>): string {
  const data = structuredChartDataFromSpec(block.spec)
  if (!data) return ''
  const evidence = chartDataEvidenceFromSpec(block.spec)
  const status = evidence?.verified ? 'Verified structured data' : 'Unverified structured data'
  const source = evidence?.source ? ` · Source: ${escapeHtml(evidence.source)}` : ''
  const confidence = typeof evidence?.confidence === 'number' ? ` · Confidence: ${Math.round(evidence.confidence * 100)}%` : ''
  return `<details class="andoc-chart-data" open><summary>${status}${source}${confidence}</summary><div class="andoc-chart-data-scroll"><table><thead><tr>${data.columns.map(column => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${data.rows.map(row => `<tr>${row.map(value => `<td>${value === null ? '' : escapeHtml(String(value))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${evidence?.notes ? `<p class="andoc-chart-data-notes">${escapeHtml(evidence.notes)}</p>` : ''}</details>`
}

function pageFurnitureAttributes(block: AndocBlock): string {
  const furniture = block.attrs?.pageFurniture
  if (!furniture || typeof furniture !== 'object' || Array.isArray(furniture)) return ''
  const values = furniture as Record<string, unknown>
  const role = typeof values.role === 'string' ? values.role : ''
  const occurrence = Number(values.occurrence)
  const recurring = values.recurring === true
  return `${role ? ` data-agn-furniture="${escapeHtml(role)}"` : ''}${recurring ? ' data-agn-recurring="true"' : ''}${Number.isInteger(occurrence) && occurrence > 0 ? ` data-agn-occurrence="${occurrence}"` : ''}`
}

function isHeaderFurniture(block: AndocBlock): boolean {
  const furniture = block.attrs?.pageFurniture
  return Boolean(furniture && typeof furniture === 'object' && !Array.isArray(furniture) && (furniture as Record<string, unknown>).role === 'header-logo')
}

function renderBlock(block: AndocBlock, document: AndocDocument): string {
  const id = escapeHtml(block.id)
  switch (block.type) {
    case 'paragraph':
      return `<p data-andoc-id="${id}">${renderText(block.content)}</p>`
    case 'heading': {
      const sectionNumber = typeof block.attrs?.sectionNumber === 'string'
        ? ` data-anx-section-number="${escapeHtml(block.attrs.sectionNumber)}"`
        : ''
      return `<h${block.level} data-andoc-id="${id}"${sectionNumber}>${renderText(block.content)}</h${block.level}>`
    }
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul'
      const start = block.ordered && block.start ? ` start="${block.start}"` : ''
      return `<${tag} class="andoc-list" data-andoc-id="${id}"${start}>${renderListItems(block.items, block.ordered)}</${tag}>`
    }
    case 'footnote': {
      const noteKind = escapeHtml(block.noteKind || 'footnote')
      const anchorStatus = escapeHtml(block.anchorStatus || 'unanchored')
      const anchors = block.anchorIds?.length ? ` data-anx-note-anchors="${escapeHtml(block.anchorIds.join(' '))}"` : ''
      return `<aside class="andoc-footnote" data-andoc-id="${id}" data-anx-note-kind="${noteKind}" data-anx-anchor-status="${anchorStatus}"${anchors} role="note"><span class="andoc-footnote-label">${escapeHtml(block.label)}</span> ${renderText(block.content)}</aside>`
    }
    case 'extension':
      return `<section class="andoc-extension-fallback" data-andoc-id="${id}" data-andoc-extension="${escapeHtml(block.extensionId)}" data-andoc-extension-version="${escapeHtml(block.version)}"><span class="andoc-extension-label">Extension fallback</span>${renderText(block.fallback)}</section>`
    case 'image':
      return `<figure data-andoc-id="${id}" data-andoc-asset="${escapeHtml(block.assetId)}"${pageFurnitureAttributes(block)}><img src="../${escapeHtml(document.assets[block.assetId]?.packagePath || block.assetId)}" alt="${escapeHtml(block.alt)}">${renderCaption(block.caption)}</figure>`
    case 'table':
      return `<figure data-andoc-id="${id}"><table>${block.caption?.length ? `<caption>${renderText(block.caption)}</caption>` : ''}${block.rows.map((row, rowIndex) => `<tr>${row.map(cell => {
        const tag = cell.header ? 'th' : 'td'
        const scope = cell.header ? ` scope="${rowIndex === 0 ? 'col' : 'row'}"` : ''
        const colspan = cell.colspan ? ` colspan="${cell.colspan}"` : ''
        const rowspan = cell.rowspan ? ` rowspan="${cell.rowspan}"` : ''
        return `<${tag}${scope}${colspan}${rowspan} data-andoc-cell-id="${escapeHtml(cell.id)}">${renderText(cell.content)}</${tag}>`
      }).join('')}</tr>`).join('')}</table></figure>`
    case 'chart': {
      const fallbackAsset = block.fallbackAssetId ? document.assets[block.fallbackAssetId] : undefined
      const visual = fallbackAsset
        ? `<img src="../${escapeHtml(fallbackAsset.packagePath)}" alt="${escapeHtml(block.alt)}">`
        : `<div class="andoc-chart-placeholder" role="img" aria-label="${escapeHtml(block.alt)}">${escapeHtml(block.alt)}</div>`
      return `<figure class="andoc-chart" data-andoc-id="${id}" data-andoc-chart-spec="${escapeHtml(JSON.stringify(block.spec))}">${visual}${renderCaption(block.caption)}${renderChartData(block)}</figure>`
    }
    case 'pageBreak':
      return `<hr class="andoc-page-break" data-andoc-id="${id}" aria-hidden="true">`
  }
}

interface RenderPage {
  number: number
  blocks: AndocBlock[]
}

function sourcePageCount(document: AndocDocument): number {
  const source = document.metadata.source
  if (!source || typeof source !== 'object' || Array.isArray(source)) return 1
  const count = Number((source as Record<string, unknown>).pageCount)
  return Number.isInteger(count) && count > 0 ? count : 1
}

function sourcePageSize(document: AndocDocument, page: number): { width: number; height: number } {
  const layout = document.metadata.layout
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return { width: 612, height: 792 }
  const sizes = (layout as Record<string, unknown>).sourcePageSizes
  if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) return { width: 612, height: 792 }
  const size = (sizes as Record<string, unknown>)[String(page)]
  if (!size || typeof size !== 'object' || Array.isArray(size)) return { width: 612, height: 792 }
  const width = Number((size as Record<string, unknown>).width)
  const height = Number((size as Record<string, unknown>).height)
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height } : { width: 612, height: 792 }
}

interface BlockGeometry {
  left: number
  top: number
  width: number
  height: number
  repaired: boolean
}

function sourceTitleBlock(document: AndocDocument): AndocBlock | undefined {
  const title = document.title.trim().replace(/\s+/g, ' ')
  return document.blocks.find(block => block.type === 'heading'
    && block.content.map(run => run.text).join('').trim().replace(/\s+/g, ' ') === title
    && Boolean(block.provenance?.bbox))
}

function blockTextLength(block: AndocBlock): number {
  if (block.type === 'paragraph' || block.type === 'heading') return block.content.reduce((sum, run) => sum + run.text.length, 0)
  if (block.type === 'list') return listTextLength(block.items)
  if (block.type === 'footnote') return block.label.length + block.content.reduce((sum, run) => sum + run.text.length, 0)
  if (block.type === 'extension') return block.fallback.reduce((sum, run) => sum + run.text.length, 0)
  if (block.type === 'image' || block.type === 'chart') return block.alt.length
  if (block.type === 'table') return block.rows.flat().reduce((sum, cell) => sum + cell.content.reduce((cellSum, run) => cellSum + run.text.length, 0), 0)
  return 0
}

function blockGeometry(block: AndocBlock, pageSize: { width: number; height: number }): BlockGeometry | null {
  const bbox = block.provenance?.bbox
  if (!bbox || !bbox.every(Number.isFinite)) return null
  const rawLeft = Math.min(bbox[0], bbox[2])
  const rawRight = Math.max(bbox[0], bbox[2])
  const rawLower = Math.min(bbox[1], bbox[3])
  const rawUpper = Math.max(bbox[1], bbox[3])
  const origin = String(block.attrs?.coordinateOrigin || 'BOTTOMLEFT').toUpperCase()
  const rawTop = origin === 'TOPLEFT' ? rawLower : pageSize.height - rawUpper
  const naturalWidth = rawRight - rawLeft
  const naturalHeight = rawUpper - rawLower
  const estimatedWidth = Math.min(Math.max(28, blockTextLength(block) * 5.4), pageSize.width * 0.72)
  const estimatedHeight = block.type === 'heading' ? 24 : block.type === 'paragraph' ? 16 : 36
  const width = naturalWidth > 0 ? naturalWidth : estimatedWidth
  const height = naturalHeight > 0 ? naturalHeight : estimatedHeight
  const left = Math.max(0, Math.min(rawLeft, Math.max(0, pageSize.width - width)))
  const top = Math.max(0, Math.min(rawTop, Math.max(0, pageSize.height - height)))
  return {
    left,
    top,
    width: Math.max(1, Math.min(width, pageSize.width - left)),
    height: Math.max(1, Math.min(height, pageSize.height - top)),
    repaired: naturalWidth <= 0 || naturalHeight <= 0 || left !== rawLeft || top !== rawTop,
  }
}

function geometryStyle(geometry: BlockGeometry, pageSize: { width: number; height: number }): string {
  const percentage = (value: number, total: number): string => `${(value / total * 100).toFixed(5)}%`
  return `--agn-x:${percentage(geometry.left, pageSize.width)};--agn-y:${percentage(geometry.top, pageSize.height)};--agn-w:${percentage(geometry.width, pageSize.width)};--agn-h:${percentage(geometry.height, pageSize.height)}`
}

function renderGeometryBlock(block: AndocBlock, document: AndocDocument, pageSize: { width: number; height: number }): string {
  const geometry = blockGeometry(block, pageSize)
  if (!geometry) return `<div class="agn-geometry-fallback">${renderBlock(block, document)}</div>`
  return `<div class="agn-geometry-block agn-geometry-${block.type}" data-agn-geometry="${escapeHtml(block.id)}"${geometry.repaired ? ' data-agn-geometry-repaired="true"' : ''} style="${geometryStyle(geometry, pageSize)}"><div class="agn-geometry-inner">${renderBlock(block, document)}</div></div>`
}

function geometryPageEligible(page: RenderPage, pageSize: { width: number; height: number }): boolean {
  if (!page.blocks.length) return true
  const eligible = page.blocks.filter(block => blockGeometry(block, pageSize)).length
  return eligible / page.blocks.length >= 0.8
}

function pagesForRender(document: AndocDocument): RenderPage[] {
  const blocks = blocksForDerivedView(document)
  const pages: RenderPage[] = []
  let current: AndocBlock[] = []
  let currentPage = Math.max(1, blocks.find(block => block.type !== 'pageBreak')?.provenance?.page || 1)
  const pushCurrent = (): void => {
    pages.push({ number: currentPage, blocks: current })
    current = []
  }

  for (const block of blocks) {
    if (block.type === 'pageBreak') {
      pushCurrent()
      currentPage = Math.max(currentPage + 1, (block.provenance?.page || currentPage) + 1)
      continue
    }
    const blockPage = block.provenance?.page
    if (current.length > 0 && blockPage && blockPage !== currentPage) {
      pushCurrent()
      currentPage = blockPage
    }
    current.push(block)
  }
  if (current.length > 0 || pages.length === 0) pushCurrent()

  const byPage = new Map(pages.map(page => [page.number, page]))
  const count = Math.max(sourcePageCount(document), ...pages.map(page => page.number), 1)
  return Array.from({ length: count }, (_, index) => byPage.get(index + 1) || { number: index + 1, blocks: [] })
}

function originalSourceHref(document: AndocDocument): string {
  const source = document.metadata.source
  if (!source || typeof source !== 'object' || Array.isArray(source)) return '#'
  const embeddedPath = (source as Record<string, unknown>).embeddedPath
  return typeof embeddedPath === 'string' && embeddedPath ? `../${embeddedPath}` : '#'
}

export function renderHtml(document: AndocDocument): string {
  const pages = pagesForRender(document)
  const originalHref = originalSourceHref(document)
  return `<!doctype html>
<html lang="${escapeHtml(document.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(document.title)}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#18181b;background:#eef1f5}
*{box-sizing:border-box}
body{width:100%;margin:0;line-height:1.55;background:#eef1f5}
h1,h2,h3,h4,h5,h6{line-height:1.2;margin:1.5em 0 .5em}p{margin:.75em 0}
.andoc-list{margin:.75em 0;padding-left:1.75em}.andoc-nested-list{margin:.35em 0;padding-left:1.5em}.andoc-footnote{margin:.75em 0;padding:.65em .8em;border-left:3px solid #a1a1aa;background:#fafafa;color:#3f3f46;font-size:.875rem}.andoc-footnote-label,.andoc-extension-label{font-weight:700;margin-right:.35em}.andoc-extension-fallback{margin:.75em 0;padding:.75em;border:1px dashed #a1a1aa;background:#fafafa}
.andoc-document-header h1{margin-top:0}
figure{margin:1.5em 0}figcaption,caption{font-size:.875rem;color:#52525b;margin:.5rem 0;text-align:left}
img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d4d4d8;padding:.5rem;text-align:left}
.agn-view-switch{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:center;gap:.4rem;padding:.65rem 1rem;background:rgba(255,255,255,.94);border-bottom:1px solid #dfe3e8;backdrop-filter:blur(12px)}
.agn-view-switch button,.agn-view-switch a{appearance:none;border:1px solid #c7cdd4;border-radius:.45rem;background:#fff;color:#252a31;padding:.42rem .8rem;font:600 .8125rem/1.2 inherit;text-decoration:none;cursor:pointer}.agn-view-switch [aria-pressed="true"]{background:#1f2937;color:#fff;border-color:#1f2937}
.agn-page-stack{display:grid;gap:2rem;justify-items:center;padding:2rem clamp(.75rem,4vw,3rem)}
.agn-page{position:relative;width:min(100%,816px);aspect-ratio:var(--agn-page-aspect);padding:clamp(2rem,7vw,5rem);background:#fff;box-shadow:0 7px 26px rgba(31,41,55,.16);overflow:hidden;break-after:page;page-break-after:always;content-visibility:auto;contain-intrinsic-size:auto 1056px}
.agn-page-content{transform-origin:top left}.agn-page table{font-size:.7rem;line-height:1.2}.agn-page th,.agn-page td{padding:.2rem .3rem}
.agn-page-number{position:absolute;right:1.15rem;bottom:.75rem;color:#71717a;font-size:.72rem;letter-spacing:.02em}.agn-page-content> :first-child{margin-top:0}
.agn-page [data-agn-furniture="header-logo"]{margin:0 0 1rem}.agn-page [data-agn-furniture="header-logo"] img{max-height:46px;width:auto}.agn-page [data-agn-furniture="footer-logo"] img{max-height:36px;width:auto}
.agn-page[data-agn-layout="geometry"]{padding:0}.agn-page[data-agn-layout="geometry"]>.agn-page-content{position:absolute;inset:0;width:100%;height:100%;transform:none}.agn-geometry-block{position:absolute;left:var(--agn-x);top:var(--agn-y);width:var(--agn-w);height:var(--agn-h);margin:0;overflow:hidden}.agn-geometry-inner{width:100%;transform-origin:top left}.agn-geometry-block p,.agn-geometry-block h1,.agn-geometry-block h2,.agn-geometry-block h3,.agn-geometry-block h4,.agn-geometry-block h5,.agn-geometry-block h6,.agn-geometry-block figure{margin:0}.agn-geometry-block p{line-height:1.18}.agn-geometry-block h1,.agn-geometry-block h2,.agn-geometry-block h3,.agn-geometry-block h4,.agn-geometry-block h5,.agn-geometry-block h6{line-height:1.08}.agn-geometry-image .agn-geometry-inner,.agn-geometry-chart .agn-geometry-inner,.agn-geometry-image figure,.agn-geometry-chart figure{height:100%}.agn-geometry-image img,.agn-geometry-chart> .agn-geometry-inner>figure>img{display:block;width:100%;height:100%;object-fit:contain}.agn-page[data-agn-layout="geometry"] .andoc-chart-data{display:none}.agn-page[data-agn-layout="geometry"] .agn-geometry-table table{table-layout:fixed;font-size:9px;line-height:1.08}.agn-page[data-agn-layout="geometry"] .agn-geometry-table th,.agn-page[data-agn-layout="geometry"] .agn-geometry-table td{padding:2px 3px;overflow:hidden}.agn-geometry-fallback{position:relative;z-index:2;margin:1rem;padding:.5rem;background:#fff8;border:1px dashed #f59e0b}
.andoc-chart-placeholder{min-height:180px;border:1px dashed #a1a1aa;padding:1rem;background:#fafafa}
.andoc-chart-data{margin-top:1rem;border:1px solid #d4d4d8;border-radius:.5rem;padding:.75rem;background:#fafafa}.andoc-chart-data summary{cursor:pointer;font-size:.8125rem;font-weight:700;color:#3f3f46}.andoc-chart-data-scroll{overflow-x:auto;margin-top:.75rem}.andoc-chart-data-notes{font-size:.8125rem;color:#52525b;margin:.5rem 0 0}
.andoc-page-break{border:0;break-after:page;page-break-after:always}
body[data-agn-view="reflow"]{background:#fff}body[data-agn-view="reflow"] .agn-page-stack{display:block;max-width:960px;margin:0 auto;padding:clamp(24px,6vw,72px)}body[data-agn-view="reflow"] .agn-page{display:block;width:100%;aspect-ratio:auto!important;padding:0;background:#fff;box-shadow:none;overflow:visible;break-after:auto;page-break-after:auto;content-visibility:visible}body[data-agn-view="reflow"] .agn-page-content{position:static!important;height:auto!important;transform:none!important;width:100%!important}body[data-agn-view="reflow"] .agn-geometry-block{display:contents}body[data-agn-view="reflow"] .agn-geometry-inner{width:100%!important;transform:none!important}body[data-agn-view="reflow"] .agn-geometry-fallback{margin:0;padding:0;border:0;background:none}body[data-agn-view="reflow"] .agn-page table{font-size:inherit;line-height:inherit;table-layout:auto}body[data-agn-view="reflow"] .agn-page th,body[data-agn-view="reflow"] .agn-page td{padding:.5rem;overflow:visible}body[data-agn-view="reflow"] .agn-page+ .agn-page{margin-top:2rem}body[data-agn-view="reflow"] .agn-page-number{display:none}body[data-agn-view="reflow"] [data-agn-recurring="true"]:not([data-agn-occurrence="1"]){display:none}body[data-agn-view="reflow"] .andoc-chart-data{display:block}
@media(max-width:700px){.agn-page{padding:clamp(1.25rem,6vw,2.25rem);aspect-ratio:auto;overflow:visible;content-visibility:visible}.agn-page-content{transform:none!important;width:100%!important}.agn-page[data-agn-layout="geometry"]{padding:0;aspect-ratio:var(--agn-page-aspect);overflow:hidden}.agn-page[data-agn-layout="geometry"]>.agn-page-content{position:absolute!important;height:100%!important}.agn-page [data-agn-furniture="header-logo"]{margin-top:0}.agn-view-switch{justify-content:flex-start;overflow-x:auto}}
@media print{body{background:#fff}.agn-view-switch{display:none}.agn-page-stack{display:block;padding:0}.agn-page{width:100%;box-shadow:none;margin:0;aspect-ratio:auto}.andoc-chart-placeholder{border-color:#d4d4d8}}
</style>
</head>
<body role="document" data-andoc-document="${escapeHtml(document.documentId)}" data-andoc-revision="${document.revision}" data-agn-view="page">
<nav id="anx-document-toolbar" class="agn-view-switch" aria-label="Document view"><button type="button" data-agn-select-view="page" data-anx-tooltip="Show the source-faithful PDF page canvas." title="Show the source-faithful PDF page canvas" aria-pressed="true">Page</button><button type="button" data-agn-select-view="reflow" data-anx-tooltip="Show the responsive structured document. Layout may differ from the original PDF." title="Show the responsive structured document; layout may differ from the original PDF" aria-pressed="false">Reflow</button><a data-agn-original data-anx-tooltip="Open the immutable PDF retained at import." title="Open the immutable PDF retained at import" href="${escapeHtml(originalHref)}">Original</a></nav>
<main aria-labelledby="andoc-document-title">
<div class="agn-page-stack">
${pages.map((page, index) => {
    const size = sourcePageSize(document, page.number)
    const geometry = geometryPageEligible(page, size)
    const leadingFurnitureCount = index === 0 ? page.blocks.findIndex(block => !isHeaderFurniture(block)) : 0
    const split = index === 0 && leadingFurnitureCount === -1 ? page.blocks.length : Math.max(0, leadingFurnitureCount)
    const leading = page.blocks.slice(0, split)
    const remaining = page.blocks.slice(split)
    const titleBlock = index === 0 ? sourceTitleBlock(document) : undefined
    const titleGeometry = titleBlock ? blockGeometry(titleBlock, size) : null
    const geometryTitle = titleGeometry ? `<div class="agn-geometry-block agn-geometry-title" data-agn-title-geometry="true" style="${geometryStyle(titleGeometry, size)}"><div class="agn-geometry-inner"><header class="andoc-document-header"><h1 id="andoc-document-title">${escapeHtml(document.title)}</h1></header></div></div>` : `<header class="andoc-document-header"><h1 id="andoc-document-title">${escapeHtml(document.title)}</h1></header>`
    const flowContent = `${leading.map(block => renderBlock(block, document)).join('\n')}${index === 0 ? `<header class="andoc-document-header"><h1 id="andoc-document-title">${escapeHtml(document.title)}</h1></header>` : ''}${remaining.map(block => renderBlock(block, document)).join('\n')}`
    const geometryBlocks = page.blocks.map(block => renderGeometryBlock(block, document, size)).join('\n')
    return `<section class="agn-page" id="agn-page-${page.number}" data-agn-page="${page.number}" data-agn-layout="${geometry ? 'geometry' : 'flow'}" style="--agn-page-aspect:${size.width} / ${size.height}" aria-label="Page ${page.number} of ${pages.length}"><div class="agn-page-content">${geometry ? `${index === 0 ? geometryTitle : ''}${geometryBlocks}` : flowContent}</div><span class="agn-page-number" aria-hidden="true">${page.number} / ${pages.length}</span></section>`
  }).join('\n')}
</div>
</main>
<script>(()=>{const body=document.body;const controls=[...document.querySelectorAll('[data-agn-select-view]')];const fitGeometryBlock=block=>{const inner=block.querySelector('.agn-geometry-inner');if(!inner)return;inner.style.transform='none';inner.style.width='100%';if(body.getAttribute('data-agn-view')!=='page')return;const availableWidth=block.clientWidth;const availableHeight=block.clientHeight;if(!availableWidth||!availableHeight)return;let low=.12;let high=1;let best=.12;for(let index=0;index<11;index+=1){const scale=(low+high)/2;inner.style.width=(100/scale)+'%';const fits=inner.scrollWidth*scale<=availableWidth+1&&inner.scrollHeight*scale<=availableHeight+1;if(fits){best=scale;low=scale}else high=scale}inner.style.width=(100/best)+'%';inner.style.transform='scale('+best+')';block.setAttribute('data-agn-content-scale',best.toFixed(3))};const fitPage=page=>{const content=page.querySelector('.agn-page-content');if(!content)return;if(page.getAttribute('data-agn-layout')==='geometry'){content.style.transform='none';content.style.width='100%';page.querySelectorAll('.agn-geometry-block').forEach(fitGeometryBlock);return}content.style.transform='none';content.style.width='100%';if(body.getAttribute('data-agn-view')!=='page'||matchMedia('(max-width:700px)').matches)return;const style=getComputedStyle(page);const available=page.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);let low=.2;let high=1;let best=.2;for(let index=0;index<10;index+=1){const scale=(low+high)/2;content.style.width=(100/scale)+'%';const fits=content.scrollHeight*scale<=available;if(fits){best=scale;low=scale}else high=scale}content.style.width=(100/best)+'%';content.style.transform='scale('+best+')';page.setAttribute('data-agn-content-scale',best.toFixed(3))};const fitPages=()=>document.querySelectorAll('.agn-page').forEach(fitPage);for(const control of controls)control.addEventListener('click',()=>{const view=control.getAttribute('data-agn-select-view')||'page';body.setAttribute('data-agn-view',view);for(const candidate of controls)candidate.setAttribute('aria-pressed',String(candidate===control));requestAnimationFrame(fitPages)});const original=document.querySelector('[data-agn-original]');if(original&&location.pathname.endsWith('/view'))original.setAttribute('href',location.pathname.replace(new RegExp('/view$'),'/original'));if(document.readyState==='complete')fitPages();else addEventListener('load',fitPages,{once:true});let resizeFrame=0;addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(fitPages)})})();</script>
</body>
</html>
`
}

function safeHref(value: string): string | null {
  const href = value.trim()
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null
  const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/i)?.[1]?.toLowerCase()
  if (scheme && !['http', 'https', 'mailto'].includes(scheme)) return null
  return href
}
