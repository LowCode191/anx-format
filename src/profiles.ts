import {
  ANDOC_PROFILES_SCHEMA,
  type AndocCapabilityReference,
  type AndocProfiles,
  type AndocTemplateReference,
  type ValidationIssue,
} from './types.js'

export interface AndocCapabilityDefinition {
  id: string
  version: string
  kind: 'profile' | 'extension'
  title: string
  description: string
  requires: string[]
}

export interface CreateProfilesOptions {
  profiles?: string[]
  extensions?: string[]
  template?: AndocTemplateReference
}

export const ANDOC_CORE_PROFILE_ID = 'andoc.profile.core-document'
export const ANDOC_SIGNATURE_EXTENSION_ID = 'andoc.extension.signatures'

export const ANDOC_CAPABILITIES: readonly AndocCapabilityDefinition[] = [
  {
    id: ANDOC_CORE_PROFILE_ID,
    version: '1.0',
    kind: 'profile',
    title: 'Core Document',
    description: 'Canonical blocks, assets, revisions, transactions, provenance, and deterministic human projections.',
    requires: [],
  },
  {
    id: 'andoc.profile.research-report',
    version: '1.0',
    kind: 'profile',
    title: 'Research Report',
    description: 'Evidence-bearing research documents with registered sources, claims, and stable citations.',
    requires: ['andoc.extension.citations-evidence'],
  },
  {
    id: 'andoc.profile.financial-report',
    version: '1.0',
    kind: 'profile',
    title: 'Financial Report',
    description: 'Period-aware financial documents with typed currencies, units, metrics, and calculation provenance.',
    requires: ['andoc.extension.typed-values'],
  },
  {
    id: 'andoc.profile.controlled-document',
    version: '1.0',
    kind: 'profile',
    title: 'Controlled Document',
    description: 'Approval-controlled documents with review state, edit policy, and cryptographic finalization.',
    requires: ['andoc.extension.review', 'andoc.extension.edit-policies', ANDOC_SIGNATURE_EXTENSION_ID],
  },
  {
    id: 'andoc.extension.review',
    version: '1.0',
    kind: 'extension',
    title: 'Review and Comments',
    description: 'Stable review anchors, proposals, replies, resolution state, and reviewer identity.',
    requires: [],
  },
  {
    id: ANDOC_SIGNATURE_EXTENSION_ID,
    version: '1.0',
    kind: 'extension',
    title: 'Digital Signatures',
    description: 'Detached signatures over deterministic protected-entry roots and approval policies.',
    requires: [],
  },
  {
    id: 'andoc.extension.forms',
    version: '1.0',
    kind: 'extension',
    title: 'Forms',
    description: 'Typed fields, constraints, required values, and submission state.',
    requires: [],
  },
  {
    id: 'andoc.extension.citations-evidence',
    version: '1.0',
    kind: 'extension',
    title: 'Citations and Evidence',
    description: 'Claims linked to stable source evidence and revision-bound citations.',
    requires: [],
  },
  {
    id: 'andoc.extension.typed-values',
    version: '1.0',
    kind: 'extension',
    title: 'Typed Values',
    description: 'Dates, currencies, units, percentages, periods, formulas, and measured values.',
    requires: [],
  },
  {
    id: 'andoc.extension.edit-policies',
    version: '1.0',
    kind: 'extension',
    title: 'Edit Policies and Approvals',
    description: 'Protected content, role-aware edit permissions, and approval requirements.',
    requires: [],
  },
  {
    id: 'andoc.extension.trusted-timestamps',
    version: '1.0',
    kind: 'extension',
    title: 'Trusted Timestamps',
    description: 'External trusted-time receipts such as RFC 3161 tokens.',
    requires: [ANDOC_SIGNATURE_EXTENSION_ID],
  },
  {
    id: 'andoc.extension.transparency-receipts',
    version: '1.0',
    kind: 'extension',
    title: 'Transparency Receipts',
    description: 'Independent inclusion proofs from transparency logs or optional blockchain anchors.',
    requires: [ANDOC_SIGNATURE_EXTENSION_ID],
  },
] as const

const capabilities = new Map(ANDOC_CAPABILITIES.map(definition => [definition.id, definition]))

export function createProfiles(options: CreateProfilesOptions = {}): AndocProfiles {
  const profileIds = unique(options.profiles || [])
  const extensionIds = new Set(options.extensions || [])
  for (const profileId of profileIds) {
    const definition = capabilities.get(profileId)
    if (!definition || definition.kind !== 'profile' || profileId === ANDOC_CORE_PROFILE_ID) {
      throw new Error(`Unknown ANX domain profile: ${profileId}`)
    }
    addRequirements(definition, extensionIds)
  }
  for (const extensionId of [...extensionIds]) {
    const definition = capabilities.get(extensionId)
    if (!definition || definition.kind !== 'extension') throw new Error(`Unknown ANX extension: ${extensionId}`)
    addRequirements(definition, extensionIds)
  }
  return {
    schema: ANDOC_PROFILES_SCHEMA,
    core: reference(ANDOC_CORE_PROFILE_ID),
    profiles: profileIds.map(reference),
    extensions: [...extensionIds].sort().map(reference),
    ...(options.template ? { template: options.template } : {}),
  }
}

export function withRequiredExtension(profiles: AndocProfiles | undefined, extensionId: string): AndocProfiles {
  const base = profiles || createProfiles()
  const extensionIds = new Set(base.extensions.map(extension => extension.id))
  extensionIds.add(extensionId)
  const result = createProfiles({
    profiles: base.profiles.map(profile => profile.id),
    extensions: [...extensionIds],
    ...(base.template ? { template: base.template } : {}),
  })
  const customOptional = base.extensions.filter(extension => !capabilities.has(extension.id) && !extension.required)
  result.extensions.push(...customOptional)
  result.extensions.sort((left, right) => left.id.localeCompare(right.id))
  return result
}

export function profileSemanticIssues(value: AndocProfiles): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (value.core.id !== ANDOC_CORE_PROFILE_ID || value.core.version !== '1.0' || !value.core.required) {
    issues.push({ code: 'invalid_core_profile', path: '/core', message: `Core profile must be ${ANDOC_CORE_PROFILE_ID}@1.0 and required` })
  }
  const references = [value.core, ...value.profiles, ...value.extensions]
  const seen = new Set<string>()
  references.forEach((item, index) => {
    const key = `${item.id}@${item.version}`
    if (seen.has(key)) issues.push({ code: 'duplicate_capability', path: `/capabilities/${index}`, message: `Duplicate capability: ${key}` })
    seen.add(key)
    const definition = capabilities.get(item.id)
    if (definition && definition.version !== item.version) {
      issues.push({ code: 'unsupported_capability_version', path: `/capabilities/${index}/version`, message: `Supported version for ${item.id} is ${definition.version}` })
    } else if (!definition && item.required) {
      issues.push({ code: 'unsupported_required_capability', path: `/capabilities/${index}`, message: `Required capability is not supported: ${key}` })
    }
  })
  value.profiles.forEach((item, index) => {
    const definition = capabilities.get(item.id)
    if (definition?.kind !== 'profile') issues.push({ code: 'invalid_profile_kind', path: `/profiles/${index}`, message: `${item.id} is not a domain profile` })
  })
  value.extensions.forEach((item, index) => {
    const definition = capabilities.get(item.id)
    if (definition && definition.kind !== 'extension') issues.push({ code: 'invalid_extension_kind', path: `/extensions/${index}`, message: `${item.id} is not an extension` })
  })
  const declared = new Set(references.map(item => item.id))
  for (const item of references) {
    const definition = capabilities.get(item.id)
    for (const requirement of definition?.requires || []) {
      if (!declared.has(requirement)) issues.push({ code: 'missing_capability_dependency', path: '/', message: `${item.id} requires ${requirement}` })
    }
  }
  return issues
}

export function inspectProfiles(value?: AndocProfiles): Record<string, unknown> {
  const declaration = value || createProfiles()
  const issues = profileSemanticIssues(declaration)
  return {
    schema: declaration.schema,
    legacyDefault: !value,
    core: describe(declaration.core),
    profiles: declaration.profiles.map(describe),
    extensions: declaration.extensions.map(describe),
    ...(declaration.template ? { template: declaration.template } : {}),
    supported: issues.length === 0,
    issues,
  }
}

function reference(id: string): AndocCapabilityReference {
  const definition = capabilities.get(id)
  if (!definition) throw new Error(`Unknown ANX capability: ${id}`)
  return { id, version: definition.version, required: true }
}

function describe(item: AndocCapabilityReference): Record<string, unknown> {
  const definition = capabilities.get(item.id)
  return {
    ...item,
    supported: Boolean(definition && definition.version === item.version),
    ...(definition ? { kind: definition.kind, title: definition.title, description: definition.description } : {}),
  }
}

function addRequirements(definition: AndocCapabilityDefinition, target: Set<string>): void {
  for (const requirement of definition.requires) {
    if (target.has(requirement)) continue
    target.add(requirement)
    const requiredDefinition = capabilities.get(requirement)
    if (requiredDefinition) addRequirements(requiredDefinition, target)
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
