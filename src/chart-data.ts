import type { ChartDataEvidence, StructuredChartData } from './types.js'

export function isStructuredChartData(value: unknown): value is StructuredChartData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.columns) || !candidate.columns.length || !candidate.columns.every(column => typeof column === 'string' && column.trim())) return false
  if (!Array.isArray(candidate.rows)) return false
  return candidate.rows.every(row => Array.isArray(row) && row.every(cell => cell === null || typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell))))
}

export function chartDataIssues(data: StructuredChartData): string[] {
  const issues: string[] = []
  if (new Set(data.columns).size !== data.columns.length) issues.push('Chart data columns must be unique')
  data.rows.forEach((row, index) => {
    if (row.length !== data.columns.length) issues.push(`Chart data row ${index} has ${row.length} values; expected ${data.columns.length}`)
  })
  return issues
}

export function structuredChartDataFromSpec(spec: Record<string, unknown>): StructuredChartData | null {
  if (spec.schema !== 'andoc.chart.v1' || !isStructuredChartData(spec.data)) return null
  return chartDataIssues(spec.data).length ? null : spec.data
}

export function chartDataEvidenceFromSpec(spec: Record<string, unknown>): ChartDataEvidence | null {
  const extraction = spec.extraction
  if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) return null
  const value = extraction as Record<string, unknown>
  const method = value.method
  if (!['imported', 'human-provided', 'agent-provided', 'local-extraction'].includes(String(method))) return null
  if (typeof value.source !== 'string' || !value.source.trim() || typeof value.verified !== 'boolean') return null
  return {
    method: method as ChartDataEvidence['method'],
    source: value.source,
    verified: value.verified,
    ...(typeof value.confidence === 'number' ? { confidence: value.confidence } : {}),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
  }
}
