export const ANX_EVIDENCE_TOOL_NAMES = [
  'anx_search',
  'anx_table_evidence',
  'anx_page_evidence',
  'anx_relationships',
  'anx_cite',
] as const

export type AnxEvidenceToolName = typeof ANX_EVIDENCE_TOOL_NAMES[number]
export type AnxEvidenceToolProfile = 'full' | 'table-answer'

const profileTools: Record<AnxEvidenceToolProfile, readonly AnxEvidenceToolName[]> = {
  full: ANX_EVIDENCE_TOOL_NAMES,
  'table-answer': ['anx_table_evidence'],
}

export function configuredAnxEvidenceToolProfile(
  value = process.env.ANX_MCP_TOOL_PROFILE,
): AnxEvidenceToolProfile {
  const profile = value?.trim() || 'full'
  if (profile !== 'full' && profile !== 'table-answer') {
    throw new Error(
      `ANX_MCP_TOOL_PROFILE_INVALID: expected "full" or "table-answer", received ${JSON.stringify(profile)}`,
    )
  }
  return profile
}

export function anxEvidenceToolsForProfile(
  profile: AnxEvidenceToolProfile,
): readonly AnxEvidenceToolName[] {
  return profileTools[profile]
}

export function anxEvidenceToolEnabled(
  profile: AnxEvidenceToolProfile,
  tool: AnxEvidenceToolName,
): boolean {
  return profileTools[profile].includes(tool)
}
