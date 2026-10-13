import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { sha256 } from './hash.js'

export const PDF_PAGE_OBJECT_ANALYSIS_SCHEMA = 'anx.pdf-page-object-analysis.v1' as const

export interface PdfPlacedImage {
  page: number
  sourceName: string
  pixelWidth: number | null
  pixelHeight: number | null
  bbox: [number, number, number, number]
  pageSize: { width: number; height: number }
  areaRatio: number
}

export interface PdfVectorTableCandidate {
  page: number
  bbox: [number, number, number, number]
  pageSize: { width: number; height: number }
  horizontalRuleCount: number
  verticalRuleCount: number
}

export interface PdfPageObjectAnalysis {
  schema: typeof PDF_PAGE_OBJECT_ANALYSIS_SCHEMA
  pages: number
  placedImages: PdfPlacedImage[]
  vectorTableCandidates: PdfVectorTableCandidate[]
}

export type PdfPageObjectKind = 'table' | 'text' | 'note' | 'caption' | 'figure' | 'screenshot' | 'visualization' | 'simulation' | 'infographic' | 'roster' | 'logo' | 'qrCode' | 'chart' | 'map' | 'equation' | 'handwriting' | 'signature' | 'other'

export interface PdfSourceRegionDraft {
  id: string
  kind: PdfPageObjectKind
  page: number
  bbox: [number, number, number, number] | null
  coordinateOrigin: 'TOPLEFT' | 'BOTTOMLEFT' | null
  status: 'observed' | 'candidate' | 'verified' | 'abstained'
  sourceBlockId?: string
  description?: string
  structuredData?: Record<string, unknown>
  provenance: Record<string, unknown>
}

export interface PdfTextGeometry {
  reference: string
  page: number
  label: string
  text: string
  bbox: [number, number, number, number]
}

export interface PdfPageObjectMergeOptions {
  sourcePath: string
  sourceSha256: string
  capturedAt: string
}

export interface PdfPageObjectMergeResult {
  regions: PdfSourceRegionDraft[]
  expandedRegions: number
  imageRegionsAdded: number
  panelRegionsAdded: number
  parentRegionsAdded: number
  vectorTableCandidatesAdded: number
  infographicCandidatesAdded: number
}

interface PathBox {
  bbox: [number, number, number, number]
}

export async function analyzePdfPageObjects(pdfBytes: Uint8Array): Promise<PdfPageObjectAnalysis> {
  const loadingTask = getDocument({ data: pdfBytes.slice() })
  const pdf = await loadingTask.promise
  const pageCount = pdf.numPages
  const placedImages: PdfPlacedImage[] = []
  const vectorTableCandidates: PdfVectorTableCandidate[] = []

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const operatorList = await page.getOperatorList()
      const width = Math.abs((page.view[2] || 0) - (page.view[0] || 0))
      const height = Math.abs((page.view[3] || 0) - (page.view[1] || 0))
      const pageSize = { width, height }
      const matrixStack: number[][] = []
      let matrix = [1, 0, 0, 1, 0, 0]
      const pageImages: PdfPlacedImage[] = []
      const paths: PathBox[] = []

      for (let index = 0; index < operatorList.fnArray.length; index += 1) {
        const operation = operatorList.fnArray[index]
        const args = operatorList.argsArray[index] as unknown[] | null
        if (operation === OPS.save) {
          matrixStack.push([...matrix])
          continue
        }
        if (operation === OPS.restore) {
          matrix = matrixStack.pop() || [1, 0, 0, 1, 0, 0]
          continue
        }
        if (operation === OPS.transform && args) {
          matrix = Util.transform(matrix, Array.from(args as number[]))
          continue
        }
        if (operation === OPS.paintFormXObjectBegin && args?.[0]) {
          matrixStack.push([...matrix])
          matrix = Util.transform(matrix, Array.from(args[0] as ArrayLike<number>))
          continue
        }
        if (operation === OPS.paintFormXObjectEnd) {
          matrix = matrixStack.pop() || matrix
          continue
        }
        if (operation === OPS.constructPath && args?.[2]) {
          const bounds = operatorBounds(args[2])
          if (!bounds) continue
          const bbox = transformedBox(bounds, matrix)
          const clipped = clippedPathBox(bbox, pageSize)
          if (clipped) paths.push({ bbox: clipped })
          continue
        }
        if (operation !== OPS.paintImageXObject
          && operation !== OPS.paintInlineImageXObject
          && operation !== OPS.paintImageMaskXObject) continue

        const bbox = clippedBox(transformedBox([0, 0, 1, 1], matrix), pageSize)
        if (!bbox) continue
        const details = args?.[0]
        const sourceName = operation === OPS.paintImageXObject && typeof details === 'string'
          ? details
          : `inline-${pageNumber}-${index}`
        const pixelWidth = finiteInteger(args?.[1])
          ?? finiteInteger(isRecord(details) ? details.width : null)
        const pixelHeight = finiteInteger(args?.[2])
          ?? finiteInteger(isRecord(details) ? details.height : null)
        pageImages.push({
          page: pageNumber,
          sourceName,
          pixelWidth,
          pixelHeight,
          bbox,
          pageSize,
          areaRatio: rounded(boxArea(bbox) / (width * height)),
        })
      }

      placedImages.push(...deduplicateImages(pageImages))
      vectorTableCandidates.push(...detectVectorTables(pageNumber, pageSize, paths))
      page.cleanup()
    }
  } finally {
    await loadingTask.destroy()
  }

  return {
    schema: PDF_PAGE_OBJECT_ANALYSIS_SCHEMA,
    pages: pageCount,
    placedImages,
    vectorTableCandidates,
  }
}

export function mergePdfPageObjectEvidence(
  analysis: PdfPageObjectAnalysis,
  sourceRegions: PdfSourceRegionDraft[],
  textItems: PdfTextGeometry[],
  options: PdfPageObjectMergeOptions,
): PdfPageObjectMergeResult {
  const regions: PdfSourceRegionDraft[] = sourceRegions.map(region => ({
    ...region,
    bbox: region.bbox ? [...region.bbox] as [number, number, number, number] : null,
    ...(region.structuredData ? { structuredData: structuredClone(region.structuredData) } : {}),
    provenance: { ...region.provenance },
  }))
  let expandedRegions = 0
  let imageRegionsAdded = 0
  let panelRegionsAdded = 0
  let parentRegionsAdded = 0

  const pageNumbers = new Set([
    ...analysis.placedImages.map(image => image.page),
    ...analysis.vectorTableCandidates.map(candidate => candidate.page),
    ...textItems.map(item => item.page),
  ])
  for (const page of pageNumbers) {
    const pageImages = analysis.placedImages.filter(image => image.page === page)
    const significantImages = pageImages
      .filter(significantImage)
      .sort((left, right) => left.bbox[0] - right.bbox[0] || left.bbox[1] - right.bbox[1])
    if (!significantImages.length) continue

    const pageRegions = regions.filter(region => region.page === page && region.bbox && visualKind(region.kind))
    const matchedImageNames = new Set<string>()
    for (const region of pageRegions) {
      const possibleImages = pageImages.filter(image =>
        image.areaRatio >= 0.004
        && overlapRatio(image.bbox, region.bbox!) >= 0.62
      )
      const bestIou = Math.max(...possibleImages.map(image => intersectionOverUnion(image.bbox, region.bbox!)), 0)
      const matchingImages = possibleImages.filter(image =>
        intersectionOverUnion(image.bbox, region.bbox!) >= Math.max(0.12, bestIou * 0.65)
      )
      if (!matchingImages.length) continue
      matchingImages.forEach(image => matchedImageNames.add(imageKey(image)))
      if (matchingImages.length === 1) {
        const image = matchingImages[0]!
        if (areaGrowth(region.bbox!, image.bbox) >= 0.04) {
          region.bbox = [...image.bbox]
          expandedRegions += 1
        }
        region.structuredData = {
          ...(region.structuredData || {}),
          sourceGeometry: 'pdf-image-placement',
          placedImageSourceName: image.sourceName,
          placedImagePixelWidth: image.pixelWidth,
          placedImagePixelHeight: image.pixelHeight,
          placedImageAreaRatio: image.areaRatio,
        }
        region.provenance = {
          ...region.provenance,
          notes: appendNote(region.provenance.notes, 'Region boundary was reconciled with the PDF placed-image transform.'),
        }
        continue
      }

      region.kind = 'figure'
      region.status = 'candidate'
      const parentId = region.id
      region.structuredData = {
        ...(region.structuredData || {}),
        regionRole: 'multi-panel-parent-candidate',
        expectedPanelCount: matchingImages.length,
        sourceGeometry: 'pdf-image-placement',
      }
      region.provenance = {
        ...region.provenance,
        notes: appendNote(region.provenance.notes, `The importer region contains ${matchingImages.length} distinct PDF placed images; child panels are source-observed while the parent grouping requires review.`),
      }
      for (const [index, image] of matchingImages.entries()) {
        regions.push(sourceImageRegion(image, options, {
          suffix: `panel-${index + 1}`,
          description: `Placed-image panel ${index + 1} of ${matchingImages.length}`,
          structuredData: {
            regionRole: 'multi-panel-child-observed',
            parentRegionId: parentId,
            panelIndex: index + 1,
            panelCount: matchingImages.length,
          },
        }))
        panelRegionsAdded += 1
      }
    }

    for (const image of significantImages) {
      if (matchedImageNames.has(imageKey(image))) continue
      const containingImage = significantImages
        .filter(candidate => candidate !== image && boxArea(candidate.bbox) > boxArea(image.bbox) && containedBy(image.bbox, candidate.bbox, 2))
        .sort((left, right) => boxArea(left.bbox) - boxArea(right.bbox))[0]
      const containedImages = pageImages
        .filter(candidate => candidate !== image && candidate.areaRatio >= 0.004 && containedBy(candidate.bbox, image.bbox, 2))
        .map(candidate => candidate.sourceName)
      regions.push(sourceImageRegion(image, options, {
        structuredData: containingImage ? {
          regionRole: 'nested-source-image',
          containingPlacedImageSourceName: containingImage.sourceName,
        } : {
          regionRole: 'source-image-observed',
          ...(containedImages.length ? { containedPlacedImageSourceNames: containedImages } : {}),
        },
      }))
      imageRegionsAdded += 1
    }

    const observedChildren = regions.filter(region =>
      region.page === page
      && region.bbox
      && region.status === 'observed'
      && region.structuredData?.sourceGeometry === 'pdf-image-placement'
    )
    const pair = horizontalVisualPair(observedChildren, significantImages[0]!.pageSize)
    if (pair && !regions.some(region =>
      region.page === page
      && typeof region.structuredData?.regionRole === 'string'
      && /parent-candidate$/.test(region.structuredData.regionRole)
    )) {
      const bbox = unionBoxes(pair.map(region => region.bbox!))
      const parentId = stableRegionId(options.sourceSha256, page, bbox, 'visual-pair-parent')
      for (const child of pair) {
        child.structuredData = {
          ...(child.structuredData || {}),
          parentRegionId: parentId,
        }
      }
      regions.push({
        id: parentId,
        kind: 'figure',
        page,
        bbox,
        coordinateOrigin: 'BOTTOMLEFT',
        status: 'candidate',
        description: 'Side-by-side visual group candidate',
        structuredData: {
          regionRole: 'source-visual-parent-candidate',
          childRegionIds: pair.map(region => region.id),
          expectedPanelCount: pair.length,
        },
        provenance: extractionProvenance(options, 'Two source-observed placed images have aligned PDF geometry; their parent grouping remains review-required.', 0.82),
      })
      parentRegionsAdded += 1
    }
  }

  let vectorTableCandidatesAdded = 0
  for (const candidate of analysis.vectorTableCandidates) {
    const existing = regions.some(region =>
      region.page === candidate.page
      && region.bbox
      && region.kind === 'table'
      && overlapRatio(region.bbox, candidate.bbox) >= 0.75
    )
    if (existing) continue
    regions.push({
      id: stableRegionId(options.sourceSha256, candidate.page, candidate.bbox, 'vector-table'),
      kind: 'table',
      page: candidate.page,
      bbox: [...candidate.bbox],
      coordinateOrigin: 'BOTTOMLEFT',
      status: 'candidate',
      description: `Vector-ruled table candidate · ${candidate.horizontalRuleCount} horizontal and ${candidate.verticalRuleCount} vertical rules`,
      structuredData: {
        regionRole: 'vector-table-candidate',
        horizontalRuleCount: candidate.horizontalRuleCount,
        verticalRuleCount: candidate.verticalRuleCount,
        sourceGeometry: 'pdf-vector-paths',
      },
      provenance: extractionProvenance(options, 'Candidate boundary is derived from repeated PDF vector rules. Cell structure and semantic table status require review.', 0.78),
    })
    vectorTableCandidatesAdded += 1
  }

  let infographicCandidatesAdded = 0
  for (const candidate of infographicCandidates(textItems, analysis)) {
    const existing = regions.some(region =>
      region.page === candidate.page
      && region.bbox
      && overlapRatio(region.bbox, candidate.bbox) >= 0.8
    )
    if (existing) continue
    regions.push({
      id: stableRegionId(options.sourceSha256, candidate.page, candidate.bbox, 'text-grid-infographic'),
      kind: 'infographic',
      page: candidate.page,
      bbox: candidate.bbox,
      coordinateOrigin: 'BOTTOMLEFT',
      status: 'candidate',
      description: candidate.title,
      structuredData: {
        regionRole: 'text-grid-infographic-candidate',
        columnCount: candidate.columnCount,
        titleReference: candidate.titleReference,
        headingReferences: candidate.headingReferences,
        bodyReferences: candidate.bodyReferences,
        sourceGeometry: 'docling-text-layout',
      },
      provenance: extractionProvenance(options, 'A title plus aligned heading/body columns indicates a composite infographic. The boundary is deterministic; semantic grouping requires review.', 0.76),
    })
    infographicCandidatesAdded += 1
  }

  return {
    regions,
    expandedRegions,
    imageRegionsAdded,
    panelRegionsAdded,
    parentRegionsAdded,
    vectorTableCandidatesAdded,
    infographicCandidatesAdded,
  }
}

function detectVectorTables(
  page: number,
  pageSize: { width: number; height: number },
  paths: PathBox[],
): PdfVectorTableCandidate[] {
  const enclosedCandidates = paths.flatMap(path => {
    const width = boxWidth(path.bbox)
    const height = boxHeight(path.bbox)
    if (width < pageSize.width * 0.15
      || width > pageSize.width * 0.8
      || height < pageSize.height * 0.04
      || height > pageSize.height * 0.4
      || width / height < 1.35) return []
    const horizontalRuleCount = paths.filter(candidate => {
      const candidateWidth = boxWidth(candidate.bbox)
      const candidateHeight = boxHeight(candidate.bbox)
      return candidateHeight <= 2
        && candidateWidth >= width * 0.7
        && containedBy(candidate.bbox, path.bbox, 2)
    }).length
    const verticalRuleCount = paths.filter(candidate => {
      const candidateWidth = boxWidth(candidate.bbox)
      const candidateHeight = boxHeight(candidate.bbox)
      return candidateWidth <= 2
        && candidateHeight >= height * 0.7
        && containedBy(candidate.bbox, path.bbox, 2)
    }).length
    if (horizontalRuleCount < 4 && !(horizontalRuleCount >= 2 && verticalRuleCount >= 2)) return []
    return [{
      page,
      bbox: path.bbox,
      pageSize,
      horizontalRuleCount,
      verticalRuleCount,
    }]
  })

  const bandCandidates = horizontalRuleBandTables(page, pageSize, paths)
  return [...enclosedCandidates, ...bandCandidates]
    .sort((left, right) => boxArea(left.bbox) - boxArea(right.bbox))
    .filter((candidate, index, all) => !all.slice(0, index).some(existing => overlapRatio(existing.bbox, candidate.bbox) >= 0.9))
}

function horizontalRuleBandTables(
  page: number,
  pageSize: { width: number; height: number },
  paths: PathBox[],
): PdfVectorTableCandidate[] {
  const horizontal = paths
    .map(path => ({ ...path, bbox: normalizedBox(path.bbox) }))
    .filter(path => {
      const width = boxWidth(path.bbox)
      return boxHeight(path.bbox) <= 2.5
        && width >= pageSize.width * 0.15
        && width <= pageSize.width * 0.62
    })
  const candidates: PdfVectorTableCandidate[] = []
  for (const anchor of horizontal) {
    const aligned = horizontal
      .filter(path => Math.abs(path.bbox[0] - anchor.bbox[0]) <= pageSize.width * 0.035
        && Math.abs(path.bbox[2] - anchor.bbox[2]) <= pageSize.width * 0.035)
      .sort((left, right) => left.bbox[1] - right.bbox[1])
    if (aligned.length < 4) continue
    const distinct = aligned.filter((path, index, all) => index === 0 || Math.abs(path.bbox[1] - all[index - 1]!.bbox[1]) > 2.5)
    if (distinct.length < 4) continue
    const span = distinct.at(-1)!.bbox[1] - distinct[0]!.bbox[1]
    if (span < pageSize.height * 0.08 || span > pageSize.height * 0.58) continue
    const gaps = distinct.slice(1).map((path, index) => path.bbox[1] - distinct[index]!.bbox[1]).filter(value => value > 3)
    const sortedGaps = [...gaps].sort((left, right) => left - right)
    const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || pageSize.height * 0.035
    if (gaps.some(gap => gap > Math.max(pageSize.height * 0.16, medianGap * 3.2))) continue
    const padding = Math.min(pageSize.height * 0.04, Math.max(5, medianGap * 0.6))
    const bbox: [number, number, number, number] = [
      Math.max(0, Math.min(...distinct.map(path => path.bbox[0])) - 4),
      Math.max(0, distinct[0]!.bbox[1] - padding),
      Math.min(pageSize.width, Math.max(...distinct.map(path => path.bbox[2])) + 4),
      Math.min(pageSize.height, distinct.at(-1)!.bbox[3] + padding),
    ]
    const verticalRuleCount = paths.filter(path => {
      const normalized = normalizedBox(path.bbox)
      return boxWidth(normalized) <= 2.5
        && boxHeight(normalized) >= boxHeight(bbox) * 0.6
        && containedBy(normalized, bbox, 3)
    }).length
    candidates.push({
      page,
      bbox,
      pageSize,
      horizontalRuleCount: distinct.length,
      verticalRuleCount,
    })
  }
  return candidates
    .sort((left, right) => boxArea(left.bbox) - boxArea(right.bbox))
    .filter((candidate, index, all) => !all.slice(0, index).some(existing => overlapRatio(existing.bbox, candidate.bbox) >= 0.9))
}

function deduplicateImages(images: PdfPlacedImage[]): PdfPlacedImage[] {
  return images.filter((candidate, index, all) => !all.slice(0, index).some(existing =>
    existing.sourceName === candidate.sourceName
    && overlapRatio(existing.bbox, candidate.bbox) >= 0.995
  ))
}

function transformedBox(value: number[], matrix: number[]): [number, number, number, number] {
  const [left, lower, right, upper] = value
  const points = [
    [left, lower],
    [right, lower],
    [left, upper],
    [right, upper],
  ]
  for (const point of points) Util.applyTransform(point, matrix)
  return [
    Math.min(...points.map(point => point[0]!)),
    Math.min(...points.map(point => point[1]!)),
    Math.max(...points.map(point => point[0]!)),
    Math.max(...points.map(point => point[1]!)),
  ]
}

function clippedBox(
  value: [number, number, number, number],
  pageSize: { width: number; height: number },
): [number, number, number, number] | null {
  const result: [number, number, number, number] = [
    Math.max(0, Math.min(pageSize.width, value[0])),
    Math.max(0, Math.min(pageSize.height, value[1])),
    Math.max(0, Math.min(pageSize.width, value[2])),
    Math.max(0, Math.min(pageSize.height, value[3])),
  ]
  return boxWidth(result) > 0.5 && boxHeight(result) > 0.5 ? result : null
}

function clippedPathBox(
  value: [number, number, number, number],
  pageSize: { width: number; height: number },
): [number, number, number, number] | null {
  const result: [number, number, number, number] = [
    Math.max(0, Math.min(pageSize.width, value[0])),
    Math.max(0, Math.min(pageSize.height, value[1])),
    Math.max(0, Math.min(pageSize.width, value[2])),
    Math.max(0, Math.min(pageSize.height, value[3])),
  ]
  return boxWidth(result) > 0.5 || boxHeight(result) > 0.5 ? result : null
}

function containedBy(
  inner: [number, number, number, number],
  outer: [number, number, number, number],
  tolerance = 0,
): boolean {
  return inner[0] >= outer[0] - tolerance
    && inner[1] >= outer[1] - tolerance
    && inner[2] <= outer[2] + tolerance
    && inner[3] <= outer[3] + tolerance
}

function overlapRatio(
  left: [number, number, number, number],
  right: [number, number, number, number],
): number {
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]))
  const height = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]))
  const smallerArea = Math.min(boxArea(left), boxArea(right))
  return smallerArea > 0 ? (width * height) / smallerArea : 0
}

function intersectionOverUnion(
  left: [number, number, number, number],
  right: [number, number, number, number],
): number {
  const width = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]))
  const height = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]))
  const intersection = width * height
  const union = boxArea(left) + boxArea(right) - intersection
  return union > 0 ? intersection / union : 0
}

function boxArea(value: [number, number, number, number]): number {
  return boxWidth(value) * boxHeight(value)
}

function boxWidth(value: [number, number, number, number]): number {
  return Math.max(0, value[2] - value[0])
}

function boxHeight(value: [number, number, number, number]): number {
  return Math.max(0, value[3] - value[1])
}

function finiteInteger(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null
}

function operatorBounds(value: unknown): [number, number, number, number] | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<number, unknown>
  const bounds = [Number(candidate[0]), Number(candidate[1]), Number(candidate[2]), Number(candidate[3])]
  return bounds.every(Number.isFinite) ? bounds as [number, number, number, number] : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function rounded(value: number): number {
  return Math.round(value * 100_000) / 100_000
}

function significantImage(image: PdfPlacedImage): boolean {
  const widthRatio = boxWidth(image.bbox) / image.pageSize.width
  const heightRatio = boxHeight(image.bbox) / image.pageSize.height
  return image.areaRatio >= 0.055 && widthRatio >= 0.14 && heightRatio >= 0.1
}

function visualKind(kind: PdfPageObjectKind): boolean {
  return ['figure', 'screenshot', 'visualization', 'simulation', 'infographic', 'chart', 'map', 'other'].includes(kind)
}

function imageKey(image: PdfPlacedImage): string {
  return `${image.page}:${image.sourceName}:${image.bbox.map(value => rounded(value)).join(',')}`
}

function areaGrowth(
  current: [number, number, number, number],
  replacement: [number, number, number, number],
): number {
  const currentArea = boxArea(current)
  return currentArea > 0 ? Math.abs(boxArea(replacement) - currentArea) / currentArea : 1
}

function sourceImageRegion(
  image: PdfPlacedImage,
  options: PdfPageObjectMergeOptions,
  details: {
    suffix?: string
    description?: string
    structuredData?: Record<string, unknown>
  } = {},
): PdfSourceRegionDraft {
  return {
    id: stableRegionId(options.sourceSha256, image.page, image.bbox, details.suffix || `image-${image.sourceName}`),
    kind: 'figure',
    page: image.page,
    bbox: [...image.bbox],
    coordinateOrigin: 'BOTTOMLEFT',
    status: 'observed',
    description: details.description || 'PDF placed image',
    structuredData: {
      ...(details.structuredData || {}),
      sourceGeometry: 'pdf-image-placement',
      placedImageSourceName: image.sourceName,
      placedImagePixelWidth: image.pixelWidth,
      placedImagePixelHeight: image.pixelHeight,
      placedImageAreaRatio: image.areaRatio,
    },
    provenance: extractionProvenance(options, 'Region geometry comes directly from the retained PDF placed-image transform.', 0.95),
  }
}

function horizontalVisualPair(
  regions: PdfSourceRegionDraft[],
  pageSize: { width: number; height: number },
): PdfSourceRegionDraft[] | null {
  for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < regions.length; rightIndex += 1) {
      const left = regions[leftIndex]!
      const right = regions[rightIndex]!
      if (!left.bbox || !right.bbox) continue
      const leftBox = normalizedBox(left.bbox)
      const rightBox = normalizedBox(right.bbox)
      const leftHeight = boxHeight(leftBox)
      const rightHeight = boxHeight(rightBox)
      const verticalOverlap = Math.max(0, Math.min(leftBox[3], rightBox[3]) - Math.max(leftBox[1], rightBox[1]))
      const minimumHeight = Math.min(leftHeight, rightHeight)
      const horizontalGap = Math.max(0, Math.max(leftBox[0], rightBox[0]) - Math.min(leftBox[2], rightBox[2]))
      const widthRatio = Math.max(boxWidth(leftBox), boxWidth(rightBox)) / Math.max(1, Math.min(boxWidth(leftBox), boxWidth(rightBox)))
      const heightRatio = Math.max(leftHeight, rightHeight) / Math.max(1, minimumHeight)
      if (minimumHeight <= 0
        || verticalOverlap / minimumHeight < 0.8
        || horizontalGap > pageSize.width * 0.035
        || widthRatio > 1.6
        || heightRatio > 1.5
        || boxArea(leftBox) < pageSize.width * pageSize.height * 0.08
        || boxArea(rightBox) < pageSize.width * pageSize.height * 0.08) continue
      return [left, right].sort((a, b) => a.bbox![0] - b.bbox![0])
    }
  }
  return null
}

interface InfographicCandidate {
  page: number
  bbox: [number, number, number, number]
  title: string
  titleReference: string
  columnCount: number
  headingReferences: string[]
  bodyReferences: string[]
}

function infographicCandidates(
  textItems: PdfTextGeometry[],
  analysis: PdfPageObjectAnalysis,
): InfographicCandidate[] {
  const candidates: InfographicCandidate[] = []
  const pageSizes = new Map<number, { width: number; height: number }>()
  for (const image of analysis.placedImages) pageSizes.set(image.page, image.pageSize)
  for (const table of analysis.vectorTableCandidates) pageSizes.set(table.page, table.pageSize)

  for (const [page, pageItems] of groupByPage(textItems)) {
    const pageSize = pageSizes.get(page)
    if (!pageSize) continue
    const titleCandidates = pageItems.filter(item => {
      const width = boxWidth(item.bbox)
      const text = item.text.trim()
      return text.length >= 8
        && text.length <= 80
        && width >= pageSize.width * 0.07
        && width <= pageSize.width * 0.42
        && ['section_header', 'title'].includes(item.label)
    })
    for (const title of titleCandidates) {
      const titleBox = normalizedBox(title.bbox)
      const headingBand = pageItems.filter(item => {
        if (item.reference === title.reference) return false
        const bbox = normalizedBox(item.bbox)
        const text = item.text.trim()
        return text.length >= 4
          && text.length <= 60
          && boxWidth(bbox) <= pageSize.width * 0.13
          && bbox[3] <= titleBox[1] - 2
          && bbox[3] >= titleBox[1] - pageSize.height * 0.07
      })
      const aligned = largestHorizontalCluster(headingBand, pageSize)
      if (aligned.length < 3 || aligned.length > 8) continue
      const headingBounds = unionBoxes(aligned.map(item => item.bbox))
      if (boxWidth(headingBounds) < pageSize.width * 0.18) continue
      const titleCenter = (titleBox[0] + titleBox[2]) / 2
      if (titleCenter < headingBounds[0] || titleCenter > headingBounds[2]) continue

      const bodyItems: PdfTextGeometry[] = []
      for (const heading of aligned) {
        const headingBox = normalizedBox(heading.bbox)
        const center = (headingBox[0] + headingBox[2]) / 2
        const body = pageItems
          .filter(item => {
            if (aligned.includes(item) || item.reference === title.reference) return false
            const bbox = normalizedBox(item.bbox)
            const itemCenter = (bbox[0] + bbox[2]) / 2
            return item.text.trim().length >= 35
              && bbox[3] < headingBox[1]
              && bbox[1] >= titleBox[1] - pageSize.height * 0.24
              && Math.abs(itemCenter - center) <= Math.max(boxWidth(headingBox), pageSize.width * 0.035)
              && boxWidth(bbox) <= pageSize.width * 0.16
          })
          .sort((left, right) => normalizedBox(right.bbox)[3] - normalizedBox(left.bbox)[3])[0]
        if (body) bodyItems.push(body)
      }
      if (bodyItems.length < 3) continue
      const uniqueBodies = [...new Map(bodyItems.map(item => [item.reference, item])).values()]
      if (uniqueBodies.length < 3) continue
      const contentBoxes = [title.bbox, ...aligned.map(item => item.bbox), ...uniqueBodies.map(item => item.bbox)]
      const bbox = paddedBox(unionBoxes(contentBoxes), pageSize, 6)
      candidates.push({
        page,
        bbox,
        title: title.text.trim(),
        titleReference: title.reference,
        columnCount: aligned.length,
        headingReferences: aligned.map(item => item.reference),
        bodyReferences: uniqueBodies.map(item => item.reference),
      })
      break
    }
  }
  return candidates
}

function largestHorizontalCluster(
  items: PdfTextGeometry[],
  pageSize: { width: number; height: number },
): PdfTextGeometry[] {
  let best: PdfTextGeometry[] = []
  for (const anchor of items) {
    const anchorBox = normalizedBox(anchor.bbox)
    const cluster = items
      .filter(item => {
        const bbox = normalizedBox(item.bbox)
        return Math.abs(bbox[3] - anchorBox[3]) <= pageSize.height * 0.025
      })
      .sort((left, right) => normalizedBox(left.bbox)[0] - normalizedBox(right.bbox)[0])
      .filter((item, index, all) => index === 0
        || normalizedBox(item.bbox)[0] - normalizedBox(all[index - 1]!.bbox)[0] >= pageSize.width * 0.025)
    const segments: PdfTextGeometry[][] = []
    for (const item of cluster) {
      const segment = segments.at(-1)
      const previous = segment?.at(-1)
      if (!segment || !previous || normalizedBox(item.bbox)[0] - normalizedBox(previous.bbox)[0] > pageSize.width * 0.09) {
        segments.push([item])
      } else {
        segment.push(item)
      }
    }
    const candidate = segments.sort((left, right) => right.length - left.length)[0] || []
    if (candidate.length > best.length) best = candidate
  }
  return best
}

function groupByPage(items: PdfTextGeometry[]): Map<number, PdfTextGeometry[]> {
  const result = new Map<number, PdfTextGeometry[]>()
  for (const item of items) {
    const page = result.get(item.page) || []
    page.push(item)
    result.set(item.page, page)
  }
  return result
}

function unionBoxes(values: Array<[number, number, number, number]>): [number, number, number, number] {
  const normalized = values.map(normalizedBox)
  return [
    Math.min(...normalized.map(value => value[0])),
    Math.min(...normalized.map(value => value[1])),
    Math.max(...normalized.map(value => value[2])),
    Math.max(...normalized.map(value => value[3])),
  ]
}

function paddedBox(
  value: [number, number, number, number],
  pageSize: { width: number; height: number },
  padding: number,
): [number, number, number, number] {
  return [
    Math.max(0, value[0] - padding),
    Math.max(0, value[1] - padding),
    Math.min(pageSize.width, value[2] + padding),
    Math.min(pageSize.height, value[3] + padding),
  ]
}

function normalizedBox(value: [number, number, number, number]): [number, number, number, number] {
  return [
    Math.min(value[0], value[2]),
    Math.min(value[1], value[3]),
    Math.max(value[0], value[2]),
    Math.max(value[1], value[3]),
  ]
}

function stableRegionId(
  sourceSha256: string,
  page: number,
  bbox: [number, number, number, number],
  role: string,
): string {
  const geometry = bbox.map(value => rounded(value).toFixed(5)).join(':')
  return `region-pdf-object-${sha256(new TextEncoder().encode(`${sourceSha256}:${page}:${geometry}:${role}`)).slice(0, 24)}`
}

function extractionProvenance(
  options: PdfPageObjectMergeOptions,
  notes: string,
  confidence: number,
): Record<string, unknown> {
  return {
    method: 'local-extraction',
    source: options.sourcePath,
    verified: false,
    sourceSha256: options.sourceSha256,
    engine: 'pdfjs-dist',
    confidence,
    capturedAt: options.capturedAt,
    notes,
  }
}

function appendNote(value: unknown, note: string): string {
  return [typeof value === 'string' ? value.trim() : '', note].filter(Boolean).join(' ')
}
