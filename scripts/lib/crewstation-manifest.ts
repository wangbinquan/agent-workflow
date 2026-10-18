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
  readonly eventSourcesDefinitionId?: string
  readonly gitCredentialsDefinitionId?: string
  /** Optional `AW_DATABASE_POOL_MAX` configuration (1–256); absent or empty keeps the hosted default. */
  readonly databasePoolMaxDefinitionId?: string
  readonly eventTypeIds?: readonly string[]
  readonly agentProfilesDefinitionId: string
  readonly taskProfileId: string
  readonly taskRuntimeImageVersionId: string
  readonly objectStoragePlanId: string
  readonly agentProfiles: readonly {
    readonly id: string
    readonly name: string
    readonly compute: { readonly kind: 'profile'; readonly profileId: string }
    readonly businessConfig: {
      readonly allowedEnvNames: readonly string[]
      readonly allowSystemPromptAppend: true
      readonly allowSkills: true
      readonly nativeConfig: {
        readonly agentDefinitions: true
        readonly inlineRemoteMcp: true
        readonly inlineLocalMcp: true
        readonly plugins: true
      }
    }
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
      businessConfig: {
        allowedEnvNames: [
          'GIT_CONFIG_PARAMETERS',
          ...(record.gitCredentialsDefinitionId === undefined
            ? []
            : [
                'AW_GIT_RUNTIME_BINDINGS',
                ...Array.from({ length: 32 }, (_, index) => `AW_GIT_AUTH_${index}`),
                'GIT_SSH_COMMAND',
                'GIT_SSH_VARIANT',
                'GIT_TERMINAL_PROMPT',
                'GIT_TRACE',
                'GIT_TRACE_CURL',
                'GIT_CURL_VERBOSE',
                'GIT_TRACE_PACKET',
                'GIT_TRACE_REDACT',
              ]),
        ],
        allowSystemPromptAppend: true as const,
        allowSkills: true as const,
        nativeConfig: {
          agentDefinitions: true as const,
          inlineRemoteMcp: true as const,
          inlineLocalMcp: true as const,
          plugins: true as const,
        },
      },
    }
  })
  if (new Set(agentProfiles.map((agent) => agent.id)).size !== agentProfiles.length)
    throw new Error('profile.agentProfiles has duplicate ids')
  const eventTypeIds = record.eventTypeIds ?? []
  if (
    !Array.isArray(eventTypeIds) ||
    eventTypeIds.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
    new Set(eventTypeIds).size !== eventTypeIds.length
  )
    throw new Error('profile.eventTypeIds must contain unique event UUIDs')
  const eventSourcesDefinitionId = record.eventSourcesDefinitionId
  if (
    eventSourcesDefinitionId !== undefined &&
    (typeof eventSourcesDefinitionId !== 'string' || !UUID.test(eventSourcesDefinitionId))
  )
    throw new Error('profile.eventSourcesDefinitionId must be a resource UUID')
  if (eventTypeIds.length > 0 !== (eventSourcesDefinitionId !== undefined))
    throw new Error('event subscriptions require both eventTypeIds and eventSourcesDefinitionId')
  // RFC-370 v3 V5: database restores are started by the platform (CS RFC-042)
  // and reach `agent-workflow migrate` as CS_DATABASE_RESTORE_REFERENCE.
  if (record.restoreObjectDefinitionId !== undefined)
    throw new Error(
      'profile.restoreObjectDefinitionId is no longer supported: start a database restore from the CrewStation release page',
    )
  // RFC-370 v3 V4: a recovery request is admitted as its requesting platform
  // user's AW account; there is no separate service recovery identity.
  if (record.recoveryIdentityDefinitionId !== undefined)
    throw new Error(
      'profile.recoveryIdentityDefinitionId is no longer supported: recovery requests act as the requesting CrewStation user',
    )
  const gitCredentialsDefinitionId = record.gitCredentialsDefinitionId
  if (
    gitCredentialsDefinitionId !== undefined &&
    (typeof gitCredentialsDefinitionId !== 'string' || !UUID.test(gitCredentialsDefinitionId))
  )
    throw new Error('profile.gitCredentialsDefinitionId must be a resource UUID')
  const databasePoolMaxDefinitionId = record.databasePoolMaxDefinitionId
  if (
    databasePoolMaxDefinitionId !== undefined &&
    (typeof databasePoolMaxDefinitionId !== 'string' || !UUID.test(databasePoolMaxDefinitionId))
  )
    throw new Error('profile.databasePoolMaxDefinitionId must be a resource UUID')
  return {
    ...profile,
    agentProfiles,
    eventTypeIds,
    ...(typeof eventSourcesDefinitionId === 'string' ? { eventSourcesDefinitionId } : {}),
    ...(typeof gitCredentialsDefinitionId === 'string' ? { gitCredentialsDefinitionId } : {}),
    ...(typeof databasePoolMaxDefinitionId === 'string' ? { databasePoolMaxDefinitionId } : {}),
  }
}

/** Every placeholder must be filled and no unknown placeholder may remain. */
export function renderCrewStationManifest(
  template: string,
  profile: CrewStationDeploymentProfile,
): string {
  const rendered = template.replace(/\{\s*\{\s*([A-Z_]+)\s*\}\s*\}/g, (match, name: string) => {
    if (name === 'SERVICE_COMMAND_JSON')
      return JSON.stringify(
        (profile.eventTypeIds?.length ?? 0) > 0
          ? [
              '/usr/bin/env',
              `AW_EVENT_TYPE_IDS=${JSON.stringify(profile.eventTypeIds)}`,
              'agent-workflow',
              'start',
            ]
          : ['agent-workflow', 'start'],
      )
    if (name === 'AGENT_PROFILES_JSON') return JSON.stringify(profile.agentProfiles)
    if (name === 'RECOVERY_DECLARATION')
      // RFC-370 §9.2 V4: parent-level actions only; node retry/resume is AW's
      // own task command and a fresh volume is AW's ordinary "rerun task".
      return 'recovery: ' + JSON.stringify({ actions: ['resume-task', 'rebuild-workspace'] })
    if (name === 'COMMAND_BUSINESS_CONFIG_JSON')
      return JSON.stringify({
        allowedEnvNames:
          profile.gitCredentialsDefinitionId === undefined
            ? []
            : [
                'AW_GIT_RUNTIME_BINDINGS',
                ...Array.from({ length: 32 }, (_, index) => `AW_GIT_AUTH_${index}`),
              ],
      })
    if (name === 'EVENT_SUBSCRIPTIONS_JSON')
      return JSON.stringify(
        (profile.eventTypeIds ?? []).map((eventTypeId) => ({
          eventTypeId,
          handlerPath: '/integrations/crewstation/events',
        })),
      )
    if (name === 'ENV_JSON')
      return JSON.stringify([
        {
          name: 'AW_AGENT_PROFILES',
          from: 'config',
          configDefinitionId: profile.agentProfilesDefinitionId,
        },
        {
          name: 'AW_SECRET_KEY',
          from: 'secret',
          configDefinitionId: profile.secretKeyDefinitionId,
        },
        {
          name: 'AW_ADMIN_SUBJECTS',
          from: 'config',
          configDefinitionId: profile.adminSubjectsDefinitionId,
          default: '',
        },
        ...(profile.gitCredentialsDefinitionId === undefined
          ? []
          : [
              {
                name: 'AW_GIT_CREDENTIAL_BINDINGS',
                from: 'config',
                configDefinitionId: profile.gitCredentialsDefinitionId,
              },
            ]),
        ...(profile.eventSourcesDefinitionId === undefined
          ? []
          : [
              {
                name: 'AW_EVENT_SOURCES',
                from: 'config',
                configDefinitionId: profile.eventSourcesDefinitionId,
              },
            ]),
        // The platform injects only declared entries into the service slot, so
        // the pool size reaches AW only through this declaration (an unset
        // value keeps the hosted default of 8).
        ...(profile.databasePoolMaxDefinitionId === undefined
          ? []
          : [
              {
                name: 'AW_DATABASE_POOL_MAX',
                from: 'config',
                configDefinitionId: profile.databasePoolMaxDefinitionId,
                default: '',
              },
            ]),
      ])

    if (!(name in PLACEHOLDERS)) throw new Error(`unknown manifest placeholder ${match}`)
    return profile[PLACEHOLDERS[name as keyof typeof PLACEHOLDERS]]
  })
  return rendered
}
