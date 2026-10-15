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
}

const PLACEHOLDERS = {
  SERVICE_PLAN_ID: 'servicePlanId',
  SECRET_KEY_DEFINITION_ID: 'secretKeyDefinitionId',
  ADMIN_SUBJECTS_DEFINITION_ID: 'adminSubjectsDefinitionId',
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
  }
  for (const key of Object.values(PLACEHOLDERS)) {
    if (!UUID.test(profile[key])) throw new Error(`profile.${key} must be a resource UUID`)
  }
  return profile
}

/** Every placeholder must be filled and no unknown placeholder may remain. */
export function renderCrewStationManifest(
  template: string,
  profile: CrewStationDeploymentProfile,
): string {
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => {
    if (!(name in PLACEHOLDERS)) throw new Error(`unknown manifest placeholder ${match}`)
    return profile[PLACEHOLDERS[name as keyof typeof PLACEHOLDERS]]
  })
  return rendered
}
