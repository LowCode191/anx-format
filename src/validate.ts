import { createRequire } from 'node:module'
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import type { AnxDocumentRelationships } from './relationships.js'
import type { AnxRegionCorrections } from './region-evidence.js'
import type { AndocDocument, AndocFinalization, AndocLineage, AndocManifest, AndocProfiles, AndocTransaction, AnxSourceBaselines, ValidationIssue, ValidationResult } from './types.js'
import { chartDataIssues, isStructuredChartData } from './chart-data.js'
import { profileSemanticIssues } from './profiles.js'

const require = createRequire(import.meta.url)
const documentSchema = require('../schemas/andoc.document.v1.schema.json') as object
const manifestSchema = require('../schemas/andoc.manifest.v1.schema.json') as object
const transactionSchema = require('../schemas/andoc.transaction.v1.schema.json') as object
const profilesSchema = require('../schemas/andoc.profiles.v1.schema.json') as object
const finalizationSchema = require('../schemas/andoc.finalization.v1.schema.json') as object
const lineageSchema = require('../schemas/andoc.lineage.v1.schema.json') as object
const sourceBaselineSchema = require('../schemas/anx.source-baseline.v1.schema.json') as object
const relationshipsSchema = require('../schemas/anx.relationships.v1.schema.json') as object
const regionCorrectionsSchema = require('../schemas/anx.region-corrections.v1.schema.json') as object

const ajv = new Ajv2020({ allErrors: true, strict: false, formats: permissiveFormats() })
const validateDocumentSchema = ajv.compile<AndocDocument>(documentSchema)
const validateManifestSchema = ajv.compile<AndocManifest>(manifestSchema)
const validateTransactionSchema = ajv.compile<AndocTransaction>(transactionSchema)
const validateProfilesSchema = ajv.compile<AndocProfiles>(profilesSchema)
const validateFinalizationSchema = ajv.compile<AndocFinalization>(finalizationSchema)
const validateLineageSchema = ajv.compile<AndocLineage>(lineageSchema)
const validateSourceBaselinesSchema = ajv.compile<AnxSourceBaselines>(sourceBaselineSchema)
const validateRelationshipsSchema = ajv.compile<AnxDocumentRelationships>(relationshipsSchema)
const validateRegionCorrectionsSchema = ajv.compile<AnxRegionCorrections>(regionCorrectionsSchema)

export function validateDocument(value: unknown): ValidationResult {
  const valid = validateDocumentSchema(value)
  const issues = valid ? [] : ajvIssues(validateDocumentSchema.errors)
  if (!valid) return { ok: false, issues }

  const document = value as AndocDocument
  const ids = new Set<string>()
  for (let index = 0; index < document.blocks.length; index += 1) {
    const block = document.blocks[index]!
    if (ids.has(block.id)) {
      issues.push({ code: 'duplicate_block_id', path: `/blocks/${index}/id`, message: `Duplicate block id: ${block.id}` })
    }
    ids.add(block.id)

    if (block.type === 'table') {
      block.rows.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
        if (ids.has(cell.id)) {
          issues.push({
            code: 'duplicate_cell_id',
            path: `/blocks/${index}/rows/${rowIndex}/${columnIndex}/id`,
            message: `Duplicate node id: ${cell.id}`,
          })
        }
        ids.add(cell.id)
      }))
    }

    if (block.type === 'list') {
      const visitItems = (items: typeof block.items, path: string): void => {
        items.forEach((item, itemIndex) => {
          const itemPath = `${path}/${itemIndex}`
          if (ids.has(item.id)) {
            issues.push({ code: 'duplicate_list_item_id', path: `${itemPath}/id`, message: `Duplicate node id: ${item.id}` })
          }
          ids.add(item.id)
          if (item.children?.length) visitItems(item.children, `${itemPath}/children`)
        })
      }
      visitItems(block.items, `/blocks/${index}/items`)
    }

    if (block.type === 'chart' && block.spec.schema === 'andoc.chart.v1' && block.spec.data !== null && block.spec.data !== undefined) {
      if (!isStructuredChartData(block.spec.data)) {
        issues.push({ code: 'invalid_chart_data', path: `/blocks/${index}/spec/data`, message: 'Chart data must contain non-empty columns and scalar rows' })
      } else {
        chartDataIssues(block.spec.data).forEach(message => issues.push({ code: 'invalid_chart_data', path: `/blocks/${index}/spec/data`, message }))
      }
    }

    for (const assetId of blockAssetIds(block)) {
      if (!document.assets[assetId]) {
        issues.push({ code: 'missing_asset', path: `/blocks/${index}`, message: `Block references missing asset: ${assetId}` })
      }
    }
  }

  for (let index = 0; index < document.blocks.length; index += 1) {
    const block = document.blocks[index]!
    if (block.type !== 'footnote') continue
    if (block.anchorStatus === 'resolved' && !block.anchorIds?.length) {
      issues.push({
        code: 'resolved_note_without_anchor',
        path: `/blocks/${index}/anchorIds`,
        message: 'A resolved footnote or endnote requires at least one stable anchor ID',
      })
    }
    if (block.anchorStatus === 'unanchored' && block.anchorIds?.length) {
      issues.push({
        code: 'unanchored_note_with_anchor',
        path: `/blocks/${index}/anchorIds`,
        message: 'An unanchored footnote or endnote cannot declare anchor IDs',
      })
    }
    block.anchorIds?.forEach((anchorId, anchorIndex) => {
      if (anchorId === block.id) {
        issues.push({
          code: 'self_anchored_note',
          path: `/blocks/${index}/anchorIds/${anchorIndex}`,
          message: 'A footnote or endnote cannot anchor to itself',
        })
      } else if (!ids.has(anchorId)) {
        issues.push({
          code: 'missing_note_anchor',
          path: `/blocks/${index}/anchorIds/${anchorIndex}`,
          message: `Footnote or endnote references missing stable node: ${anchorId}`,
        })
      }
    })
  }

  for (const [key, asset] of Object.entries(document.assets)) {
    if (key !== asset.id) {
      issues.push({ code: 'asset_key_mismatch', path: `/assets/${key}/id`, message: `Asset key ${key} does not match id ${asset.id}` })
    }
  }

  if (document.metadata.anxRelationships !== undefined) {
    const relationships = validateRelationships(document.metadata.anxRelationships)
    issues.push(...relationships.issues.map(issue => ({
      ...issue,
      path: `/metadata/anxRelationships${issue.path === '/' ? '' : issue.path}`,
    })))
  }

  if (document.metadata.anxRegionCorrections !== undefined) {
    const validCorrections = validateRegionCorrectionsSchema(document.metadata.anxRegionCorrections)
    if (!validCorrections) {
      issues.push(...ajvIssues(validateRegionCorrectionsSchema.errors).map(issue => ({
        ...issue,
        path: `/metadata/anxRegionCorrections${issue.path === '/' ? '' : issue.path}`,
      })))
    } else {
      const correctionIds = new Set<string>()
      const regionIds = new Set<string>()
      ;(document.metadata.anxRegionCorrections as AnxRegionCorrections).entries.forEach((entry, index) => {
        if (correctionIds.has(entry.id)) {
          issues.push({ code: 'duplicate_region_correction_id', path: `/metadata/anxRegionCorrections/entries/${index}/id`, message: `Duplicate region correction id: ${entry.id}` })
        }
        if (regionIds.has(entry.regionId)) {
          issues.push({ code: 'duplicate_region_correction_target', path: `/metadata/anxRegionCorrections/entries/${index}/regionId`, message: `Only one active correction may target region ${entry.regionId}` })
        }
        correctionIds.add(entry.id)
        regionIds.add(entry.regionId)
        if (entry.bbox[0] === entry.bbox[2] || entry.bbox[1] === entry.bbox[3]) {
          issues.push({ code: 'empty_region_correction_bbox', path: `/metadata/anxRegionCorrections/entries/${index}/bbox`, message: 'Region correction bbox must have non-zero area' })
        }
        if (entry.sourceRevision > document.revision) {
          issues.push({ code: 'future_region_correction_revision', path: `/metadata/anxRegionCorrections/entries/${index}/sourceRevision`, message: 'Region correction source revision cannot exceed the document revision' })
        }
        if (entry.kind === 'note' && entry.anchorBlockId && !ids.has(entry.anchorBlockId)) {
          issues.push({ code: 'missing_note_correction_anchor', path: `/metadata/anxRegionCorrections/entries/${index}/anchorBlockId`, message: `Note correction references missing stable node: ${entry.anchorBlockId}` })
        }
      })
    }
  }

  return { ok: issues.length === 0, issues, document }
}

export function validateRelationships(value: unknown): { ok: boolean; issues: ValidationIssue[]; relationships?: AnxDocumentRelationships } {
  const valid = validateRelationshipsSchema(value)
  const issues = valid ? [] : ajvIssues(validateRelationshipsSchema.errors)
  if (!valid) return { ok: false, issues }
  const relationships = value as AnxDocumentRelationships
  const ids = new Set<string>()
  relationships.relationships.forEach((relationship, index) => {
    if (ids.has(relationship.id)) {
      issues.push({
        code: 'duplicate_relationship_id',
        path: `/relationships/${index}/id`,
        message: `Duplicate relationship id: ${relationship.id}`,
      })
    }
    ids.add(relationship.id)
    if (relationship.resolution.contentAvailable && relationship.resolution.status !== 'resolved') {
      issues.push({
        code: 'relationship_content_resolution_mismatch',
        path: `/relationships/${index}/resolution`,
        message: 'Available target content requires resolved status',
      })
    }
    if (!relationship.resolution.contentAvailable && relationship.resolution.status === 'resolved') {
      issues.push({
        code: 'relationship_content_resolution_mismatch',
        path: `/relationships/${index}/resolution`,
        message: 'Resolved target content must be marked available',
      })
    }
    if (relationship.resolution.status === 'resolved' && !relationship.resolution.resolvedDocumentId) {
      issues.push({
        code: 'relationship_resolved_document_missing',
        path: `/relationships/${index}/resolution/resolvedDocumentId`,
        message: 'Resolved target content requires a stable ANX document ID',
      })
    }
    if (relationship.authority.status === 'human-approved'
      && (!relationship.authority.approvedBy || !relationship.authority.approvedAt)) {
      issues.push({
        code: 'relationship_approval_missing',
        path: `/relationships/${index}/authority`,
        message: 'Human-approved relationships require approvedBy and approvedAt',
      })
    }
    if (relationship.status === 'removed' && (!relationship.removedBy || !relationship.removedAt)) {
      issues.push({
        code: 'relationship_removal_missing',
        path: `/relationships/${index}`,
        message: 'Removed relationships require removedBy and removedAt',
      })
    }
  })
  return { ok: issues.length === 0, issues, ...(issues.length ? {} : { relationships }) }
}

export function validateManifest(value: unknown): { ok: boolean; issues: ValidationIssue[]; manifest?: AndocManifest } {
  const valid = validateManifestSchema(value)
  const issues = valid ? [] : ajvIssues(validateManifestSchema.errors)
  if (!valid) return { ok: false, issues }

  const manifest = value as AndocManifest
  const paths = new Set<string>()
  manifest.entries.forEach((entry, index) => {
    if (paths.has(entry.path)) {
      issues.push({ code: 'duplicate_manifest_path', path: `/entries/${index}/path`, message: `Duplicate package path: ${entry.path}` })
    }
    paths.add(entry.path)
  })
  return { ok: issues.length === 0, issues, manifest }
}

export function validateTransaction(value: unknown): { ok: boolean; issues: ValidationIssue[]; transaction?: AndocTransaction } {
  const valid = validateTransactionSchema(value)
  const issues = valid ? [] : ajvIssues(validateTransactionSchema.errors)
  if (!valid) return { ok: false, issues }
  const transaction = value as AndocTransaction
  transaction.operations.forEach((operation, index) => {
    if (operation.op !== 'updateChartData') return
    chartDataIssues(operation.data).forEach(message => issues.push({ code: 'invalid_chart_data', path: `/operations/${index}/data`, message }))
  })
  return { ok: issues.length === 0, issues, ...(issues.length ? {} : { transaction }) }
}

export function validateProfiles(value: unknown): { ok: boolean; issues: ValidationIssue[]; profiles?: AndocProfiles } {
  const valid = validateProfilesSchema(value)
  const issues = valid ? [] : ajvIssues(validateProfilesSchema.errors)
  if (!valid) return { ok: false, issues }
  const profiles = value as AndocProfiles
  issues.push(...profileSemanticIssues(profiles))
  return { ok: issues.length === 0, issues, ...(issues.length ? {} : { profiles }) }
}

export function validateFinalization(value: unknown): { ok: boolean; issues: ValidationIssue[]; finalization?: AndocFinalization } {
  const valid = validateFinalizationSchema(value)
  const issues = valid ? [] : ajvIssues(validateFinalizationSchema.errors)
  if (!valid) return { ok: false, issues }
  const finalization = value as AndocFinalization
  const keys = new Set<string>()
  finalization.signatures.forEach((signature, index) => {
    if (keys.has(signature.keyId)) {
      issues.push({ code: 'duplicate_finalization_key', path: `/signatures/${index}/keyId`, message: `Duplicate finalization key: ${signature.keyId}` })
    }
    keys.add(signature.keyId)
  })
  return { ok: issues.length === 0, issues, ...(issues.length ? {} : { finalization }) }
}

export function validateLineage(value: unknown): { ok: boolean; issues: ValidationIssue[]; lineage?: AndocLineage } {
  const valid = validateLineageSchema(value)
  const issues = valid ? [] : ajvIssues(validateLineageSchema.errors)
  if (!valid) return { ok: false, issues }
  return { ok: true, issues, lineage: value as AndocLineage }
}

export function validateSourceBaselines(value: unknown): { ok: boolean; issues: ValidationIssue[]; sourceBaselines?: AnxSourceBaselines } {
  const valid = validateSourceBaselinesSchema(value)
  const issues = valid ? [] : ajvIssues(validateSourceBaselinesSchema.errors)
  if (!valid) return { ok: false, issues }
  const sourceBaselines = value as AnxSourceBaselines
  const ids = new Set<string>()
  sourceBaselines.records.forEach((record, index) => {
    if (ids.has(record.id)) {
      issues.push({ code: 'duplicate_source_baseline_id', path: `/records/${index}/id`, message: `Duplicate source baseline id: ${record.id}` })
    }
    ids.add(record.id)
  })
  if (!ids.has(sourceBaselines.activeBaselineId)) {
    issues.push({ code: 'missing_active_source_baseline', path: '/activeBaselineId', message: 'The active source baseline ID must resolve to a retained record' })
  }
  return { ok: issues.length === 0, issues, ...(issues.length ? {} : { sourceBaselines }) }
}

function blockAssetIds(block: AndocDocument['blocks'][number]): string[] {
  if (block.type === 'image') return [block.assetId]
  if (block.type === 'chart') return [block.dataAssetId, block.fallbackAssetId].filter((id): id is string => Boolean(id))
  return []
}

function ajvIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors || []).map(error => ({
    code: `schema_${error.keyword}`,
    path: error.instancePath || '/',
    message: error.message || 'Schema validation failed',
  }))
}

function permissiveFormats(): Record<string, true | RegExp> {
  return {
    'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
    'uri-reference': true,
  }
}
