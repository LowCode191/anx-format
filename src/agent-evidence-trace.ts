import { appendFile, readFile } from 'node:fs/promises'

export const ANX_AGENT_EVIDENCE_TRACE_SCHEMA = 'anx.agent-evidence-trace.v1' as const

export interface AnxAgentEvidenceTraceRecord {
  schema: typeof ANX_AGENT_EVIDENCE_TRACE_SCHEMA
  tool: string
  citations: string[]
}

export function collectAnxEvidenceCitations(value: unknown): string[] {
  const citations: string[] = []
  const visit = (candidate: unknown, key = ''): void => {
    if (typeof candidate === 'string') {
      if ((key === 'citation' || key === 'uri') && candidate.startsWith('anx://')) {
        citations.push(candidate)
      }
      return
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, key)
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [childKey, child] of Object.entries(candidate as Record<string, unknown>)) {
      visit(child, childKey)
    }
  }
  visit(value)
  return [...new Set(citations)]
}

export async function appendAnxEvidenceTrace(
  tracePath: string | undefined,
  tool: string,
  result: unknown,
): Promise<void> {
  if (!tracePath) return
  const record: AnxAgentEvidenceTraceRecord = {
    schema: ANX_AGENT_EVIDENCE_TRACE_SCHEMA,
    tool,
    citations: collectAnxEvidenceCitations(result),
  }
  await appendFile(tracePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function readAnxEvidenceTrace(tracePath: string): Promise<AnxAgentEvidenceTraceRecord[]> {
  const content = await readFile(tracePath, 'utf8').catch(() => '')
  return content.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return []
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`ANX_AGENT_EVIDENCE_TRACE_INVALID: line ${index + 1} is not JSON`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`ANX_AGENT_EVIDENCE_TRACE_INVALID: line ${index + 1} must be an object`)
    }
    const record = value as Record<string, unknown>
    if (
      record.schema !== ANX_AGENT_EVIDENCE_TRACE_SCHEMA
      || typeof record.tool !== 'string'
      || !Array.isArray(record.citations)
      || !record.citations.every(citation => typeof citation === 'string' && citation.startsWith('anx://'))
    ) {
      throw new Error(`ANX_AGENT_EVIDENCE_TRACE_INVALID: line ${index + 1} failed its contract`)
    }
    return [record as unknown as AnxAgentEvidenceTraceRecord]
  })
}

export function citationsFromAnxEvidenceTrace(records: AnxAgentEvidenceTraceRecord[]): string[] {
  return [...new Set(records.flatMap(record => record.citations))]
}
