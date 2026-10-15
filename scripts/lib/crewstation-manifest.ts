// RFC-370 M0 — render the CrewStation Manifest template from a deployment profile.
// The template is checked in; plan and configuration ids are project-specific and
// stay in the operator's local profile.

export interface CrewStationDeploymentProfile {
  /** CrewStation project slug (one service per project, named after it). */
  readonly project: string
  /** Push URL of the CrewStation project repository. */
  readonly repository: string
  readonly branch: string
  readonly servicePlanId: string
  readonly secretKeyDefinitionId: string
  readonly adminSubjectsDefinitionId: string
  readonly agentProfilesDefinitionId: string
  readonly taskProfileId: string
  readonly taskRuntimeImageVersionId: string
  readonly objectStoragePlanId: string
  readonly agentProfiles: readonly {
    readonly id: string
    readonly name: string
    readonly compute: { readonly kind: 'profile'; readonly profileId: string }
    readonly businessConfig: { readonly allowSystemPromptAppend: true; readonly allowSkills: true }
  }[]
}

const PLACEHOLDERS = {
  SERVICE_PLAN_ID: 'servicePlanId',
  SECRET_KEY_DEFINITION_ID: 'secretKeyDefinitionId',
  ADMIN_SUBJECTS_DEFINITION_ID: 'adminSubjectsDefinitionId',
  AGENT_PROFILES_DEFINITION_ID: 'agentProfilesDefinitionId',
  TASK_PROFILE_ID: 'taskProfileId',
  TASK_RUNTIME_IMAGE_VERSION_ID: 'taskRuntimeImageVersionId',
  OBJECT_STORAGE_PLAN_ID: 'objectStoragePlanId',
} as const satisfies Record<string, keyof CrewStationDeploymentProfile>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseDeploymentProfile(raw: unknown): CrewStationDeploymentProfile {
  if (typeof raw !== 'object' || raw === null) throw new Error('profile must be a JSON object')
  const record = raw as Record<string, unknown>
  const text = (key: keyof CrewStationDeploymentProfile): string => {
    const value = record[key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`profile.${key} is required`)
    }
    return value.trim()
  }
  const profile = {
    project: text('project'),
    repository: text('repository'),
    branch: text('branch'),
    servicePlanId: text('servicePlanId'),
    secretKeyDefinitionId: text('secretKeyDefinitionId'),
    adminSubjectsDefinitionId: text('adminSubjectsDefinitionId'),
    agentProfilesDefinitionId: text('agentProfilesDefinitionId'),
    taskProfileId: text('taskProfileId'),
    taskRuntimeImageVersionId: text('taskRuntimeImageVersionId'),
    objectStoragePlanId: text('objectStoragePlanId'),
  }
  for (const key of Object.values(PLACEHOLDERS)) {
    if (!UUID.test(profile[key])) throw new Error(`profile.${key} must be a resource UUID`)
  }
  if (!Array.isArray(record.agentProfiles) || record.agentProfiles.length === 0)
    throw new Error('profile.agentProfiles is required')
  const agentProfiles = record.agentProfiles.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object')
      throw new Error('profile.agentProfiles entry must be an object')
    const agent = entry as Record<string, unknown>
    const compute = agent.compute as { kind?: unknown; profileId?: unknown } | undefined
    if (
      typeof agent.id !== 'string' ||
      !UUID.test(agent.id) ||
      typeof agent.name !== 'string' ||
      agent.name.length === 0 ||
      agent.name.length > 80 ||
      compute?.kind !== 'profile' ||
      typeof compute.profileId !== 'string' ||
      !UUID.test(compute.profileId)
    ) {
      throw new Error(
        'profile.agentProfiles requires id, name and an explicit compute profile UUID',
      )
    }
    return {
      id: agent.id,
      name: agent.name,
      compute: { kind: 'profile' as const, profileId: compute.profileId },
      businessConfig: { allowSystemPromptAppend: true as const, allowSkills: true as const },
    }
  })
  if (new Set(agentProfiles.map((agent) => agent.id)).size !== agentProfiles.length)
    throw new Error('profile.agentProfiles has duplicate ids')
  return { ...profile, agentProfiles }
}

/** Every placeholder must be filled and no unknown placeholder may remain. */
export function renderCrewStationManifest(
  template: string,
  profile: CrewStationDeploymentProfile,
): string {
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => {
    if (name === 'AGENT_PROFILES_JSON') return JSON.stringify(profile.agentProfiles)
    if (!(name in PLACEHOLDERS)) throw new Error(`unknown manifest placeholder ${match}`)
    return profile[PLACEHOLDERS[name as keyof typeof PLACEHOLDERS]]
  })
  return rendered
}
