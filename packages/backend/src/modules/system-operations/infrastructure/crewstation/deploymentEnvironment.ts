// RFC-519 — the CrewStation deployment environment (RFC-294 S10): the service identity, platform endpoints, database and secret
// read from the process environment, with every problem reported at once.
// RFC-370 M0 — system-operations selections of a CrewStation-hosted instance.
// The platform injects every input through environment variables; a missing
// input refuses to start and names all of them at once. Bootstrap passes the
// returned selections to the one shared start sequence.
import { CREWSTATION_PLATFORM_API_URL_ENV } from '@/platform/crewstation/platformApi'

export const CREWSTATION_DATABASE_URL_ENV = 'CS_DATABASE_URL'

/** aw's task execution contract (Manifest `tasks.acceptedTaskContractVersions`).
 * Bump when a release can no longer take over another release's running tasks. */
export const HOSTED_TASK_CONTRACT_VERSION = 'aw-task-v1'

export interface CrewStationDeploymentEnvironment {
  readonly project: string
  readonly service: string
  readonly port: number
  readonly jwksUrl: string
  /** The service-domain platform API (`CS_PLATFORM_API_URL`). */
  readonly platformApiUrl: string
  /** Present once the Manifest declares `spec.data.objects` (not needed by M0). */
  readonly objectsUrl: string | null
  readonly objectSpaceId: string | null
  /** The service domain (`CS_SERVICE_DOMAIN`): names this service as a platform caller's target. */
  readonly serviceDomain: string | null
  readonly secretKey: Buffer
  /** CrewStation user subjects (`user:<uuid>`) that become administrators on first access. */
  readonly adminSubjects: readonly string[]
}

export class CrewStationEnvironmentError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`CrewStation deployment environment is incomplete:\n  - ${problems.join('\n  - ')}`)
    this.name = 'CrewStationEnvironmentError'
  }
}

const SUBJECT_PREFIX = 'user:'

/** Accept `user:<id>` or a bare id; whitespace and empty entries are ignored. */
function parseAdminSubjects(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => (entry.startsWith(SUBJECT_PREFIX) ? entry : `${SUBJECT_PREFIX}${entry}`)),
    ),
  ]
}

function requiredReader(env: Readonly<Record<string, string | undefined>>) {
  const problems: string[] = []
  const required = (name: string): string => {
    const value = env[name]?.trim() ?? ''
    if (value.length === 0) problems.push(`${name} is required`)
    return value
  }
  return { problems, required }
}

/** The release migration Job only needs the service identity and its database. */
export function readCrewStationDatabaseEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Pick<CrewStationDeploymentEnvironment, 'project' | 'service'> {
  const { problems, required } = requiredReader(env)
  const project = required('CS_PROJECT')
  const service = required('CS_SERVICE')
  required(CREWSTATION_DATABASE_URL_ENV)
  if (problems.length > 0) throw new CrewStationEnvironmentError(problems)
  return Object.freeze({ project, service })
}

export function readCrewStationEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): CrewStationDeploymentEnvironment {
  const { problems, required } = requiredReader(env)
  const project = required('CS_PROJECT')
  const service = required('CS_SERVICE')
  required(CREWSTATION_DATABASE_URL_ENV)
  const jwksUrl = required('CS_JWKS_URL')
  const platformApiUrl = required(CREWSTATION_PLATFORM_API_URL_ENV)
  const objectsUrl = env.CS_OBJECTS_URL?.trim() ?? ''
  const portText = required('PORT')
  const port = Number(portText)
  if (portText.length > 0 && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    problems.push(`PORT must be a TCP port number, got ${JSON.stringify(portText)}`)
  }
  for (const [name, value] of [
    ['CS_JWKS_URL', jwksUrl],
    [CREWSTATION_PLATFORM_API_URL_ENV, platformApiUrl],
    ['CS_OBJECTS_URL', objectsUrl],
  ] as const) {
    if (value.length > 0 && !URL.canParse(value)) problems.push(`${name} must be an absolute URL`)
  }
  const keyText = required('AW_SECRET_KEY')
  const secretKey = Buffer.from(keyText, 'base64')
  if (keyText.length > 0 && secretKey.length !== 32) {
    problems.push(
      'AW_SECRET_KEY must be 32 random bytes encoded as base64 (for example `openssl rand -base64 32`)',
    )
  }
  if (problems.length > 0) throw new CrewStationEnvironmentError(problems)
  const objectSpaceId = env.CS_OBJECT_SPACE_ID?.trim() ?? ''
  const serviceDomain = env.CS_SERVICE_DOMAIN?.trim() ?? ''
  return Object.freeze({
    project,
    service,
    port,
    jwksUrl,
    platformApiUrl,
    objectsUrl: objectsUrl.length > 0 ? objectsUrl : null,
    objectSpaceId: objectSpaceId.length > 0 ? objectSpaceId : null,
    serviceDomain: serviceDomain.length > 0 ? serviceDomain : null,
    secretKey,
    adminSubjects: Object.freeze(parseAdminSubjects(env.AW_ADMIN_SUBJECTS)),
  })
}
