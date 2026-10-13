import type { AndocBlock, AndocDocument, Provenance } from './types.js'
import { sha256 } from './hash.js'

export const ANX_REGION_EVIDENCE_SCHEMA = 'anx.region-evidence.v1' as const
export const ANX_REGION_EVIDENCE_METADATA_KEY = 'anxRegionEvidence' as const
export const ANX_REGION_CORRECTIONS_SCHEMA = 'anx.region-corrections.v1' as const
export const ANX_REGION_CORRECTIONS_METADATA_KEY = 'anxRegionCorrections' as const
export const ANX_TABLE_EVIDENCE_SCHEMA = 'anx.table-evidence.v1' as const

export const ANX_REGION_KINDS = ['table', 'text', 'note', 'caption', 'figure', 'screenshot', 'visualization', 'simulation', 'infographic', 'roster', 'logo', 'qrCode', 'chart', 'map', 'equation', 'handwriting', 'signature', 'other'] as const
export type AnxRegionKind = typeof ANX_REGION_KINDS[number]
export type AnxRegionStatus = 'observed' | 'candidate' | 'verified' | 'abstained'
export type AnxRegionEvidenceMethod = 'imported' | 'human' | 'agent' | 'local-extraction' | 'agent-vision'
export type AnxRegionSemanticLevel = 'object' | 'part' | 'background' | 'decoration'
export type AnxTableSourceRepresentation = 'text-and-vector' | 'image-based' | 'image-based-with-structured-extraction' | 'vector-rules' | 'mixed' | 'unknown'
export type AnxTableDataState = 'structured-verified' | 'structured-unverified' | 'visual-only' | 'candidate-only' | 'unstructured'

export interface AnxTableEvidence {
  schema: typeof ANX_TABLE_EVIDENCE_SCHEMA
  semanticType: 'table'
  sourceRepresentation: AnxTableSourceRepresentation
  dataState: AnxTableDataState
  cellStructureAvailable: boolean
  cellStructureVerified: boolean
  agentUse: 'allowed' | 'source-review-required' | 'extraction-required' | 'structure-review-required'
  guidance: string
}

export interface AnxRegionCorrection {
  id: string
  regionId: string
  action: 'upsert' | 'remove'
  created: boolean
  kind: AnxRegionKind
  page: number
  bbox: [number, number, number, number]
  coordinateOrigin: 'TOPLEFT' | 'BOTTOMLEFT'
  description?: string
  noteKind?: 'footnote' | 'endnote'
  anchorBlockId?: string
  sourceRevision: number
  actor: { type: 'human'; id: string }
  updatedAt: string
}

export interface AnxRegionCorrections {
  schema: typeof ANX_REGION_CORRECTIONS_SCHEMA
  entries: AnxRegionCorrection[]
}

export interface AnxRegionProvenance {
  method: AnxRegionEvidenceMethod
  source: string
  verified: boolean
  sourceSha256?: string
  engine?: string
  engineVersion?: string
  modelHashes?: string[]
  confidence?: number
  capturedAt?: string
  notes?: string
}

export interface AnxRegionEvidence {
  id: string
  kind: AnxRegionKind
  page: number
  bbox: [number, number, number, number]
  coordinateOrigin: 'TOPLEFT' | 'BOTTOMLEFT'
  pageSize: { width: number; height: number }
  displayBox: { leftPercent: number; topPercent: number; widthPercent: number; heightPercent: number }
  status: AnxRegionStatus
  unattendedUse: 'allowed' | 'review-required' | 'abstain'
  semanticLevel: AnxRegionSemanticLevel
  defaultVisibility: 'visible' | 'evidence-only'
  parentRegionId?: string
  childRegionIds?: string[]
  sourceBlockId?: string
  sourceBlockIds?: string[]
  assetId?: string
  assetSha256?: string
  description?: string
  transcription?: string
  structuredData?: Record<string, unknown>
  provenance: AnxRegionProvenance
  identityClaim?: 'not-established'
}

export interface AnxRegionEvidenceState {
  schema: typeof ANX_REGION_EVIDENCE_SCHEMA
  documentId: string
  revision: number
  regions: AnxRegionEvidence[]
  issues: Array<{ path: string; message: string }>
  summary: {
    total: number
    byKind: Record<AnxRegionKind, number>
    verified: number
    reviewRequired: number
    abstained: number
    canonicalMediaWithoutGeometry: number
    semanticObjects?: number
    evidenceParts?: number
  }
  automaticCanonicalChange: false
  guidance: string
  claimBoundary: string
}

export interface AnxRegionEvidenceQuery {
  page?: number
  kinds?: AnxRegionKind[]
  includeParts?: boolean
}

export function documentRegionCorrections(document: AndocDocument): AnxRegionCorrections {
  const value = document.metadata[ANX_REGION_CORRECTIONS_METADATA_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { schema: ANX_REGION_CORRECTIONS_SCHEMA, entries: [] }
  }
  const candidate = value as Record<string, unknown>
  if (candidate.schema !== ANX_REGION_CORRECTIONS_SCHEMA || !Array.isArray(candidate.entries)) {
    return { schema: ANX_REGION_CORRECTIONS_SCHEMA, entries: [] }
  }
  return structuredClone(value) as AnxRegionCorrections
}

export function regionEvidenceState(document: AndocDocument, query: AnxRegionEvidenceQuery = {}): AnxRegionEvidenceState {
  const issues: AnxRegionEvidenceState['issues'] = []
  const regions = new Map<string, AnxRegionEvidence>()
  let canonicalMediaWithoutGeometry = 0

  for (const block of document.blocks) {
    const derived = block.type === 'table'
      ? regionFromTableBlock(document, block)
      : block.type === 'footnote'
        ? regionFromNoteBlock(document, block)
      : block.type === 'image' || block.type === 'chart'
      ? regionFromMediaBlock(document, block)
      : block.type === 'extension' && block.extensionId === 'anx.source-region'
        ? regionFromSourceRegionBlock(document, block)
        : null
    if (block.type !== 'table' && block.type !== 'footnote' && block.type !== 'image' && block.type !== 'chart' && !(block.type === 'extension' && block.extensionId === 'anx.source-region')) continue
    if (!derived) {
      if (block.type !== 'footnote') canonicalMediaWithoutGeometry += 1
      continue
    }
    regions.set(derived.id, derived)
    if (block.type === 'chart') {
      for (const candidate of multiPanelCandidates(document, block, derived)) regions.set(candidate.id, candidate)
    }
  }

  const stored = document.metadata[ANX_REGION_EVIDENCE_METADATA_KEY]
  if (stored !== undefined) {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      issues.push({ path: `metadata.${ANX_REGION_EVIDENCE_METADATA_KEY}`, message: 'Region evidence metadata must be an object.' })
    } else {
      const payload = stored as Record<string, unknown>
      if (payload.schema !== ANX_REGION_EVIDENCE_SCHEMA) {
        issues.push({ path: `metadata.${ANX_REGION_EVIDENCE_METADATA_KEY}.schema`, message: `Expected ${ANX_REGION_EVIDENCE_SCHEMA}.` })
      } else if (!Array.isArray(payload.regions)) {
        issues.push({ path: `metadata.${ANX_REGION_EVIDENCE_METADATA_KEY}.regions`, message: 'Region evidence must contain a regions array.' })
      } else {
        payload.regions.forEach((value, index) => {
          const parsed = parseStoredRegion(document, value, index, issues)
          if (!parsed) return
          const duplicateTable = tableRegionCandidate(parsed)
            ? [...regions.values()].find(existing => existing.kind === 'table' && sameSourceObject(existing, parsed))
            : undefined
          if (duplicateTable) {
            retainDuplicateTableRepresentation(duplicateTable, parsed)
            return
          }
          for (const [id, existing] of regions) {
            if (parsed.semanticLevel !== 'part' && existing.sourceBlockId && parsed.sourceBlockId === existing.sourceBlockId) regions.delete(id)
          }
          regions.set(parsed.id, parsed)
        })
      }
    }
  }

  coalesceDuplicatePageObjects(regions)
  applySemanticHierarchy(document, regions)
  applyRegionCorrections(document, regions, issues)
  applyTableEvidenceSemantics(document, regions)
  refreshHierarchy(regions)

  const kinds = query.kinds?.length ? new Set(query.kinds) : null
  const selected = [...regions.values()]
    .filter(region => (!query.page || region.page === query.page)
      && (!kinds || kinds.has(region.kind))
      && (query.includeParts !== false || region.defaultVisibility === 'visible'))
    .sort((left, right) => left.page - right.page || left.displayBox.topPercent - right.displayBox.topPercent || left.displayBox.leftPercent - right.displayBox.leftPercent || left.id.localeCompare(right.id))
  const byKind = Object.fromEntries(ANX_REGION_KINDS.map(kind => [kind, selected.filter(region => region.kind === kind).length])) as Record<AnxRegionKind, number>

  return {
    schema: ANX_REGION_EVIDENCE_SCHEMA,
    documentId: document.documentId,
    revision: document.revision,
    regions: selected,
    issues,
    summary: {
      total: selected.length,
      byKind,
      verified: selected.filter(region => region.status === 'verified').length,
      reviewRequired: selected.filter(region => region.unattendedUse === 'review-required').length,
      abstained: selected.filter(region => region.unattendedUse === 'abstain').length,
      canonicalMediaWithoutGeometry,
      semanticObjects: selected.filter(region => region.defaultVisibility === 'visible').length,
      evidenceParts: selected.filter(region => region.defaultVisibility === 'evidence-only').length,
    },
    automaticCanonicalChange: false,
    guidance: 'Use semantic page objects by default. Request source parts only when component-level geometry is needed; parent-child relationships prevent duplicated evidence from being treated as independent objects. Deterministically anchored notes are unattended-safe; uncertain note-marker relationships remain review-required. Review candidate or observed regions against source pixels; an abstained region is intentionally unavailable for unattended agent use.',
    claimBoundary: 'Region evidence preserves page coordinates, semantic type, note subtype and anchor status, hierarchy, provenance, and explicit abstention. Inferred multi-panel candidates are disclosed; uncertain note links, inferred groups, rosters, and mixed-media tables are never asserted as verified. It does not prove interpretation accuracy, signer identity, legal authenticity, QR destination safety, chart-value correctness, or automatic canonical promotion.',
  }
}

function retainDuplicateTableRepresentation(table: AnxRegionEvidence, duplicate: AnxRegionEvidence): void {
  const source = duplicate.structuredData || {}
  const retainedRepresentation = Object.fromEntries([
    'sourceGeometry',
    'pictureReference',
    'placedImageSourceName',
    'placedImagePixelWidth',
    'placedImagePixelHeight',
    'placedImageAreaRatio',
    'rawVisualClass',
    'rawVisualConfidence',
  ].flatMap(key => source[key] === undefined ? [] : [[key, source[key]]]))
  const pictureEvidence = typeof source.pictureReference === 'string'
    || source.sourceGeometry === 'pdf-image-placement'
    || Boolean(duplicate.assetId)
    || Boolean(duplicate.assetSha256)
  table.structuredData = {
    ...(table.structuredData || {}),
    ...retainedRepresentation,
    ...(pictureEvidence ? { coincidentPictureTableEvidence: true } : {}),
  }
  table.provenance = {
    ...table.provenance,
    notes: [
      table.provenance.notes,
      pictureEvidence
        ? 'Coincident retained picture-table evidence establishes an image-based source representation without verifying extracted cell values.'
        : 'Coincident table-region evidence was deduplicated without changing canonical cell structure.',
    ].filter(Boolean).join(' '),
  }
}

function applyRegionCorrections(
  document: AndocDocument,
  regions: Map<string, AnxRegionEvidence>,
  issues: AnxRegionEvidenceState['issues'],
): void {
  const stored = document.metadata[ANX_REGION_CORRECTIONS_METADATA_KEY]
  if (stored === undefined) return
  const base = `metadata.${ANX_REGION_CORRECTIONS_METADATA_KEY}`
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    issues.push({ path: base, message: 'Region corrections metadata must be an object.' })
    return
  }
  const payload = stored as Record<string, unknown>
  if (payload.schema !== ANX_REGION_CORRECTIONS_SCHEMA) {
    issues.push({ path: `${base}.schema`, message: `Expected ${ANX_REGION_CORRECTIONS_SCHEMA}.` })
    return
  }
  if (!Array.isArray(payload.entries)) {
    issues.push({ path: `${base}.entries`, message: 'Region corrections must contain an entries array.' })
    return
  }
  const seen = new Set<string>()
  payload.entries.forEach((value, index) => {
    const entryPath = `${base}.entries[${index}]`
    const entry = parseRegionCorrection(document, value, entryPath, issues)
    if (!entry) return
    if (seen.has(entry.regionId)) {
      issues.push({ path: `${entryPath}.regionId`, message: `Only one active correction may target region ${entry.regionId}.` })
      return
    }
    seen.add(entry.regionId)
    if (entry.action === 'remove') {
      regions.delete(entry.regionId)
      return
    }
    const existing = regions.get(entry.regionId)
    if (!existing && !entry.created) {
      issues.push({ path: `${entryPath}.regionId`, message: `Corrected region does not exist: ${entry.regionId}.` })
      return
    }
    const textRecovery = entry.kind === 'text'
    const note = entry.kind === 'note'
    const humanTranscription = textRecovery && entry.description ? entry.description.trim() : ''
    const noteText = note && entry.description ? entry.description.trim() : ''
    const noteAnchorResolved = note && Boolean(noteText && entry.anchorBlockId && documentNodeIds(document).has(entry.anchorBlockId))
    const correctionStatus: AnxRegionStatus = textRecovery && !humanTranscription || note && !noteAnchorResolved ? 'candidate' : 'verified'
    const correctionProvenance: AnxRegionProvenance = {
      method: 'human',
      source: `studio-region-correction:${entry.id}`,
      verified: true,
      capturedAt: entry.updatedAt,
      notes: textRecovery
        ? humanTranscription
          ? `Human-bounded and transcribed missing text from document revision ${entry.sourceRevision}.`
          : `Human-bounded missing text from document revision ${entry.sourceRevision}; transcription remains required.`
        : note
          ? noteAnchorResolved
            ? `Human-bounded ${entry.noteKind} linked to stable node ${entry.anchorBlockId} from document revision ${entry.sourceRevision}.`
            : `Human-bounded ${entry.noteKind} from document revision ${entry.sourceRevision}; note text or anchor linkage remains uncertain.`
        : `Human-adjusted page-object geometry and type from document revision ${entry.sourceRevision}.`,
    }
    const corrected = completeRegion(document, {
      ...(existing ? structuredClone(existing) : {
        id: entry.regionId,
        status: correctionStatus,
      }),
      id: entry.regionId,
      kind: entry.kind,
      page: entry.page,
      bbox: [...entry.bbox],
      coordinateOrigin: entry.coordinateOrigin,
      status: correctionStatus,
      ...(entry.description
        ? { description: entry.description }
        : textRecovery || note
          ? { description: undefined, transcription: undefined }
          : existing?.description
            ? { description: existing.description }
            : {}),
      structuredData: {
        ...(existing?.structuredData || {}),
        ...(entry.kind === 'caption' ? {
          regionRole: 'caption',
          semanticLevel: 'part',
          defaultVisibility: 'visible',
        } : note ? {
          regionRole: 'note',
          semanticLevel: 'object',
          defaultVisibility: 'visible',
          noteKind: entry.noteKind || 'footnote',
          marker: existing?.structuredData?.marker || null,
          anchorBlockIds: entry.anchorBlockId ? [entry.anchorBlockId] : [],
          anchorStatus: noteAnchorResolved ? 'resolved' : entry.anchorBlockId ? 'uncertain' : 'unanchored',
          canonicalTextOwner: noteText ? 'human-region-description' : 'none',
        } : textRecovery ? {
          regionRole: 'text-recovery',
          semanticLevel: 'object',
          defaultVisibility: 'visible',
          textRecoveryState: humanTranscription ? 'human-transcribed' : 'geometry-only',
          canonicalTextOwner: humanTranscription ? 'human-region-description' : 'none',
        } : existing?.kind === 'caption' || existing?.kind === 'note' ? {
          regionRole: 'human-adjusted-page-object',
          semanticLevel: 'object',
          defaultVisibility: 'visible',
          parentRegionId: null,
          noteKind: null,
          anchorBlockIds: null,
          anchorStatus: null,
        } : existing?.kind === 'text' ? {
          regionRole: 'human-adjusted-page-object',
          semanticLevel: 'object',
          defaultVisibility: 'visible',
          textRecoveryState: null,
          canonicalTextOwner: null,
        } : {}),
        regionCorrectionId: entry.id,
        regionCorrectionAction: entry.created ? 'human-created' : 'human-adjusted',
        sourceRevision: entry.sourceRevision,
      },
      provenance: correctionProvenance,
      ...(entry.kind === 'caption'
        ? { semanticLevel: 'part', defaultVisibility: 'visible' }
        : textRecovery || note
          ? { semanticLevel: 'object', defaultVisibility: 'visible', parentRegionId: undefined }
          : existing?.kind === 'caption'
          ? { semanticLevel: 'object', defaultVisibility: 'visible', parentRegionId: undefined }
          : {}),
    })
    regions.set(entry.regionId, corrected)
  })
}

function parseRegionCorrection(
  document: AndocDocument,
  value: unknown,
  path: string,
  issues: AnxRegionEvidenceState['issues'],
): AnxRegionCorrection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'Region correction must be an object.' })
    return null
  }
  const candidate = value as Record<string, unknown>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const regionId = typeof candidate.regionId === 'string' ? candidate.regionId.trim() : ''
  const kind = ANX_REGION_KINDS.includes(candidate.kind as AnxRegionKind) ? candidate.kind as AnxRegionKind : null
  const page = Number(candidate.page)
  const bbox = numericBbox(candidate.bbox)
  const coordinateOrigin = String(candidate.coordinateOrigin).toUpperCase()
  const sourceRevision = Number(candidate.sourceRevision)
  const noteKind = candidate.noteKind === 'footnote' || candidate.noteKind === 'endnote' ? candidate.noteKind : undefined
  const anchorBlockId = typeof candidate.anchorBlockId === 'string' && candidate.anchorBlockId.trim() ? candidate.anchorBlockId.trim() : undefined
  const actor = candidate.actor && typeof candidate.actor === 'object' && !Array.isArray(candidate.actor)
    ? candidate.actor as Record<string, unknown>
    : null
  if (!/^correction-[A-Za-z0-9._:-]+$/.test(id)) {
    issues.push({ path: `${path}.id`, message: 'Correction id must start with correction- and use stable identifier characters.' })
    return null
  }
  if (!/^region-[A-Za-z0-9._:-]+$/.test(regionId)) {
    issues.push({ path: `${path}.regionId`, message: 'Corrected region id must start with region- and use stable identifier characters.' })
    return null
  }
  if (candidate.action !== 'upsert' && candidate.action !== 'remove') {
    issues.push({ path: `${path}.action`, message: 'Region correction action must be upsert or remove.' })
    return null
  }
  if (typeof candidate.created !== 'boolean' || !kind || !Number.isInteger(page) || page < 1 || !bbox) {
    issues.push({ path, message: 'Region correction requires created, kind, positive page, and non-empty bbox values.' })
    return null
  }
  if (kind === 'note' && !noteKind) {
    issues.push({ path: `${path}.noteKind`, message: 'Note corrections require a footnote or endnote subtype.' })
    return null
  }
  if (anchorBlockId && !documentNodeIds(document).has(anchorBlockId)) {
    issues.push({ path: `${path}.anchorBlockId`, message: `Note anchor does not resolve to a stable document node: ${anchorBlockId}.` })
    return null
  }
  const pageCount = sourcePageCount(document)
  if (pageCount !== null && page > pageCount) {
    issues.push({ path: `${path}.page`, message: `Region correction page ${page} exceeds the retained source page count of ${pageCount}.` })
    return null
  }
  if ((coordinateOrigin !== 'TOPLEFT' && coordinateOrigin !== 'BOTTOMLEFT')
    || !normalizedBox(bbox, coordinateOrigin, sourcePageSize(document, page))) {
    issues.push({ path: `${path}.bbox`, message: 'Region correction bbox must overlap the retained source page.' })
    return null
  }
  if (!Number.isInteger(sourceRevision) || sourceRevision < 0
    || actor?.type !== 'human' || typeof actor.id !== 'string' || !actor.id.trim()
    || typeof candidate.updatedAt !== 'string' || !candidate.updatedAt.trim()) {
    issues.push({ path, message: 'Region correction requires a source revision, human actor, and timestamp.' })
    return null
  }
  return {
    id,
    regionId,
    action: candidate.action,
    created: candidate.created,
    kind,
    page,
    bbox,
    coordinateOrigin: coordinateOrigin as 'TOPLEFT' | 'BOTTOMLEFT',
    ...(typeof candidate.description === 'string' && candidate.description.trim() ? { description: candidate.description.trim() } : {}),
    ...(noteKind ? { noteKind } : {}),
    ...(anchorBlockId ? { anchorBlockId } : {}),
    sourceRevision,
    actor: { type: 'human', id: actor.id.trim() },
    updatedAt: candidate.updatedAt,
  }
}

function regionFromNoteBlock(document: AndocDocument, block: Extract<AndocBlock, { type: 'footnote' }>): AnxRegionEvidence | null {
  const provenance = block.provenance
  if (!provenance?.page || !provenance.bbox) return null
  const anchorIds = block.anchorIds || []
  const anchorsResolve = block.anchorStatus === 'resolved'
    && anchorIds.length > 0
    && anchorIds.every(anchorId => anchorId !== block.id && documentNodeIds(document).has(anchorId))
  const noteKind = block.noteKind || 'footnote'
  const text = runsText(block.content)
  return completeRegion(document, {
    id: `region-${block.id}`,
    kind: 'note',
    page: provenance.page,
    bbox: [...provenance.bbox] as [number, number, number, number],
    coordinateOrigin: coordinateOriginFor(block.attrs?.coordinateOrigin),
    status: anchorsResolve ? 'verified' : 'candidate',
    sourceBlockId: block.id,
    description: [block.label, text].filter(Boolean).join(' '),
    structuredData: {
      regionRole: 'note',
      noteKind,
      marker: block.label,
      anchorBlockIds: anchorIds,
      anchorStatus: anchorsResolve ? 'resolved' : block.anchorStatus || 'unanchored',
      canonicalTextOwner: 'note-block',
    },
    provenance: {
      method: provenance.kind === 'human' ? 'human' : provenance.kind === 'agent' ? 'agent' : provenance.kind === 'generated' ? 'local-extraction' : 'imported',
      source: provenance.sourceUri || provenance.sourceId || `block:${block.id}`,
      verified: anchorsResolve,
      ...(provenance.confidence !== undefined ? { confidence: provenance.confidence } : {}),
      ...(provenance.capturedAt ? { capturedAt: provenance.capturedAt } : {}),
      notes: anchorsResolve
        ? `Canonical ${noteKind} geometry and anchor linkage are explicit.`
        : `Canonical ${noteKind} geometry is retained, but marker-to-note linkage requires review.`,
    },
  })
}

function regionFromTableBlock(document: AndocDocument, block: Extract<AndocBlock, { type: 'table' }>): AnxRegionEvidence | null {
  const provenance = block.provenance
  if (!provenance?.page || !provenance.bbox) return null
  const coordinateOrigin = coordinateOriginFor(block.attrs?.coordinateOrigin)
  const caption = runsText(block.caption)
  const columnCount = block.rows.reduce((maximum, row) => Math.max(maximum, row.reduce((count, cell) => count + Math.max(1, cell.colspan || 1), 0)), 0)
  const description = caption || `Structured table · ${block.rows.length} row${block.rows.length === 1 ? '' : 's'} × ${columnCount} column${columnCount === 1 ? '' : 's'}`
  return completeRegion(document, {
    id: `region-${block.id}`,
    kind: 'table',
    page: provenance.page,
    bbox: [...provenance.bbox] as [number, number, number, number],
    coordinateOrigin,
    status: 'observed',
    sourceBlockId: block.id,
    description,
    structuredData: {
      regionRole: 'canonical-table',
      rowCount: block.rows.length,
      columnCount,
      tableId: block.id,
    },
    provenance: {
      method: provenance.kind === 'human' ? 'human' : provenance.kind === 'agent' ? 'agent' : provenance.kind === 'generated' ? 'local-extraction' : 'imported',
      source: provenance.sourceUri || provenance.sourceId || `block:${block.id}`,
      verified: false,
      ...(provenance.confidence !== undefined ? { confidence: provenance.confidence } : {}),
      ...(provenance.capturedAt ? { capturedAt: provenance.capturedAt } : {}),
      notes: 'Region geometry comes from the canonical structured table block.',
    },
  })
}

function regionFromMediaBlock(document: AndocDocument, block: Extract<AndocBlock, { type: 'image' | 'chart' }>): AnxRegionEvidence | null {
  const provenance = retainedProvenance(block)
  if (!provenance?.page || !provenance.bbox) return null
  const coordinateOrigin = coordinateOriginFor(block.attrs?.coordinateOrigin)
  const pageSize = sourcePageSize(document, provenance.page)
  const displayBox = normalizedBox(provenance.bbox, coordinateOrigin, pageSize)
  if (!displayBox) return null
  const assetId = block.type === 'image' ? block.assetId : block.fallbackAssetId
  const asset = assetId ? document.assets[assetId] : undefined
  const caption = runsText(block.caption)
  const description = [block.alt, caption].filter(Boolean).join(' — ')
  const kind = block.type === 'chart' ? 'chart' : regionKindFor(block.attrs?.regionKind, description)
  const structuredData = block.type === 'chart' && block.spec.data && typeof block.spec.data === 'object' && !Array.isArray(block.spec.data)
    ? structuredClone(block.spec.data as Record<string, unknown>)
    : undefined
  return completeRegion(document, {
    id: `region-${block.id}`,
    kind,
    page: provenance.page,
    bbox: [...provenance.bbox] as [number, number, number, number],
    coordinateOrigin,
    status: 'observed',
    sourceBlockId: block.id,
    ...(assetId ? { assetId } : {}),
    ...(asset?.sha256 ? { assetSha256: asset.sha256 } : {}),
    ...(description ? { description } : {}),
    ...(structuredData ? { structuredData } : {}),
    provenance: {
      method: provenance.kind === 'human' ? 'human' : provenance.kind === 'agent' ? 'agent' : provenance.kind === 'generated' ? 'local-extraction' : 'imported',
      source: provenance.sourceUri || provenance.sourceId || `block:${block.id}`,
      verified: false,
      ...(provenance.confidence !== undefined ? { confidence: provenance.confidence } : {}),
      ...(provenance.capturedAt ? { capturedAt: provenance.capturedAt } : {}),
    },
  })
}

function multiPanelCandidates(
  document: AndocDocument,
  block: Extract<AndocBlock, { type: 'chart' }>,
  observed: AnxRegionEvidence,
): AnxRegionEvidence[] {
  const caption = runsText(block.caption)
  const expectedPanelCount = multiPanelCountHint(caption)
  if (expectedPanelCount !== 2 && expectedPanelCount !== 4) return []
  const pageSize = sourcePageSize(document, observed.page)
  const [left, lower, right, upper] = observed.bbox
  const panelWidth = Math.abs(right - left)
  const panelHeight = Math.abs(upper - lower)
  if (panelWidth <= 0 || panelHeight <= 0 || panelWidth > pageSize.width * 0.55 || panelHeight > pageSize.height * 0.45) return []

  if (expectedPanelCount === 2) {
    const observedBox = normalizedCoordinates(observed.bbox)
    const mirroredBox: [number, number, number, number] = [
      pageSize.width - observedBox[2],
      observedBox[1],
      pageSize.width - observedBox[0],
      observedBox[3],
    ]
    if (mirroredBox[0] < 0 || mirroredBox[2] > pageSize.width || overlapRatio(mirroredBox, observedBox) >= 0.7) return []
    const group = completeRegion(document, {
      id: `${observed.id}-group`,
      kind: 'figure',
      page: observed.page,
      bbox: [
        Math.min(observedBox[0], mirroredBox[0]),
        Math.min(observedBox[1], mirroredBox[1]),
        Math.max(observedBox[2], mirroredBox[2]),
        Math.max(observedBox[3], mirroredBox[3]),
      ],
      coordinateOrigin: observed.coordinateOrigin,
      status: 'candidate',
      sourceBlockId: block.id,
      description: `Multi-panel chart group candidate (${expectedPanelCount} panels) · ${caption}`,
      structuredData: {
        regionRole: 'multi-panel-parent-candidate',
        expectedPanelCount,
        detectedChildRegionIds: [observed.id],
      },
      provenance: {
        method: 'local-extraction',
        source: observed.provenance.source,
        verified: false,
        ...(observed.provenance.confidence !== undefined ? { confidence: rounded(observed.provenance.confidence * 0.75) } : {}),
        notes: 'The caption explicitly labels left and right panels. The group boundary and mirrored missing-panel box are geometric candidates and require source review.',
      },
    })
    return [group, completeRegion(document, {
      id: `${observed.id}-panel-candidate-1`,
      kind: 'chart',
      page: observed.page,
      bbox: mirroredBox,
      coordinateOrigin: observed.coordinateOrigin,
      status: 'candidate',
      sourceBlockId: block.id,
      description: `Inferred chart panel candidate for ${caption}`,
      structuredData: {
        regionRole: 'multi-panel-child-candidate',
        parentRegionId: group.id,
        expectedPanelCount,
      },
      provenance: {
        method: 'local-extraction',
        source: observed.provenance.source,
        verified: false,
        ...(observed.provenance.confidence !== undefined ? { confidence: rounded(observed.provenance.confidence * 0.6) } : {}),
        notes: 'Panel geometry is mirrored from the observed panel because the caption explicitly labels left and right panels; source review is required.',
      },
    })]
  }

  const horizontalGap = Math.max(4, pageSize.width * 0.008)
  const verticalGap = Math.max(6, pageSize.height * 0.01)
  const groupLeft = Math.min(left, right)
  const groupLower = Math.min(lower, upper)
  const groupRight = Math.min(pageSize.width, Math.max(Math.max(left, right), pageSize.width - groupLeft))
  const groupUpper = Math.min(pageSize.height, Math.max(lower, upper) + panelHeight + verticalGap)
  if (groupRight - groupLeft < panelWidth * 1.7 || groupUpper - groupLower < panelHeight * 1.7) return []

  const group = completeRegion(document, {
    id: `${observed.id}-group`,
    kind: 'figure',
    page: observed.page,
    bbox: [groupLeft, groupLower, groupRight, groupUpper],
    coordinateOrigin: observed.coordinateOrigin,
    status: 'candidate',
    sourceBlockId: block.id,
    description: `Multi-panel chart group candidate (${expectedPanelCount} panels) · ${caption}`,
    structuredData: {
      regionRole: 'multi-panel-parent-candidate',
      expectedPanelCount,
      detectedChildRegionIds: [observed.id],
    },
    provenance: {
      method: 'local-extraction',
      source: observed.provenance.source,
      verified: false,
      ...(observed.provenance.confidence !== undefined ? { confidence: rounded(observed.provenance.confidence * 0.75) } : {}),
      notes: 'The caption declares a four-panel clockwise layout. The group boundary and missing panel boxes are geometric candidates and require source review.',
    },
  })

  const panelRight = groupRight - panelWidth
  const panelUpper = groupUpper - panelHeight
  const boxes: Array<[number, number, number, number]> = [
    [groupLeft, groupLower, groupLeft + panelWidth, groupLower + panelHeight],
    [panelRight, groupLower, groupRight, groupLower + panelHeight],
    [groupLeft, panelUpper, groupLeft + panelWidth, groupUpper],
    [panelRight, panelUpper, groupRight, groupUpper],
  ]
  const observedBox = normalizedCoordinates(observed.bbox)
  const inferred = boxes
    .filter(box => overlapRatio(normalizedCoordinates(box), observedBox) < 0.7)
    .map((bbox, index) => completeRegion(document, {
      id: `${observed.id}-panel-candidate-${index + 1}`,
      kind: 'chart',
      page: observed.page,
      bbox,
      coordinateOrigin: observed.coordinateOrigin,
      status: 'candidate',
      sourceBlockId: block.id,
      description: `Inferred chart panel candidate for ${caption}`,
      structuredData: {
        regionRole: 'multi-panel-child-candidate',
        parentRegionId: group.id,
        expectedPanelCount,
      },
      provenance: {
        method: 'local-extraction',
        source: observed.provenance.source,
        verified: false,
        ...(observed.provenance.confidence !== undefined ? { confidence: rounded(observed.provenance.confidence * 0.6) } : {}),
        notes: 'Panel geometry is inferred from the declared four-panel layout and one observed panel; source review is required.',
      },
    }))
  return [group, ...inferred]
}

function regionFromSourceRegionBlock(
  document: AndocDocument,
  block: Extract<AndocBlock, { type: 'extension' }>,
): AnxRegionEvidence | null {
  const provenance = block.provenance
  if (!provenance?.page || !provenance.bbox) return null
  const payload = block.payload
  const kind = ANX_REGION_KINDS.includes(payload.kind as AnxRegionKind) ? payload.kind as AnxRegionKind : 'figure'
  const coordinateOrigin = coordinateOriginFor(payload.coordinateOrigin || block.attrs?.coordinateOrigin)
  const description = block.fallback.map(run => run.text).join(' ').trim()
  return completeRegion(document, {
    id: `region-${block.id}`,
    kind,
    page: provenance.page,
    bbox: [...provenance.bbox] as [number, number, number, number],
    coordinateOrigin,
    status: 'observed',
    sourceBlockId: block.id,
    ...(description ? { description } : {}),
    provenance: {
      method: provenance.kind === 'human' ? 'human' : provenance.kind === 'agent' ? 'agent' : provenance.kind === 'generated' ? 'local-extraction' : 'imported',
      source: provenance.sourceUri || provenance.sourceId || `block:${block.id}`,
      verified: false,
      ...(provenance.confidence !== undefined ? { confidence: provenance.confidence } : {}),
      ...(provenance.capturedAt ? { capturedAt: provenance.capturedAt } : {}),
    },
  })
}

function parseStoredRegion(
  document: AndocDocument,
  value: unknown,
  index: number,
  issues: AnxRegionEvidenceState['issues'],
): AnxRegionEvidence | null {
  const base = `metadata.${ANX_REGION_EVIDENCE_METADATA_KEY}.regions[${index}]`
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path: base, message: 'Region evidence must be an object.' })
    return null
  }
  const candidate = value as Record<string, unknown>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  if (!/^region-[A-Za-z0-9._:-]+$/.test(id)) {
    issues.push({ path: `${base}.id`, message: 'Region id must start with region- and use stable identifier characters.' })
    return null
  }
  const kind = ANX_REGION_KINDS.includes(candidate.kind as AnxRegionKind) ? candidate.kind as AnxRegionKind : null
  if (!kind) {
    issues.push({ path: `${base}.kind`, message: `Region kind must be one of: ${ANX_REGION_KINDS.join(', ')}.` })
    return null
  }
  const page = Number(candidate.page)
  if (!Number.isInteger(page) || page < 1) {
    issues.push({ path: `${base}.page`, message: 'Region page must be a positive integer.' })
    return null
  }
  const pageCount = sourcePageCount(document)
  if (pageCount !== null && page > pageCount) {
    issues.push({ path: `${base}.page`, message: `Region page ${page} exceeds the retained source page count of ${pageCount}.` })
    return null
  }
  const bbox = numericBbox(candidate.bbox)
  if (!bbox) {
    issues.push({ path: `${base}.bbox`, message: 'Region bbox must contain four finite coordinates with non-zero area.' })
    return null
  }
  const status = ['observed', 'candidate', 'verified', 'abstained'].includes(String(candidate.status)) ? candidate.status as AnxRegionStatus : null
  if (!status) {
    issues.push({ path: `${base}.status`, message: 'Region status must be observed, candidate, verified, or abstained.' })
    return null
  }
  const provenance = parseProvenance(candidate.provenance)
  if (!provenance) {
    issues.push({ path: `${base}.provenance`, message: 'Region provenance requires a supported method, non-empty source, and verified boolean.' })
    return null
  }
  if (status === 'verified' && !provenance.verified) {
    issues.push({ path: `${base}.provenance.verified`, message: 'A verified region requires verified provenance; it remains review-required.' })
  }
  const coordinateOrigin = coordinateOriginFor(candidate.coordinateOrigin)
  if (!normalizedBox(bbox, coordinateOrigin, sourcePageSize(document, page))) {
    issues.push({ path: `${base}.bbox`, message: 'Region bbox must overlap the retained source page.' })
    return null
  }
  const structuredData = candidate.structuredData && typeof candidate.structuredData === 'object' && !Array.isArray(candidate.structuredData)
    ? structuredClone(candidate.structuredData as Record<string, unknown>)
    : undefined
  const explicitSourceBlockId = typeof candidate.sourceBlockId === 'string' && candidate.sourceBlockId.trim() ? candidate.sourceBlockId.trim() : undefined
  const sourceBlockId = explicitSourceBlockId || id.replace(/^region-/, '')
  return completeRegion(document, {
    id,
    kind,
    page,
    bbox,
    coordinateOrigin,
    status: status === 'verified' && !provenance.verified ? 'candidate' : status,
    sourceBlockId,
    ...(typeof candidate.assetId === 'string' && candidate.assetId.trim() ? { assetId: candidate.assetId.trim() } : {}),
    ...(typeof candidate.assetSha256 === 'string' && /^[a-f0-9]{64}$/.test(candidate.assetSha256) ? { assetSha256: candidate.assetSha256 } : {}),
    ...(typeof candidate.description === 'string' && candidate.description.trim() ? { description: candidate.description.trim() } : {}),
    ...(typeof candidate.transcription === 'string' && candidate.transcription.trim() ? { transcription: candidate.transcription.trim() } : {}),
    structuredData: {
      ...(structuredData || {}),
      ...(!explicitSourceBlockId ? { sourceBinding: 'stored-region-evidence' } : {}),
    },
    provenance,
  })
}

function coalesceDuplicatePageObjects(regions: Map<string, AnxRegionEvidence>): void {
  let changed = true
  while (changed) {
    changed = false
    const observed = [...regions.values()].filter(region => region.status === 'observed')
    for (let leftIndex = 0; leftIndex < observed.length && !changed; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < observed.length; rightIndex += 1) {
        const left = observed[leftIndex]!
        const right = observed[rightIndex]!
        if (left.page !== right.page || left.sourceBlockId === right.sourceBlockId || left.kind === 'caption' || right.kind === 'caption') continue
        if (!((left.kind === 'table') !== (right.kind === 'table'))) continue
        if (!sameSourceObject(left, right)) continue

        const table = left.kind === 'table' ? left : right
        const visual = left.kind === 'table' ? right : left
        const preferred = explicitVisualSemantics(visual) ? visual : table
        const secondary = preferred === visual ? table : visual
        const sourceBlockIds = [...new Set([
          preferred.sourceBlockId,
          ...(preferred.sourceBlockIds || []),
          secondary.sourceBlockId,
          ...(secondary.sourceBlockIds || []),
        ].filter((value): value is string => Boolean(value)))]
        const merged: AnxRegionEvidence = {
          ...preferred,
          sourceBlockIds,
          structuredData: {
            ...(preferred.structuredData || {}),
            regionRole: 'coalesced-source-object',
            mergedSourceBlockIds: sourceBlockIds,
            mergedRegionIds: [preferred.id, secondary.id],
            mergedKinds: [...new Set([preferred.kind, secondary.kind])],
          },
          provenance: {
            ...preferred.provenance,
            notes: [
              preferred.provenance.notes,
              `Coalesced overlapping ${preferred.kind} and ${secondary.kind} importer objects into one review-required page object.`,
            ].filter(Boolean).join(' '),
          },
        }
        regions.delete(preferred.id)
        regions.delete(secondary.id)
        regions.set(merged.id, merged)
        changed = true
        break
      }
    }
  }
}

function explicitVisualSemantics(region: AnxRegionEvidence): boolean {
  return region.kind !== 'figure'
    || /^\s*(?:figure|chart|map)\s+[A-Za-z]?\d+/i.test(region.description || '')
}

function completeRegion(
  document: AndocDocument,
  value: Omit<AnxRegionEvidence, 'pageSize' | 'displayBox' | 'unattendedUse' | 'identityClaim' | 'semanticLevel' | 'defaultVisibility' | 'parentRegionId' | 'childRegionIds'> & Partial<Pick<AnxRegionEvidence, 'semanticLevel' | 'defaultVisibility' | 'parentRegionId' | 'childRegionIds'>>,
): AnxRegionEvidence {
  const pageSize = sourcePageSize(document, value.page)
  const displayBox = normalizedBox(value.bbox, value.coordinateOrigin, pageSize) || { leftPercent: 0, topPercent: 0, widthPercent: 100, heightPercent: 100 }
  const unattendedUse = value.status === 'verified' ? 'allowed' : value.status === 'abstained' ? 'abstain' : 'review-required'
  const hierarchy = hierarchyFields(value)
  return {
    ...value,
    pageSize,
    displayBox,
    unattendedUse,
    ...hierarchy,
    ...(value.kind === 'signature' ? { identityClaim: 'not-established' as const } : {}),
  }
}

function hierarchyFields(value: {
  structuredData?: Record<string, unknown>
  semanticLevel?: AnxRegionSemanticLevel
  defaultVisibility?: 'visible' | 'evidence-only'
  parentRegionId?: string
  childRegionIds?: string[]
}): Pick<AnxRegionEvidence, 'semanticLevel' | 'defaultVisibility'> & Partial<Pick<AnxRegionEvidence, 'parentRegionId' | 'childRegionIds'>> {
  const structured = value.structuredData || {}
  const role = typeof structured.regionRole === 'string' ? structured.regionRole : ''
  const parentRegionId = value.parentRegionId
    || (typeof structured.parentRegionId === 'string' ? structured.parentRegionId : undefined)
  const childRegionIds = value.childRegionIds
    || arrayOfRegionIds(structured.childRegionIds)
    || arrayOfRegionIds(structured.detectedChildRegionIds)
  const explicitLevel = value.semanticLevel
    || (['object', 'part', 'background', 'decoration'].includes(String(structured.semanticLevel)) ? structured.semanticLevel as AnxRegionSemanticLevel : undefined)
  const semanticLevel = explicitLevel || (parentRegionId || /(?:child|nested-source-image|table-cell-media)/.test(role) ? 'part'
    : /background/.test(role) ? 'background'
      : /decorative/.test(role) ? 'decoration'
        : 'object')
  const explicitVisibility = value.defaultVisibility
    || (['visible', 'evidence-only'].includes(String(structured.defaultVisibility)) ? structured.defaultVisibility as 'visible' | 'evidence-only' : undefined)
  const defaultVisibility = explicitVisibility || (semanticLevel === 'object' ? 'visible' : 'evidence-only')
  return {
    semanticLevel,
    defaultVisibility,
    ...(parentRegionId ? { parentRegionId } : {}),
    ...(childRegionIds?.length ? { childRegionIds } : {}),
  }
}

function applySemanticHierarchy(document: AndocDocument, regions: Map<string, AnxRegionEvidence>): void {
  bindExplicitHierarchy(regions)
  bindMixedTableMedia(regions)
  deriveRosterGroups(document, regions)
  suppressCompositeBackgrounds(regions)
  deriveOverlappingComposites(document, regions)
  deriveCoverArtwork(document, regions)
  expandSidebarComposites(regions)
  expandSpreadPanelComposites(document, regions)
  refreshHierarchy(regions)
}

function bindExplicitHierarchy(regions: Map<string, AnxRegionEvidence>): void {
  const byPlacedImageName = new Map<string, AnxRegionEvidence>()
  for (const region of regions.values()) {
    const name = typeof region.structuredData?.placedImageSourceName === 'string' ? region.structuredData.placedImageSourceName : null
    if (name) byPlacedImageName.set(name, region)
  }
  for (const region of regions.values()) {
    const containingName = typeof region.structuredData?.containingPlacedImageSourceName === 'string'
      ? region.structuredData.containingPlacedImageSourceName
      : null
    const namedParent = containingName ? byPlacedImageName.get(containingName) : null
    const parentRegionId = region.parentRegionId
      || (typeof region.structuredData?.parentRegionId === 'string' ? region.structuredData.parentRegionId : undefined)
      || namedParent?.id
    if (!parentRegionId || !regions.has(parentRegionId)) continue
    if (region.kind === 'caption') {
      region.semanticLevel = 'part'
      region.defaultVisibility = 'visible'
      region.parentRegionId = parentRegionId
      region.structuredData = {
        ...(region.structuredData || {}),
        regionRole: 'caption',
        parentRegionId,
        semanticLevel: 'part',
        defaultVisibility: 'visible',
      }
      continue
    }
    markAsPart(region, parentRegionId, region.structuredData?.regionRole === 'nested-source-image' ? 'nested-source-image' : undefined)
  }
}

function bindMixedTableMedia(regions: Map<string, AnxRegionEvidence>): void {
  const tables = [...regions.values()].filter(region => region.kind === 'table')
  for (const table of tables) {
    const tableArea = boxArea(table.bbox)
    if (tableArea <= 0) continue
    const tableBox = normalizedCoordinates(table.bbox)
    for (const region of regions.values()) {
      if (region.id === table.id || region.page !== table.page || region.kind === 'table') continue
      const rawClass = String(region.structuredData?.rawVisualClass || '')
      if (!/\b(?:icon|logo|full_page_image|photograph|picture|image)\b/i.test(rawClass)) continue
      if (boxArea(region.bbox) > tableArea * 0.22) continue
      const regionBox = normalizedCoordinates(region.bbox)
      const horizontalIntersection = Math.max(0, Math.min(regionBox[2], tableBox[2]) - Math.max(regionBox[0], tableBox[0]))
      const horizontalCoverage = horizontalIntersection / Math.max(1, boxWidth(regionBox))
      const verticalGap = regionBox[3] < tableBox[1]
        ? tableBox[1] - regionBox[3]
        : regionBox[1] > tableBox[3]
          ? regionBox[1] - tableBox[3]
          : 0
      const insideTable = overlapRatio(regionBox, tableBox) >= 0.82
      const alignedBoundaryCell = horizontalCoverage >= 0.75 && verticalGap <= table.pageSize.height * 0.06
      if (!insideTable && !alignedBoundaryCell) continue
      markAsPart(region, table.id, 'table-cell-media')
    }
    const children = [...regions.values()].filter(region => region.parentRegionId === table.id)
    if (!children.length) continue
    const expanded = paddedBox(
      unionRegionBoxes([table, ...children]),
      table.pageSize,
      4,
      10,
    )
    setRegionBbox(table, expanded)
    table.status = 'candidate'
    table.unattendedUse = 'review-required'
    table.provenance = derivedHierarchyProvenance([table, ...children], 'The mixed-media table boundary was expanded to include horizontally aligned first- and last-row visual cells; source review is required.')
    table.structuredData = {
      ...(table.structuredData || {}),
      regionRole: 'mixed-media-table',
      childRegionIds: children.map(region => region.id).sort(),
      mediaCellCount: children.length,
      boundaryBasis: 'table-rules-plus-aligned-media-cells',
    }
    table.childRegionIds = children.map(region => region.id).sort()
  }
}

function applyTableEvidenceSemantics(document: AndocDocument, regions: Map<string, AnxRegionEvidence>): void {
  const canonicalTables = new Map(document.blocks
    .filter((block): block is Extract<AndocBlock, { type: 'table' }> => block.type === 'table')
    .map(block => [block.id, block]))
  for (const region of regions.values()) {
    if (region.kind !== 'table') continue
    const sourceBlockIds = [region.sourceBlockId, ...(region.sourceBlockIds || [])]
      .filter((value): value is string => Boolean(value))
    const canonicalTable = sourceBlockIds
      .map(id => canonicalTables.get(id))
      .find((value): value is Extract<AndocBlock, { type: 'table' }> => Boolean(value))
    const structured = region.structuredData || {}
    const sourceGeometry = String(structured.sourceGeometry || '')
    const role = String(structured.regionRole || '')
    const imageBased = sourceGeometry === 'pdf-image-placement'
      || typeof structured.pictureReference === 'string'
      || typeof structured.placedImageSourceName === 'string'
      || Boolean(region.assetId)
    const mixed = role === 'mixed-media-table' || Number(structured.mediaCellCount) > 0
    const vectorRules = sourceGeometry === 'pdf-vector-paths' || role === 'vector-table-candidate'
    const sourceRepresentation: AnxTableSourceRepresentation = mixed
      ? 'mixed'
      : imageBased && canonicalTable
        ? 'image-based-with-structured-extraction'
        : imageBased
          ? 'image-based'
          : vectorRules
            ? 'vector-rules'
            : canonicalTable
              ? 'text-and-vector'
              : 'unknown'
    const cellStructureAvailable = Boolean(canonicalTable)
    const cellStructureVerified = cellStructureAvailable
      && (structured.cellStructureVerified === true || structured.tableCellStructureVerified === true)
    const dataState: AnxTableDataState = cellStructureVerified
      ? 'structured-verified'
      : cellStructureAvailable
        ? 'structured-unverified'
        : vectorRules
          ? 'candidate-only'
          : imageBased
            ? 'visual-only'
            : 'unstructured'
    const agentUse: AnxTableEvidence['agentUse'] = dataState === 'structured-verified'
      ? 'allowed'
      : dataState === 'structured-unverified'
        ? 'source-review-required'
        : dataState === 'visual-only'
          ? 'extraction-required'
          : 'structure-review-required'
    const guidance = dataState === 'structured-verified'
      ? 'Verified cell structure is available for quoting, comparison, and calculation within the disclosed source boundary.'
      : dataState === 'structured-unverified'
        ? 'Machine-structured cells are available, but exact values and spans require source review before quoting, comparison, or calculation.'
        : dataState === 'visual-only'
          ? 'This is semantically a table but is retained as image evidence only. Do not infer, quote, compare, or calculate cell values until extraction and verification are complete.'
          : dataState === 'candidate-only'
            ? 'Table geometry is a candidate derived from vector rules. Confirm semantic table status and cell structure before using values.'
            : 'The region is semantically classified as a table, but no usable cell structure has been established.'
    const tableEvidence: AnxTableEvidence = {
      schema: ANX_TABLE_EVIDENCE_SCHEMA,
      semanticType: 'table',
      sourceRepresentation,
      dataState,
      cellStructureAvailable,
      cellStructureVerified,
      agentUse,
      guidance,
    }
    region.structuredData = {
      ...structured,
      tableEvidence,
    }
  }
}

function deriveRosterGroups(document: AndocDocument, regions: Map<string, AnxRegionEvidence>): void {
  const pages = new Set([...regions.values()].map(region => region.page))
  for (const page of pages) {
    const portraits = [...regions.values()].filter(region => {
      if (region.page !== page || region.defaultVisibility !== 'visible' || region.kind !== 'figure') return false
      if (!/photograph/i.test(String(region.structuredData?.rawVisualClass || ''))) return false
      const areaRatio = boxArea(region.bbox) / Math.max(1, region.pageSize.width * region.pageSize.height)
      const widthRatio = boxWidth(region.bbox) / region.pageSize.width
      const heightRatio = boxHeight(region.bbox) / region.pageSize.height
      return areaRatio >= 0.0035 && areaRatio <= 0.022 && widthRatio >= 0.04 && widthRatio <= 0.11 && heightRatio >= 0.065 && heightRatio <= 0.17
    })
    if (portraits.length < 12) continue
    const bbox = unionRegionBoxes(portraits)
    const id = semanticRegionId(document, page, portraits.map(region => region.id), 'roster')
    if (regions.has(id)) continue
    for (const portrait of portraits) markAsPart(portrait, id, 'portrait-part')
    const roster = completeRegion(document, {
      id,
      kind: 'roster',
      page,
      bbox,
      coordinateOrigin: portraits[0]!.coordinateOrigin,
      status: 'candidate',
      description: `Personnel roster · ${portraits.length} source-observed portraits`,
      structuredData: {
        regionRole: 'personnel-roster-parent',
        childRegionIds: portraits.map(region => region.id).sort(),
        portraitCount: portraits.length,
        sourceGeometry: 'pdf-image-placement',
      },
      provenance: derivedHierarchyProvenance(portraits, 'Repeated, aligned source-observed portraits were grouped as a review-required personnel roster.'),
    })
    regions.set(roster.id, roster)
  }
}

function suppressCompositeBackgrounds(regions: Map<string, AnxRegionEvidence>): void {
  const values = [...regions.values()]
  for (const region of values) {
    if (region.semanticLevel !== 'object' || !semanticVisualKind(region.kind)) continue
    const areaRatio = boxArea(region.bbox) / Math.max(1, region.pageSize.width * region.pageSize.height)
    if (areaRatio < 0.3) continue
    const containedParts = values.filter(candidate => candidate.page === region.page
      && candidate.id !== region.id
      && candidate.semanticLevel === 'part'
      && overlapRatio(normalizedCoordinates(candidate.bbox), normalizedCoordinates(region.bbox)) >= 0.9)
    if (containedParts.length < 5) continue
    region.semanticLevel = 'background'
    region.defaultVisibility = 'evidence-only'
    region.structuredData = { ...(region.structuredData || {}), regionRole: 'composite-background-layer', semanticLevel: 'background', defaultVisibility: 'evidence-only' }
  }
}

function deriveOverlappingComposites(document: AndocDocument, regions: Map<string, AnxRegionEvidence>): void {
  const pages = new Set([...regions.values()].map(region => region.page))
  for (const page of pages) {
    const candidates = [...regions.values()].filter(region => region.page === page
      && region.defaultVisibility === 'visible'
      && semanticVisualKind(region.kind))
    const components = connectedRegionComponents(candidates)
    for (const component of components) {
      if (component.length < 2 || component.length > 18) continue
      const bbox = unionRegionBoxes(component)
      const areaRatio = boxArea(bbox) / Math.max(1, component[0]!.pageSize.width * component[0]!.pageSize.height)
      if (areaRatio > 0.82) continue
      const id = semanticRegionId(document, page, component.map(region => region.id), 'composite')
      if (regions.has(id)) continue
      for (const child of component) markAsPart(child, id, 'composite-source-part')
      const parent = completeRegion(document, {
        id,
        kind: component.some(region => region.kind === 'visualization' || region.kind === 'simulation') ? 'visualization' : component.some(region => region.kind === 'infographic') ? 'infographic' : 'figure',
        page,
        bbox,
        coordinateOrigin: component[0]!.coordinateOrigin,
        status: 'candidate',
        description: `Composite visual · ${component.length} source layers`,
        structuredData: {
          regionRole: 'semantic-composite-parent',
          childRegionIds: component.map(region => region.id).sort(),
          sourceGeometry: 'pdf-image-placement',
        },
        provenance: derivedHierarchyProvenance(component, 'Overlapping or nested source layers were grouped into one review-required semantic visual.'),
      })
      regions.set(parent.id, parent)
    }
  }
}

function deriveCoverArtwork(document: AndocDocument, regions: Map<string, AnxRegionEvidence>): void {
  const component = [...regions.values()].filter(region => region.page === 1
    && region.defaultVisibility === 'visible'
    && semanticVisualKind(region.kind))
  if (component.length < 3 || component.length > 8) return
  const bbox = unionRegionBoxes(component)
  const pageSize = component[0]!.pageSize
  const widthRatio = boxWidth(bbox) / pageSize.width
  const heightRatio = boxHeight(bbox) / pageSize.height
  const areaRatio = boxArea(bbox) / Math.max(1, pageSize.width * pageSize.height)
  if (widthRatio < 0.25 || widthRatio > 0.96 || heightRatio < 0.8 || areaRatio < 0.28) return
  const id = semanticRegionId(document, 1, component.map(region => region.id), 'cover-artwork')
  if (regions.has(id)) return
  for (const child of component) markAsPart(child, id, 'cover-artwork-part')
  const parent = completeRegion(document, {
    id,
    kind: component.some(region => region.kind === 'visualization' || region.kind === 'simulation') ? 'visualization' : component.some(region => region.kind === 'infographic') ? 'infographic' : 'figure',
    page: 1,
    bbox,
    coordinateOrigin: component[0]!.coordinateOrigin,
    status: 'candidate',
    description: `Cover artwork · ${component.length} source-observed visual sections`,
    structuredData: {
      regionRole: 'cover-artwork-parent',
      childRegionIds: component.map(region => region.id).sort(),
      sourceGeometry: 'page-one-visual-sections',
    },
    provenance: derivedHierarchyProvenance(component, 'Page-one visual sections spanning most of the page height were grouped into one review-required cover artwork object.'),
  })
  regions.set(parent.id, parent)
}

function expandSidebarComposites(regions: Map<string, AnxRegionEvidence>): void {
  for (const region of regions.values()) {
    if (region.defaultVisibility !== 'visible' || region.semanticLevel !== 'object') continue
    if (String(region.structuredData?.rawVisualClass || '').toLowerCase() !== 'full_page_image') continue
    const box = normalizedCoordinates(region.bbox)
    const widthRatio = boxWidth(box) / region.pageSize.width
    const heightRatio = boxHeight(box) / region.pageSize.height
    const touchesSide = box[0] <= region.pageSize.width * 0.015 || box[2] >= region.pageSize.width * 0.985
    if (!touchesSide || widthRatio < 0.12 || widthRatio > 0.32 || heightRatio < 0.35 || heightRatio > 0.75) continue
    setRegionBbox(region, [box[0], 0, box[2], region.pageSize.height])
    region.status = 'candidate'
    region.unattendedUse = 'review-required'
    region.structuredData = {
      ...(region.structuredData || {}),
      regionRole: 'sidebar-composite-candidate',
      boundaryBasis: 'edge-aligned-full-page-image',
    }
    region.provenance = derivedHierarchyProvenance([region], 'An edge-aligned full-page-image source object was expanded to the page boundary as a review-required sidebar composite.')
  }
}

function expandSpreadPanelComposites(document: AndocDocument, regions: Map<string, AnxRegionEvidence>): void {
  const textBoxesByPage = new Map<number, Array<[number, number, number, number]>>()
  for (const block of document.blocks) {
    if (!['paragraph', 'heading', 'list', 'footnote'].includes(block.type) || !block.provenance?.page || !block.provenance.bbox) continue
    const boxes = textBoxesByPage.get(block.provenance.page) || []
    boxes.push(normalizedCoordinates(block.provenance.bbox))
    textBoxesByPage.set(block.provenance.page, boxes)
  }
  for (const region of regions.values()) {
    if (region.defaultVisibility !== 'visible' || region.structuredData?.regionRole !== 'semantic-composite-parent') continue
    const box = normalizedCoordinates(region.bbox)
    const pageSize = region.pageSize
    const widthRatio = boxWidth(box) / pageSize.width
    const heightRatio = boxHeight(box) / pageSize.height
    if (pageSize.width / pageSize.height < 1.3 || widthRatio < 0.25 || widthRatio > 0.48 || heightRatio < 0.75) continue
    const half = pageSize.width / 2
    const leftPanel = box[0] <= pageSize.width * 0.02
    const rightPanel = box[2] >= pageSize.width * 0.98
    if (!leftPanel && !rightPanel) continue
    const textBoxes = textBoxesByPage.get(region.page) || []
    const extendsPastBoundary = leftPanel
      ? textBoxes.some(textBox => textBox[0] < half && textBox[2] > box[2] + pageSize.width * 0.05)
      : textBoxes.some(textBox => textBox[2] > half && textBox[0] < box[0] - pageSize.width * 0.05)
    if (!extendsPastBoundary) continue
    setRegionBbox(region, leftPanel ? [0, 0, half, pageSize.height] : [half, 0, pageSize.width, pageSize.height])
    region.status = 'candidate'
    region.unattendedUse = 'review-required'
    region.structuredData = {
      ...(region.structuredData || {}),
      regionRole: 'spread-panel-composite',
      boundaryBasis: 'page-half-plus-canonical-text',
    }
    region.provenance = derivedHierarchyProvenance([region], 'A near-full-height composite with canonical text extending beyond its source-image boundary was expanded to the two-page-spread midpoint.')
  }
}

function connectedRegionComponents(regions: AnxRegionEvidence[]): AnxRegionEvidence[][] {
  const remaining = new Set(regions.map(region => region.id))
  const byId = new Map(regions.map(region => [region.id, region]))
  const result: AnxRegionEvidence[][] = []
  while (remaining.size) {
    const seedId = remaining.values().next().value as string
    remaining.delete(seedId)
    const queue = [byId.get(seedId)!]
    const component: AnxRegionEvidence[] = []
    while (queue.length) {
      const current = queue.shift()!
      component.push(current)
      for (const candidateId of [...remaining]) {
        const candidate = byId.get(candidateId)!
        if (overlapRatio(normalizedCoordinates(current.bbox), normalizedCoordinates(candidate.bbox)) < 0.08) continue
        remaining.delete(candidateId)
        queue.push(candidate)
      }
    }
    result.push(component)
  }
  return result
}

function refreshHierarchy(regions: Map<string, AnxRegionEvidence>): void {
  for (const parent of regions.values()) {
    const children = [...regions.values()].filter(region => region.parentRegionId === parent.id)
    if (!children.length) continue
    parent.childRegionIds = children.map(region => region.id).sort()
    parent.structuredData = { ...(parent.structuredData || {}), childRegionIds: parent.childRegionIds }
  }
}

function markAsPart(region: AnxRegionEvidence, parentRegionId: string, role?: string): void {
  region.semanticLevel = 'part'
  region.defaultVisibility = 'evidence-only'
  region.parentRegionId = parentRegionId
  region.structuredData = {
    ...(region.structuredData || {}),
    ...(role ? { regionRole: role } : {}),
    parentRegionId,
    semanticLevel: 'part',
    defaultVisibility: 'evidence-only',
  }
}

function derivedHierarchyProvenance(regions: AnxRegionEvidence[], notes: string): AnxRegionProvenance {
  const first = regions[0]!
  return {
    method: 'local-extraction',
    source: first.provenance.source,
    verified: false,
    ...(first.provenance.sourceSha256 ? { sourceSha256: first.provenance.sourceSha256 } : {}),
    ...(first.provenance.capturedAt ? { capturedAt: first.provenance.capturedAt } : {}),
    engine: 'anx-semantic-projection',
    confidence: 0.82,
    notes,
  }
}

function semanticRegionId(document: AndocDocument, page: number, childIds: string[], role: string): string {
  const digest = sha256(new TextEncoder().encode(`${document.documentId}:${page}:${role}:${[...childIds].sort().join(':')}`)).slice(0, 24)
  return `region-${role}-${digest}`
}

function unionRegionBoxes(regions: AnxRegionEvidence[]): [number, number, number, number] {
  const boxes = regions.map(region => normalizedCoordinates(region.bbox))
  return [
    Math.min(...boxes.map(box => box[0])),
    Math.min(...boxes.map(box => box[1])),
    Math.max(...boxes.map(box => box[2])),
    Math.max(...boxes.map(box => box[3])),
  ]
}

function paddedBox(
  bbox: [number, number, number, number],
  pageSize: { width: number; height: number },
  horizontal: number,
  vertical: number,
): [number, number, number, number] {
  const box = normalizedCoordinates(bbox)
  return [
    Math.max(0, box[0] - horizontal),
    Math.max(0, box[1] - vertical),
    Math.min(pageSize.width, box[2] + horizontal),
    Math.min(pageSize.height, box[3] + vertical),
  ]
}

function setRegionBbox(region: AnxRegionEvidence, bbox: [number, number, number, number]): void {
  region.bbox = bbox
  region.displayBox = normalizedBox(bbox, region.coordinateOrigin, region.pageSize)
    || { leftPercent: 0, topPercent: 0, widthPercent: 100, heightPercent: 100 }
}

function semanticVisualKind(kind: AnxRegionKind): boolean {
  return ['figure', 'visualization', 'simulation', 'infographic'].includes(kind)
}

function arrayOfRegionIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value.filter(item => typeof item === 'string' && /^region-[A-Za-z0-9._:-]+$/.test(item)) as string[]
  return ids.length ? [...new Set(ids)] : undefined
}

function boxArea(value: [number, number, number, number]): number {
  return boxWidth(value) * boxHeight(value)
}

function boxWidth(value: [number, number, number, number]): number {
  return Math.max(0, Math.max(value[0], value[2]) - Math.min(value[0], value[2]))
}

function boxHeight(value: [number, number, number, number]): number {
  return Math.max(0, Math.max(value[1], value[3]) - Math.min(value[1], value[3]))
}

function parseProvenance(value: unknown): AnxRegionProvenance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const method = ['imported', 'human', 'agent', 'local-extraction', 'agent-vision'].includes(String(candidate.method))
    ? candidate.method as AnxRegionEvidenceMethod
    : null
  const source = typeof candidate.source === 'string' ? candidate.source.trim() : ''
  if (!method || !source || typeof candidate.verified !== 'boolean') return null
  const confidence = typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1
    ? candidate.confidence
    : undefined
  const modelHashes = Array.isArray(candidate.modelHashes) ? candidate.modelHashes.filter(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) as string[] : undefined
  return {
    method,
    source,
    verified: candidate.verified,
    ...(typeof candidate.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(candidate.sourceSha256) ? { sourceSha256: candidate.sourceSha256 } : {}),
    ...(typeof candidate.engine === 'string' && candidate.engine.trim() ? { engine: candidate.engine.trim() } : {}),
    ...(typeof candidate.engineVersion === 'string' && candidate.engineVersion.trim() ? { engineVersion: candidate.engineVersion.trim() } : {}),
    ...(modelHashes?.length ? { modelHashes } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(typeof candidate.capturedAt === 'string' && candidate.capturedAt.trim() ? { capturedAt: candidate.capturedAt.trim() } : {}),
    ...(typeof candidate.notes === 'string' && candidate.notes.trim() ? { notes: candidate.notes.trim() } : {}),
  }
}

function retainedProvenance(block: Extract<AndocBlock, { type: 'image' | 'chart' }>): Provenance | null {
  const retained = block.attrs?.sourceProvenance
  if (retained && typeof retained === 'object' && !Array.isArray(retained)) return retained as Provenance
  return block.provenance || null
}

function regionKindFor(value: unknown, description = ''): AnxRegionKind {
  if (ANX_REGION_KINDS.includes(value as AnxRegionKind)) return value as AnxRegionKind
  const semanticLabel = description.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9\s]+/g, ' ')
  if (/\bcaption\b/.test(semanticLabel)) return 'caption'
  if (/\btable\b/.test(semanticLabel)) return 'table'
  if (/\b(?:qr\s*code|data\s*matrix|barcode)\b/.test(semanticLabel)) return 'qrCode'
  if (/\b(?:logo|emblem|badge|insignia|seal)\b/.test(semanticLabel)) return 'logo'
  if (/\b(?:simulation|simulated|scientific visualization)\b/.test(semanticLabel)) return 'visualization'
  if (/\binfographic\b/.test(semanticLabel)) return 'infographic'
  if (/\b(?:personnel|leadership|staff)\s+(?:roster|directory)\b/.test(semanticLabel)) return 'roster'
  if (/\b(?:geographical|geographic|service area|location)\s+map\b|\bmap\b/.test(semanticLabel)) return 'map'
  if (/\b(?:equation|formula)\b/.test(semanticLabel)) return 'equation'
  if (/\bhandwrit(?:ing|ten)\b/.test(semanticLabel)) return 'handwriting'
  if (/\bsignature\b/.test(semanticLabel)) return 'signature'
  if (/\bscreenshot\b|\bscreen\s+(?:capture|shot)\b/.test(semanticLabel)) return 'screenshot'
  return 'figure'
}

function multiPanelCountHint(caption: string): number | null {
  const normalized = caption.toLowerCase().replace(/[_-]+/g, ' ')
  if (/\bclockwise\s+from\s+(?:the\s+)?top\s+left\b/.test(normalized)) return 4
  if (/\(\s*left\s*\)[\s\S]{0,240}\(\s*right\s*\)/.test(normalized)) return 2
  const explicit = normalized.match(/\b([2-9]|two|three|four|five|six|seven|eight|nine)[ -]panel\b/)
  if (!explicit) return null
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }
  return words[explicit[1]!] || Number(explicit[1])
}

function tableRegionCandidate(region: AnxRegionEvidence): boolean {
  if (region.kind === 'table') return true
  return /\bdocling classification:\s*table\b/i.test(region.provenance.notes || '')
    || /^table(?:\s+from\s+page|\s+[a-z]?\d+[.:])/i.test(region.description || '')
}

function sameSourceObject(left: AnxRegionEvidence, right: AnxRegionEvidence): boolean {
  if (left.page !== right.page) return false
  return overlapRatio(normalizedCoordinates(left.bbox), normalizedCoordinates(right.bbox)) >= 0.85
}

function normalizedCoordinates(bbox: [number, number, number, number]): [number, number, number, number] {
  return [Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]), Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])]
}

function overlapRatio(left: [number, number, number, number], right: [number, number, number, number]): number {
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]))
  const height = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]))
  const intersection = width * height
  const leftArea = Math.max(0, left[2] - left[0]) * Math.max(0, left[3] - left[1])
  const rightArea = Math.max(0, right[2] - right[0]) * Math.max(0, right[3] - right[1])
  const smallerArea = Math.min(leftArea, rightArea)
  return smallerArea > 0 ? intersection / smallerArea : 0
}

function coordinateOriginFor(value: unknown): 'TOPLEFT' | 'BOTTOMLEFT' {
  return String(value || 'BOTTOMLEFT').toUpperCase() === 'TOPLEFT' ? 'TOPLEFT' : 'BOTTOMLEFT'
}

function sourcePageSize(document: AndocDocument, page: number): { width: number; height: number } {
  const layout = document.metadata.layout
  const sizes = layout && typeof layout === 'object' && !Array.isArray(layout) ? (layout as Record<string, unknown>).sourcePageSizes : null
  const raw = sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? (sizes as Record<string, unknown>)[String(page)] : null
  const width = raw && typeof raw === 'object' && !Array.isArray(raw) ? Number((raw as Record<string, unknown>).width) : 612
  const height = raw && typeof raw === 'object' && !Array.isArray(raw) ? Number((raw as Record<string, unknown>).height) : 792
  return { width: Number.isFinite(width) && width > 0 ? width : 612, height: Number.isFinite(height) && height > 0 ? height : 792 }
}

function sourcePageCount(document: AndocDocument): number | null {
  const source = document.metadata.source
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const count = Number((source as Record<string, unknown>).pageCount)
    if (Number.isInteger(count) && count > 0) return count
  }
  const layout = document.metadata.layout
  const sizes = layout && typeof layout === 'object' && !Array.isArray(layout) ? (layout as Record<string, unknown>).sourcePageSizes : null
  if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) return null
  const pages = Object.keys(sizes).map(Number).filter(page => Number.isInteger(page) && page > 0)
  return pages.length ? Math.max(...pages) : null
}

function documentNodeIds(document: AndocDocument): Set<string> {
  const ids = new Set<string>()
  const visitListItems = (items: Extract<AndocBlock, { type: 'list' }>['items']): void => {
    for (const item of items) {
      ids.add(item.id)
      if (item.children?.length) visitListItems(item.children)
    }
  }
  for (const block of document.blocks) {
    ids.add(block.id)
    if (block.type === 'table') {
      for (const row of block.rows) for (const cell of row) ids.add(cell.id)
    } else if (block.type === 'list') {
      visitListItems(block.items)
    }
  }
  return ids
}

function numericBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const bbox = value.map(Number) as [number, number, number, number]
  if (!bbox.every(Number.isFinite) || bbox[0] === bbox[2] || bbox[1] === bbox[3]) return null
  return bbox
}

function normalizedBox(
  bbox: [number, number, number, number],
  coordinateOrigin: 'TOPLEFT' | 'BOTTOMLEFT',
  pageSize: { width: number; height: number },
): AnxRegionEvidence['displayBox'] | null {
  const left = Math.max(0, Math.min(bbox[0], bbox[2]))
  const right = Math.min(pageSize.width, Math.max(bbox[0], bbox[2]))
  const lower = Math.max(0, Math.min(bbox[1], bbox[3]))
  const upper = Math.min(pageSize.height, Math.max(bbox[1], bbox[3]))
  const top = coordinateOrigin === 'TOPLEFT' ? lower : pageSize.height - upper
  if (right <= left || upper <= lower) return null
  return {
    leftPercent: rounded(left / pageSize.width * 100),
    topPercent: rounded(top / pageSize.height * 100),
    widthPercent: rounded((right - left) / pageSize.width * 100),
    heightPercent: rounded((upper - lower) / pageSize.height * 100),
  }
}

function runsText(runs: Array<{ text: string }> | undefined): string {
  return (runs || []).map(run => run.text).join('').trim()
}

function rounded(value: number): number {
  return Number(value.toFixed(5))
}
