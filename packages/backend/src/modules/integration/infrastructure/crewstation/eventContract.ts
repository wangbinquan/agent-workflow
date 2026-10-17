// RFC-370 H8 / v3 V8 — the CrewStation side of hosted event ingress: the
// delivery envelope (CS contracts `EventDeliverySchema`), the deployment's
// event-source configuration (`AW_EVENT_SOURCES`), CrewStation's exact
// code-host producer catalog, and the translation of a frozen envelope into
// AW's provider normalization (which stays pure in `domain/`).
//
// The envelope is parsed leniently: CrewStation may add fields, and an unknown
// field is ignored rather than dead-lettering every event; every field AW
// routes, deduplicates or audits is still validated. The configuration is the
// operator's, so it stays strict and a typo fails at startup.
import { z } from 'zod'
import type { CodeHostEventType } from '@agent-workflow/shared'
import { DomainError } from '@/util/errors'
import type { NormalizeResult } from '../../domain/codeHostNormalization'
import { githubNormalize } from '../../domain/githubNormalization'
import { gitlabNormalize } from '../../domain/gitlabNormalization'
import type {
  CrewStationEventRoute,
  CrewStationInboundDelivery,
} from '../../application/ports/crewStationEventInbox'
import { sha256Hex } from '@/util/hash'

/** The transport receipt of a delivery fact admitted from a frozen CrewStation target. */
export const CREWSTATION_TARGET_RECEIPT_PREFIX = 'cs-event-target:'

/** A delivery the transport refuses; CrewStation retries it, then dead-letters it. */
export class CrewStationEventError extends DomainError {
  constructor(status: 400 | 401 | 413 | 422, code: string) {
    super(code, code, status)
    this.name = 'CrewStationEventError'
  }
}

const ResourceId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

/** Unknown fields are ignored (zod's default), here and in `source`. */
export const CrewStationEventDeliverySchema = z.object({
  deliveryId: ResourceId,
  eventId: ResourceId,
  eventTypeId: ResourceId,
  eventType: z.string().min(1),
  source: z.object({
    producerId: ResourceId,
    producer: z.string().min(1),
    project: z.string().min(1),
  }),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  attempt: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
})
export type CrewStationEventDelivery = z.infer<typeof CrewStationEventDeliverySchema>

const Repository = z
  .string()
  .regex(/^[\w.-]+(?:\/[\w.-]+)+$/)
  .refine((v) => !v.split('/').some((p) => p === '.' || p === '..'))

/**
 * `AW_EVENT_SOURCES`: per producer, the approved code host and repositories,
 * the subscribed catalog types, and the endpoints each repository routes to.
 * A binding's `mode` is its channel: `crewstation` admits events, `shadow` only
 * records what would have been admitted.
 */
export const CrewStationEventSourcesSchema = z.array(
  z
    .object({
      producerId: ResourceId,
      producer: z.enum(['gitlab', 'github']),
      project: z.string().min(1),
      revision: z.number().int().positive(),
      instanceUrl: z.string().url(),
      apiBaseUrl: z.string().url(),
      sshOrigins: z.array(z.string().url()).min(1).optional(),
      repositories: z.array(Repository).min(1),
      eventTypes: z.array(z.object({ id: ResourceId, name: z.string() }).strict()).min(1),
      bindings: z.array(
        z
          .object({
            endpointId: z.string().min(1),
            revision: z.number().int().positive(),
            repositories: z.array(Repository).min(1),
            mode: z.enum(['crewstation', 'shadow']),
          })
          .strict(),
      ),
    })
    .strict(),
)
export type CrewStationEventSource = z.infer<typeof CrewStationEventSourcesSchema>[number]

/** The manifest renderer injects the subscribed ids independently from the
 * mutable source configuration. A missing or extra binding fails before DB
 * startup instead of silently leaving an event family undeliverable. */
export function validateCrewStationEventSubscriptions(
  sources: readonly CrewStationEventSource[],
  value: unknown,
): void {
  const ids = z.array(ResourceId).parse(value)
  const configured = new Set(sources.flatMap((source) => source.eventTypes.map((type) => type.id)))
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== configured.size ||
    ids.some((id) => !configured.has(id))
  )
    throw new Error('AW_EVENT_SOURCES does not match the manifest event subscriptions')
}

// Exhaustive produces from CS RFC-033's two manifests (26 GitLab + 14 GitHub).
// An empty outcomes list is an existing ignore, never an inferred new business event.
type Mapping = { header: string; outcomes: readonly CodeHostEventType[] }
// A named outcome keeps RFC-321's literal Git-command scanner exact: a code-host
// push event is not a `git push` invocation.
const PUSH_EVENT: CodeHostEventType = 'push'
export const CREWSTATION_CODE_HOST_EVENTS: Readonly<Record<string, Mapping>> = {
  'gitlab.push': { header: 'Push Hook', outcomes: [PUSH_EVENT] },
  'gitlab.tag-push': { header: 'Tag Push Hook', outcomes: ['tag_push'] },
  'gitlab.merge-request': {
    header: 'Merge Request Hook',
    outcomes: ['mr_opened', 'mr_updated', 'mr_closed', 'mr_merged'],
  },
  'gitlab.merge-request.open': { header: 'Merge Request Hook', outcomes: ['mr_opened'] },
  'gitlab.merge-request.reopen': { header: 'Merge Request Hook', outcomes: ['mr_opened'] },
  'gitlab.merge-request.update': { header: 'Merge Request Hook', outcomes: ['mr_updated'] },
  'gitlab.merge-request.close': { header: 'Merge Request Hook', outcomes: ['mr_closed'] },
  'gitlab.merge-request.merge': { header: 'Merge Request Hook', outcomes: ['mr_merged'] },
  'gitlab.merge-request.approved': { header: 'Merge Request Hook', outcomes: [] },
  'gitlab.merge-request.unapproved': { header: 'Merge Request Hook', outcomes: [] },
  'gitlab.merge-request.comment': { header: 'Note Hook', outcomes: ['note'] },
  'gitlab.issue.comment': { header: 'Note Hook', outcomes: ['issue_comment'] },
  'gitlab.pipeline': {
    header: 'Pipeline Hook',
    outcomes: ['pipeline_failed', 'pipeline_succeeded'],
  },
  'gitlab.pipeline.created': { header: 'Pipeline Hook', outcomes: [] },
  'gitlab.pipeline.pending': { header: 'Pipeline Hook', outcomes: [] },
  'gitlab.pipeline.running': { header: 'Pipeline Hook', outcomes: [] },
  'gitlab.pipeline.success': { header: 'Pipeline Hook', outcomes: ['pipeline_succeeded'] },
  'gitlab.pipeline.failed': { header: 'Pipeline Hook', outcomes: ['pipeline_failed'] },
  'gitlab.pipeline.canceled': { header: 'Pipeline Hook', outcomes: [] },
  'gitlab.pipeline.skipped': { header: 'Pipeline Hook', outcomes: [] },
  'gitlab.pipeline.manual': { header: 'Pipeline Hook', outcomes: [] },
  'gitlab.issue': { header: 'Issue Hook', outcomes: ['issue_labeled'] },
  'gitlab.issue.open': { header: 'Issue Hook', outcomes: ['issue_labeled'] },
  'gitlab.issue.close': { header: 'Issue Hook', outcomes: ['issue_labeled'] },
  'gitlab.issue.reopen': { header: 'Issue Hook', outcomes: ['issue_labeled'] },
  'gitlab.issue.update': { header: 'Issue Hook', outcomes: ['issue_labeled'] },
  'github.push': { header: 'push', outcomes: [PUSH_EVENT] },
  'github.tag-push': { header: 'push', outcomes: ['tag_push'] },
  'github.pull-request.open': { header: 'pull_request', outcomes: ['mr_opened'] },
  'github.pull-request.reopen': { header: 'pull_request', outcomes: ['mr_opened'] },
  'github.pull-request.update': { header: 'pull_request', outcomes: ['mr_updated'] },
  'github.pull-request.close': { header: 'pull_request', outcomes: ['mr_closed'] },
  'github.pull-request.merge': { header: 'pull_request', outcomes: ['mr_merged'] },
  'github.pull-request.comment': { header: 'issue_comment', outcomes: ['note'] },
  'github.issue.comment': { header: 'issue_comment', outcomes: ['issue_comment'] },
  'github.pull-request.review-comment': {
    header: 'pull_request_review_comment',
    outcomes: ['note'],
  },
  'github.issue.labeled': { header: 'issues', outcomes: ['issue_labeled'] },
  'github.workflow-run.success': { header: 'workflow_run', outcomes: ['pipeline_succeeded'] },
  'github.workflow-run.failure': { header: 'workflow_run', outcomes: ['pipeline_failed'] },
  'github.workflow-run.timed-out': { header: 'workflow_run', outcomes: ['pipeline_failed'] },
}
const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** Reproduce producer classification, to reject a valid type with another family's payload. */
function declaredType(delivery: CrewStationEventDelivery): string | null {
  const root = delivery.payload,
    attrs = record(root.object_attributes)
  if (delivery.source.producer === 'gitlab') {
    const kind = root.object_kind
    if (kind === 'push') return 'gitlab.push'
    if (kind === 'tag_push') return 'gitlab.tag-push'
    if (kind === 'note')
      return attrs.noteable_type === 'MergeRequest'
        ? 'gitlab.merge-request.comment'
        : attrs.noteable_type === 'Issue'
          ? 'gitlab.issue.comment'
          : null
    const rule =
      kind === 'merge_request'
        ? ([
            'merge-request',
            'action',
            ['open', 'close', 'reopen', 'update', 'merge', 'approved', 'unapproved'],
          ] as const)
        : kind === 'pipeline'
          ? ([
              'pipeline',
              'status',
              [
                'created',
                'pending',
                'running',
                'success',
                'failed',
                'canceled',
                'skipped',
                'manual',
              ],
            ] as const)
          : kind === 'issue'
            ? (['issue', 'action', ['open', 'close', 'reopen', 'update']] as const)
            : null
    if (!rule) return null
    const value =
      typeof attrs[rule[1]] === 'string' ? String(attrs[rule[1]]).trim().toLowerCase() : ''
    return `gitlab.${rule[0]}${(rule[2] as readonly string[]).includes(value) ? '.' + value : ''}`
  }
  const header = CREWSTATION_CODE_HOST_EVENTS[delivery.eventType]?.header
  if (header === 'push')
    return typeof root.ref === 'string' && /^refs\/(heads|tags)\/.+/.test(root.ref)
      ? root.ref.startsWith('refs/tags/')
        ? 'github.tag-push'
        : 'github.push'
      : null
  if (header === 'pull_request') {
    if (root.action === 'closed')
      return record(root.pull_request).merged === true
        ? 'github.pull-request.merge'
        : record(root.pull_request).merged === false
          ? 'github.pull-request.close'
          : null
    const action = {
      opened: 'open',
      reopened: 'reopen',
      synchronize: 'update',
      edited: 'update',
      ready_for_review: 'update',
      converted_to_draft: 'update',
    }[String(root.action)]
    return action ? `github.pull-request.${action}` : null
  }
  if (header === 'issue_comment' && root.action === 'created')
    return record(root.issue).pull_request ? 'github.pull-request.comment' : 'github.issue.comment'
  if (header === 'pull_request_review_comment' && root.action === 'created')
    return 'github.pull-request.review-comment'
  if (header === 'issues' && root.action === 'labeled') return 'github.issue.labeled'
  if (header === 'workflow_run' && root.action === 'completed') {
    const conclusion = record(root.workflow_run).conclusion
    if (conclusion === 'success' || conclusion === 'failure' || conclusion === 'timed_out')
      return 'github.workflow-run.' + conclusion.replace('_', '-')
  }
  return null
}

export function validateCrewStationEventSources(value: unknown): readonly CrewStationEventSource[] {
  const sources = CrewStationEventSourcesSchema.parse(value)
  const producers = new Set<string>(),
    endpoints = new Map<string, string>()
  for (const source of sources) {
    if (producers.has(source.producerId)) throw new Error('duplicate CS producer')
    producers.add(source.producerId)
    for (const url of [source.instanceUrl, source.apiBaseUrl]) {
      const parsed = new URL(url)
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        url.endsWith('/')
      )
        throw new Error('invalid approved code host URL')
    }
    for (const origin of source.sshOrigins ?? []) {
      const parsed = new URL(origin)
      if (
        parsed.protocol !== 'ssh:' ||
        !/^[a-zA-Z0-9._-]+$/.test(parsed.username) ||
        parsed.password ||
        (parsed.pathname && parsed.pathname !== '/') ||
        parsed.search ||
        parsed.hash
      )
        throw new Error('invalid approved SSH origin')
    }
    const ids = new Set<string>(),
      names = new Set<string>(),
      targets = new Set<string>()
    for (const type of source.eventTypes) {
      if (
        !CREWSTATION_CODE_HOST_EVENTS[type.name] ||
        !type.name.startsWith(source.producer + '.') ||
        ids.has(type.id) ||
        names.has(type.name)
      )
        throw new Error('invalid CS event catalog')
      ids.add(type.id)
      names.add(type.name)
    }
    for (const binding of source.bindings) {
      if (
        targets.has(binding.endpointId) ||
        binding.repositories.some((repo) => !source.repositories.includes(repo))
      )
        throw new Error('invalid CS repository binding')
      targets.add(binding.endpointId)
      // One endpoint has one channel, whichever producer routes to it.
      const mode = endpoints.get(binding.endpointId)
      if (mode && mode !== binding.mode) throw new Error('conflicting CS endpoint channels')
      endpoints.set(binding.endpointId, binding.mode)
    }
  }
  return sources
}

/** Only explicit repositories in the approved instance participate in routing. */
export function crewStationRepository(
  delivery: CrewStationEventDelivery,
  source: CrewStationEventSource,
): string {
  if (declaredType(delivery) !== delivery.eventType)
    throw new CrewStationEventError(400, 'event-payload-family-conflict')
  const repo = record(delivery.payload[source.producer === 'gitlab' ? 'project' : 'repository'])
  const path = source.producer === 'gitlab' ? repo.path_with_namespace : repo.full_name
  const url = source.producer === 'gitlab' ? repo.web_url : repo.html_url
  if (!Repository.safeParse(path).success || url !== `${source.instanceUrl}/${String(path)}`)
    throw new CrewStationEventError(400, 'event-repository-instance-conflict')
  return String(path)
}

export function normalizeCrewStationEvent(
  delivery: CrewStationEventDelivery,
  source: CrewStationEventSource,
  eventUuid: string,
): NormalizeResult {
  const mapping = CREWSTATION_CODE_HOST_EVENTS[delivery.eventType]
  if (!mapping) throw new CrewStationEventError(422, 'unknown-event-type')
  crewStationRepository(delivery, source)
  const result =
    source.producer === 'github'
      ? githubNormalize(
          { 'x-github-event': mapping.header, 'x-github-delivery': eventUuid },
          delivery.payload,
        )
      : gitlabNormalize(
          { 'x-gitlab-event': mapping.header, 'x-gitlab-event-uuid': eventUuid },
          delivery.payload,
        )
  if (result.ok) {
    if (!mapping.outcomes.includes(result.event.eventType))
      return {
        ok: false,
        reason: 'parse-failed',
        detail: 'CS type disagrees with normalized event',
      }
    const instance = new URL(source.instanceUrl)
    const repositoryPaths = new Set([
      `${result.event.repoPath}.git`,
      `${instance.pathname.replace(/^\//, '')}/${result.event.repoPath}.git`.replace(/^\//, ''),
    ])
    const expectedHttp = `${source.instanceUrl}/${result.event.repoPath}.git`
    const ssh = result.event.repoSshUrl
    const scp = /^([^@/:\s]+)@([^/:\s]+):(.+)$/.exec(ssh)
    let approvedSsh = false
    try {
      const parsed = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : ssh)
      const originKey = (url: URL) => `${url.username}@${url.hostname}:${url.port || '22'}`
      const origins = source.sshOrigins ?? [`ssh://git@${instance.hostname}`]
      approvedSsh =
        parsed.protocol === 'ssh:' &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash &&
        repositoryPaths.has(parsed.pathname.slice(1)) &&
        origins.some((origin) => originKey(new URL(origin)) === originKey(parsed))
    } catch {
      approvedSsh = false
    }
    if (result.event.repoHttpUrl !== expectedHttp || !approvedSsh)
      return {
        ok: false,
        reason: 'parse-failed',
        detail: 'Clone URL is outside the approved code host repository',
      }
    // Authority never comes from an upstream payload's API URL.
    return { ok: true, event: { ...result.event, apiBaseUrl: source.apiBaseUrl } }
  }
  return result
}

// Canonical JSON is scoped to JSON input; never hashes arbitrary JS values.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (typeof value === 'object' && value !== null)
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => JSON.stringify(key) + ':' + canonical(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonical(value))
}

/** Where the configured sources route a first sighting of this delivery's event. */
export function routeCrewStationEvent(
  delivery: CrewStationEventDelivery,
  sources: readonly CrewStationEventSource[],
): CrewStationEventRoute {
  const source = sources.find((candidate) => candidate.producerId === delivery.source.producerId)
  if (
    !source ||
    source.producer !== delivery.source.producer ||
    source.project !== delivery.source.project ||
    !source.eventTypes.some(
      (type) => type.id === delivery.eventTypeId && type.name === delivery.eventType,
    )
  )
    return { kind: 'unroutable', status: 422, code: 'unknown-producer-or-event-binding' }
  let repository: string
  try {
    repository = crewStationRepository(delivery, source)
  } catch (error) {
    if (error instanceof CrewStationEventError && error.status === 400)
      return { kind: 'unroutable', status: 400, code: error.code }
    throw error
  }
  const targets = (
    source.repositories.includes(repository)
      ? source.bindings.filter((binding) => binding.repositories.includes(repository))
      : []
  )
    .map((binding) => ({
      endpointId: binding.endpointId,
      bindingRevision: binding.revision,
      channel: binding.mode,
    }))
    .sort((a, b) => (a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0))
  return {
    kind: 'routed',
    targets,
    frozenSource: JSON.stringify(source),
    sourceRevision: source.revision,
  }
}

/**
 * Parse a delivery request (envelope and CrewStation's delivery headers, which
 * must agree) into the ingress use case's input. Routing is deferred to the
 * first sighting of the logical event and evaluated against `sources`.
 */
export function inboundCrewStationDelivery(
  value: unknown,
  headers: {
    readonly deliveryId: string | undefined
    readonly eventType: string | undefined
    readonly attempt: string | undefined
  },
  sources: readonly CrewStationEventSource[],
): CrewStationInboundDelivery {
  const parsed = CrewStationEventDeliverySchema.safeParse(value)
  if (!parsed.success) throw new CrewStationEventError(400, 'invalid-event-delivery')
  const delivery = parsed.data
  if (
    headers.deliveryId !== delivery.deliveryId ||
    headers.eventType !== delivery.eventType ||
    headers.attempt !== String(delivery.attempt)
  )
    throw new CrewStationEventError(400, 'event-header-envelope-conflict')
  const { eventId, eventTypeId, eventType, source, occurredAt, payload } = delivery
  return {
    deliveryId: delivery.deliveryId,
    attempt: delivery.attempt,
    producerId: source.producerId,
    eventId,
    eventTypeId,
    factDigest: canonicalDigest({ eventId, eventTypeId, eventType, source, occurredAt, payload }),
    envelopeJson: JSON.stringify(delivery),
    route: () => routeCrewStationEvent(delivery, sources),
  }
}
