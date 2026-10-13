import { sha256 } from './hash.js'
import type { AndocPackage } from './package.js'
import {
  ANX_REGION_KINDS,
  regionEvidenceState,
  type AnxRegionEvidence,
  type AnxRegionEvidenceQuery,
  type AnxRegionEvidenceState,
  type AnxRegionKind,
} from './region-evidence.js'
import type { AndocBlock, AndocDocument } from './types.js'

export const ANX_CAPTION_ASSIST_SCHEMA = 'anx.caption-assist.v1' as const
const DOCLING_SOURCE_PATH = 'sources/docling/document.json'

export interface AnxCaptionAssistSummary {
  schema: typeof ANX_CAPTION_ASSIST_SCHEMA
  sourcePath: string | null
  sourceCaptions: number
  explicitSourceLabels: number
  prefixInferences: number
  addedCaptions: number
  autoVerified: number
  reviewRequired: number
  relationshipsResolved: number
  relationshipsUnresolved: number
  duplicatesSuppressed: number
  pagesWithCaptions: number
  returnedCaptions: number
  automaticCanonicalChange: false
  guidance: string
}

export interface AnxCaptionAssistedRegionEvidenceState extends AnxRegionEvidenceState {
  captionAssist: AnxCaptionAssistSummary
}

interface DoclingCaption {
  reference: string
  label: string
  page: number
  bbox: [number, number, number, number]
  coordinateOrigin: 'TOPLEFT' | 'BOTTOMLEFT'
  text: string
}

interface ParentMatch {
  region: AnxRegionEvidence
  score: number
  gapPercent: number
  horizontalCoverage: number
}

export function captionAssistedRegionEvidence(
  pkg: Pick<AndocPackage, 'document' | 'files'>,
  query: AnxRegionEvidenceQuery = {},
): AnxCaptionAssistedRegionEvidenceState {
  const base = regionEvidenceState(pkg.document, { includeParts: true })
  const sourcePath = Object.keys(pkg.files).find(candidate => candidate === DOCLING_SOURCE_PATH)
    || Object.keys(pkg.files).find(candidate => /(?:^|\/)docling\/document\.json$/i.test(candidate))
    || null
  const sourceCaptions = sourcePath ? parseDoclingCaptions(pkg.files[sourcePath]) : []
  const existing = [...base.regions]
  const generated: AnxRegionEvidence[] = []
  let duplicatesSuppressed = 0

  for (const caption of sourceCaptions) {
    const draft = captionRegion(pkg.document, caption, existing)
    if (existing.some(region => duplicateCaptionRegion(region, draft))) {
      duplicatesSuppressed += 1
      continue
    }
    generated.push(draft)
    existing.push(draft)
  }

  const kinds = query.kinds?.length ? new Set(query.kinds) : null
  const selected = existing
    .filter(region => (!query.page || region.page === query.page)
      && (!kinds || kinds.has(region.kind))
      && (query.includeParts !== false || region.defaultVisibility === 'visible'))
    .sort(regionSort)
  const byKind = Object.fromEntries(ANX_REGION_KINDS.map(kind => [
    kind,
    selected.filter(region => region.kind === kind).length,
  ])) as Record<AnxRegionKind, number>
  const autoVerified = generated.filter(region => region.status === 'verified').length
  const reviewRequired = generated.filter(region => region.unattendedUse === 'review-required').length
  const relationshipsResolved = generated.filter(region => region.structuredData?.parentMatchState === 'unique-compatible-parent').length
  const relationshipsUnresolved = generated.length - relationshipsResolved
  const explicitSourceLabels = sourceCaptions.filter(caption => /^caption$/i.test(caption.label)).length
  const prefixInferences = sourceCaptions.length - explicitSourceLabels

  return {
    ...base,
    regions: selected,
    summary: {
      ...base.summary,
      total: selected.length,
      byKind,
      verified: selected.filter(region => region.status === 'verified').length,
      reviewRequired: selected.filter(region => region.unattendedUse === 'review-required').length,
      abstained: selected.filter(region => region.unattendedUse === 'abstain').length,
      semanticObjects: selected.filter(region => region.defaultVisibility === 'visible').length,
      evidenceParts: selected.filter(region => region.defaultVisibility === 'evidence-only').length,
    },
    guidance: `${base.guidance} Caption Assist projects retained Docling caption evidence without changing canonical content. Explicit converter labels are safe caption objects; parent links are emitted only when one compatible nearby object is uniquely resolved.`,
    claimBoundary: `${base.claimBoundary} Caption Assist verifies the caption classification, text, and geometry for explicit retained converter labels. It does not infer an authoritative figure or table relationship unless one compatible parent is uniquely resolved; prefix-only caption inferences remain review-required.`,
    captionAssist: {
      schema: ANX_CAPTION_ASSIST_SCHEMA,
      sourcePath,
      sourceCaptions: sourceCaptions.length,
      explicitSourceLabels,
      prefixInferences,
      addedCaptions: generated.length,
      autoVerified,
      reviewRequired,
      relationshipsResolved,
      relationshipsUnresolved,
      duplicatesSuppressed,
      pagesWithCaptions: new Set(sourceCaptions.map(caption => caption.page)).size,
      returnedCaptions: selected.filter(region => region.kind === 'caption' && region.structuredData?.captionAssist === true).length,
      automaticCanonicalChange: false,
      guidance: sourcePath
        ? `${autoVerified} retained caption${autoVerified === 1 ? '' : 's'} are automatically classified; ${reviewRequired} prefix-only inference${reviewRequired === 1 ? '' : 's'} need review. ${relationshipsResolved} parent relationship${relationshipsResolved === 1 ? '' : 's'} were uniquely resolved and ${relationshipsUnresolved} remain deliberately unlinked. ${duplicatesSuppressed} existing or human-corrected caption${duplicatesSuppressed === 1 ? '' : 's'} were preserved and suppressed from assistance.`
        : 'Caption Assist is unavailable because the package does not retain a Docling document source.',
    },
  }
}

function parseDoclingCaptions(bytes: Uint8Array | undefined): DoclingCaption[] {
  if (!bytes) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const texts = Array.isArray((parsed as Record<string, unknown>).texts)
    ? (parsed as Record<string, unknown>).texts as unknown[]
    : []
  return texts.flatMap((value, index): DoclingCaption[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    const label = String(item.label || '').trim()
    const text = String(item.text || item.orig || '').replace(/\s+/g, ' ').trim()
    if (!text || (!/^caption$/i.test(label) && !captionPrefix(text))) return []
    const provenance = Array.isArray(item.prov) && item.prov[0] && typeof item.prov[0] === 'object'
      ? item.prov[0] as Record<string, unknown>
      : null
    const bbox = provenance?.bbox && typeof provenance.bbox === 'object' && !Array.isArray(provenance.bbox)
      ? provenance.bbox as Record<string, unknown>
      : null
    const page = Number(provenance?.page_no)
    const coordinates = bbox ? [bbox.l, bbox.b, bbox.r, bbox.t].map(Number) : []
    if (!Number.isInteger(page) || page < 1 || coordinates.length !== 4 || !coordinates.every(Number.isFinite)) return []
    if (coordinates[0] === coordinates[2] || coordinates[1] === coordinates[3]) return []
    return [{
      reference: typeof item.self_ref === 'string' && item.self_ref.trim() ? item.self_ref.trim() : `#/texts/${index}`,
      label,
      page,
      bbox: coordinates as [number, number, number, number],
      coordinateOrigin: String(bbox?.coord_origin || '').toUpperCase() === 'TOPLEFT' ? 'TOPLEFT' : 'BOTTOMLEFT',
      text,
    }]
  })
}

function captionRegion(
  document: AndocDocument,
  caption: DoclingCaption,
  existing: AnxRegionEvidence[],
): AnxRegionEvidence {
  const pageSize = documentPageSize(document, caption.page)
  const displayBox = displayBoxFor(caption.bbox, caption.coordinateOrigin, pageSize)
  const matches = parentMatches(caption.text, displayBox, existing.filter(region => region.page === caption.page))
  const best = matches[0]
  const second = matches[1]
  const uniqueParent = Boolean(best
    && best.gapPercent <= 4
    && best.horizontalCoverage >= 0.35
    && (!second || second.score - best.score >= 3.5))
  const exactCanonicalBlock = document.blocks.find(block => block.provenance?.page === caption.page
    && normalizeText(blockText(block)) === normalizeText(caption.text))
  const explicitSourceLabel = /^caption$/i.test(caption.label)
  const status = explicitSourceLabel ? 'verified' : 'candidate'
  const id = `region-caption-assist-${sha256(new TextEncoder().encode([
    document.documentId,
    caption.reference,
    caption.page,
    ...caption.bbox,
    caption.text,
  ].join('|'))).slice(0, 20)}`
  const captionForKind = captionPrefix(caption.text)
  const confidence = status === 'verified'
    ? uniqueParent ? 0.98 : 0.96
    : best
      ? Math.max(0.62, Math.min(0.89, 0.88 - best.gapPercent / 100))
      : 0.58
  return {
    id,
    kind: 'caption',
    page: caption.page,
    bbox: [...caption.bbox],
    coordinateOrigin: caption.coordinateOrigin,
    pageSize,
    displayBox,
    status,
    unattendedUse: status === 'verified' ? 'allowed' : 'review-required',
    semanticLevel: 'part',
    defaultVisibility: 'visible',
    ...(uniqueParent && best ? { parentRegionId: best.region.id } : {}),
    ...(exactCanonicalBlock ? { sourceBlockId: exactCanonicalBlock.id } : {}),
    description: caption.text,
    structuredData: {
      captionAssist: true,
      captionAssistSchema: ANX_CAPTION_ASSIST_SCHEMA,
      regionRole: 'caption',
      semanticLevel: 'part',
      defaultVisibility: 'visible',
      captionReference: caption.reference,
      captionForKind,
      ...(uniqueParent && best ? { parentRegionId: best.region.id } : {}),
      ...(!uniqueParent && best ? { suggestedParentRegionId: best.region.id } : {}),
      parentMatchState: uniqueParent ? 'unique-compatible-parent' : best ? 'ambiguous-compatible-parent' : 'parent-not-resolved',
      sourceGeometry: 'retained-docling-caption',
      canonicalTextOwner: exactCanonicalBlock ? 'canonical-block' : 'retained-docling-source',
      ...(exactCanonicalBlock ? { captionTextBlockId: exactCanonicalBlock.id } : {}),
    },
    provenance: {
      method: 'local-extraction',
      source: DOCLING_SOURCE_PATH,
      verified: status === 'verified',
      engine: 'anx-caption-assist',
      engineVersion: '1',
      confidence: rounded(confidence),
      notes: status === 'verified'
        ? uniqueParent && best
          ? `Explicit retained Docling caption label and one uniquely aligned compatible parent (${best.region.id}).`
          : 'Explicit retained Docling caption label verifies the caption text and geometry; no authoritative parent relationship is asserted.'
        : best
          ? 'Explicit retained caption text and geometry are available, but multiple or weakly aligned compatible parents require source review.'
          : 'Caption-like text and geometry are available, but the source label is not an explicit caption and requires review.',
    },
  }
}

function parentMatches(
  captionText: string,
  captionBox: AnxRegionEvidence['displayBox'],
  regions: AnxRegionEvidence[],
): ParentMatch[] {
  const compatibleKinds = captionParentKinds(captionPrefix(captionText))
  const captionLeft = captionBox.leftPercent
  const captionRight = captionLeft + captionBox.widthPercent
  const captionTop = captionBox.topPercent
  const captionBottom = captionTop + captionBox.heightPercent
  const captionCenter = (captionLeft + captionRight) / 2
  return regions.flatMap((region): ParentMatch[] => {
    if (region.kind === 'caption' || region.kind === 'text' || region.kind === 'note'
      || region.kind === 'handwriting' || region.kind === 'signature'
      || region.defaultVisibility !== 'visible' || !compatibleKinds.has(region.kind)) return []
    const parent = region.displayBox
    const parentLeft = parent.leftPercent
    const parentRight = parentLeft + parent.widthPercent
    const parentTop = parent.topPercent
    const parentBottom = parentTop + parent.heightPercent
    const intersection = Math.max(0, Math.min(captionRight, parentRight) - Math.max(captionLeft, parentLeft))
    const horizontalCoverage = intersection / Math.max(0.01, Math.min(captionBox.widthPercent, parent.widthPercent))
    const gapPercent = captionTop >= parentBottom
      ? captionTop - parentBottom
      : parentTop >= captionBottom
        ? parentTop - captionBottom
        : 0
    const centerDistance = Math.abs(captionCenter - (parentLeft + parentRight) / 2)
    if (gapPercent > 12 || (horizontalCoverage < 0.2 && centerDistance > 18)) return []
    const typePenalty = exactParentKind(captionPrefix(captionText), region.kind) ? 0 : 1.5
    const partPenalty = region.semanticLevel === 'object' ? 0 : 3
    return [{
      region,
      gapPercent,
      horizontalCoverage,
      score: gapPercent * 3 + centerDistance * 0.25 + (1 - Math.min(1, horizontalCoverage)) * 4 + typePenalty + partPenalty,
    }]
  }).sort((left, right) => left.score - right.score || left.region.id.localeCompare(right.region.id))
}

function captionPrefix(text: string): string {
  return text.match(/^\s*(Figure|Fig\.?|Table|Chart|Exhibit|Map|Equation|Algorithm|Plate)\b/i)?.[1]?.toLowerCase().replace('.', '') || ''
}

function captionParentKinds(prefix: string): Set<AnxRegionKind> {
  if (prefix === 'table') return new Set(['table'])
  if (prefix === 'chart') return new Set(['chart', 'visualization', 'figure'])
  if (prefix === 'map') return new Set(['map', 'figure'])
  if (prefix === 'equation') return new Set(['equation', 'figure'])
  return new Set(['figure', 'chart', 'screenshot', 'visualization', 'simulation', 'infographic', 'roster', 'map', 'equation'])
}

function exactParentKind(prefix: string, kind: AnxRegionKind): boolean {
  if (prefix === 'table') return kind === 'table'
  if (prefix === 'chart') return kind === 'chart'
  if (prefix === 'map') return kind === 'map'
  if (prefix === 'equation') return kind === 'equation'
  return kind === 'figure'
}

function duplicateCaptionRegion(existing: AnxRegionEvidence, candidate: AnxRegionEvidence): boolean {
  if (existing.kind !== 'caption' || existing.page !== candidate.page) return false
  if (normalizeText(existing.description || '') === normalizeText(candidate.description || '')) return true
  const overlap = displayIntersection(existing.displayBox, candidate.displayBox)
  const minimumArea = Math.max(0.01, Math.min(displayArea(existing.displayBox), displayArea(candidate.displayBox)))
  return overlap / minimumArea >= 0.55
}

function documentPageSize(document: AndocDocument, page: number): { width: number; height: number } {
  const layout = document.metadata.layout && typeof document.metadata.layout === 'object' && !Array.isArray(document.metadata.layout)
    ? document.metadata.layout as Record<string, unknown>
    : {}
  const sizes = layout.sourcePageSizes && typeof layout.sourcePageSizes === 'object' && !Array.isArray(layout.sourcePageSizes)
    ? layout.sourcePageSizes as Record<string, unknown>
    : {}
  const value = sizes[String(page)] && typeof sizes[String(page)] === 'object' && !Array.isArray(sizes[String(page)])
    ? sizes[String(page)] as Record<string, unknown>
    : {}
  const width = Number(value.width)
  const height = Number(value.height)
  return {
    width: Number.isFinite(width) && width > 0 ? width : 612,
    height: Number.isFinite(height) && height > 0 ? height : 792,
  }
}

function displayBoxFor(
  bbox: [number, number, number, number],
  origin: 'TOPLEFT' | 'BOTTOMLEFT',
  pageSize: { width: number; height: number },
): AnxRegionEvidence['displayBox'] {
  const left = Math.min(bbox[0], bbox[2])
  const right = Math.max(bbox[0], bbox[2])
  const lower = Math.min(bbox[1], bbox[3])
  const upper = Math.max(bbox[1], bbox[3])
  const top = origin === 'TOPLEFT' ? lower : pageSize.height - upper
  return {
    leftPercent: left / pageSize.width * 100,
    topPercent: top / pageSize.height * 100,
    widthPercent: (right - left) / pageSize.width * 100,
    heightPercent: (upper - lower) / pageSize.height * 100,
  }
}

function displayIntersection(left: AnxRegionEvidence['displayBox'], right: AnxRegionEvidence['displayBox']): number {
  const width = Math.max(0, Math.min(left.leftPercent + left.widthPercent, right.leftPercent + right.widthPercent) - Math.max(left.leftPercent, right.leftPercent))
  const height = Math.max(0, Math.min(left.topPercent + left.heightPercent, right.topPercent + right.heightPercent) - Math.max(left.topPercent, right.topPercent))
  return width * height
}

function displayArea(box: AnxRegionEvidence['displayBox']): number {
  return Math.max(0, box.widthPercent) * Math.max(0, box.heightPercent)
}

function blockText(block: AndocBlock): string {
  if (block.type === 'paragraph' || block.type === 'heading' || block.type === 'footnote') {
    return block.content.map(run => run.text).join('')
  }
  if (block.type === 'image' || block.type === 'chart' || block.type === 'table') {
    return (block.caption || []).map(run => run.text).join('')
  }
  if (block.type === 'extension') return block.fallback.map(run => run.text).join('')
  if (block.type === 'list') return block.items.flatMap(item => item.content.map(run => run.text)).join(' ')
  return ''
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function regionSort(left: AnxRegionEvidence, right: AnxRegionEvidence): number {
  return left.page - right.page
    || left.displayBox.topPercent - right.displayBox.topPercent
    || left.displayBox.leftPercent - right.displayBox.leftPercent
    || left.id.localeCompare(right.id)
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000
}
