import { createHash } from 'node:crypto'
import {
  CODE_HOST_ACTIONS,
  codeHostActionDef,
  codeHostBindingCandidates,
  isCodeHostAction,
  isUnsupportedBinding,
  type CodeHostAction,
  type CodeHostProvider,
} from '@agent-workflow/shared'
import { canonicalJson } from './executionIntent'

export type CodeHostRecoveryClass =
  | 'R-READ'
  | 'R-EXACT'
  | 'R-STATE'
  | 'R-RUN-RETRY'
  | 'R-PARTIAL'
  | 'R-ACTOR'

export type CodeHostTransportProfile = 'T-READ' | 'T-POST' | 'T-IDEMPOTENT-METHOD'

export type CodeHostProbeProfile =
  | 'read-only'
  | 'exact-comment-body'
  | 'discussion-resolved'
  | 'draft-existence-partial'
  | 'commit-status-projection'
  | 'labels-contain'
  | 'assignees-contain'
  | 'merge-state'
  | 'run-generation-advanced'
  | 'pipeline-terminal-state'
  | 'actor-replay'
  | 'unsupported'

const RECOVERY_BY_ACTION = {
  'comment.reply-thread': 'R-ACTOR',
  'comment.create': 'R-ACTOR',
  'comment.create-inline': 'R-ACTOR',
  'comment.update': 'R-EXACT',
  'comment.create-issue': 'R-ACTOR',
  'comment.list-issue': 'R-READ',
  'comment.update-issue': 'R-EXACT',
  'thread.resolve': 'R-STATE',
  'review.draft-create': 'R-ACTOR',
  'review.draft-publish': 'R-ACTOR',
  'review.draft-discard': 'R-PARTIAL',
  'review.submit': 'R-ACTOR',
  'commit-status.set': 'R-STATE',
  'label.add': 'R-STATE',
  'assignee.set': 'R-STATE',
  'mr.approve': 'R-ACTOR',
  'mr.merge': 'R-STATE',
  'mr.create': 'R-ACTOR',
  'pipeline.trigger': 'R-ACTOR',
  'pipeline.retry': 'R-RUN-RETRY',
  'pipeline.cancel': 'R-STATE',
  'job.list': 'R-READ',
  'job.log': 'R-READ',
  'mr.get': 'R-READ',
  'mr.diff': 'R-READ',
  'mr.list': 'R-READ',
  'comment.list': 'R-READ',
  'file.read': 'R-READ',
  custom: 'R-ACTOR',
} as const satisfies Record<CodeHostAction, CodeHostRecoveryClass>

const PROBE_BY_ACTION = {
  'comment.reply-thread': 'actor-replay',
  'comment.create': 'actor-replay',
  'comment.create-inline': 'actor-replay',
  'comment.update': 'exact-comment-body',
  'comment.create-issue': 'actor-replay',
  'comment.list-issue': 'read-only',
  'comment.update-issue': 'exact-comment-body',
  'thread.resolve': 'discussion-resolved',
  'review.draft-create': 'actor-replay',
  'review.draft-publish': 'actor-replay',
  'review.draft-discard': 'draft-existence-partial',
  'review.submit': 'actor-replay',
  'commit-status.set': 'commit-status-projection',
  'label.add': 'labels-contain',
  'assignee.set': 'assignees-contain',
  'mr.approve': 'actor-replay',
  'mr.merge': 'merge-state',
  'mr.create': 'actor-replay',
  'pipeline.trigger': 'actor-replay',
  'pipeline.retry': 'run-generation-advanced',
  'pipeline.cancel': 'pipeline-terminal-state',
  'job.list': 'read-only',
  'job.log': 'read-only',
  'mr.get': 'read-only',
  'mr.diff': 'read-only',
  'mr.list': 'read-only',
  'comment.list': 'read-only',
  'file.read': 'read-only',
  custom: 'actor-replay',
} as const satisfies Record<CodeHostAction, Exclude<CodeHostProbeProfile, 'unsupported'>>

const CODE_HOST_PROVIDERS = ['gitlab', 'github'] as const satisfies readonly CodeHostProvider[]
const CUSTOM_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

export interface CodeHostRecoveryBindingManifestEntry {
  readonly id: string
  readonly action: CodeHostAction
  readonly provider: CodeHostProvider
  readonly candidateId: string
  readonly candidateIndex: number | null
  readonly supported: boolean
  readonly method: string | null
  readonly path: string | null
  readonly recoveryClass: CodeHostRecoveryClass | 'R-UNSUPPORTED'
  readonly transportProfile: CodeHostTransportProfile | null
  readonly compatibilityFallbackAvailable: boolean
  readonly probeProfile: CodeHostProbeProfile
}

export interface CodeHostMutationRequestSnapshot {
  readonly provider: CodeHostProvider
  readonly action: CodeHostAction
  readonly candidateId: string
  readonly method: string
  readonly pathname: string
  readonly query: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly baseUrl: string
  readonly connectionGeneration?: string
  /** Best-effort read taken before actions whose generation must be frozen. */
  readonly preMutationResponse?: Readonly<{
    status: number
    body: string
  }>
}

type CodeHostRecoveryProbe =
  | Readonly<{ kind: 'actor-replay' }>
  | Readonly<{ kind: 'exact-body'; pathname: string; expectedBodyDigest: string }>
  | Readonly<{ kind: 'discussion-resolved'; pathname: string }>
  | Readonly<{ kind: 'draft-existence-partial'; pathname: string }>
  | Readonly<{
      kind: 'commit-status-projection'
      pathname: string
      expectedContextDigest: string
      expectedProjectionDigest: string
    }>
  | Readonly<{
      kind: 'labels-contain'
      pathname: string
      expectedValueDigests: readonly string[]
    }>
  | Readonly<{
      kind: 'assignees'
      pathname: string
      comparison: 'equal' | 'contain'
      expectedValueDigests: readonly string[]
    }>
  | Readonly<{
      kind: 'merge-state'
      pathname: string
      expectedHeadDigest: string | null
    }>
  | Readonly<{
      kind: 'run-generation-advanced'
      pathname: string
      beforeAttempt: number | null
      beforeJobIdDigests: readonly string[]
    }>
  | Readonly<{ kind: 'pipeline-terminal-state'; pathname: string }>

/**
 * Persisted beside one HTTP attempt. It contains only object coordinates and
 * one-way digests of desired values; credentials and comment/status bodies are
 * never copied into the execution ledger.
 */
export interface CodeHostRecoveryDescriptor {
  readonly v: 1
  readonly provider: CodeHostProvider
  readonly action: CodeHostAction
  readonly candidateId: string
  readonly method: string
  readonly mutationPathname: string
  readonly baseUrlDigest: string
  readonly connectionGeneration: string | null
  readonly nodeRunId: string | null
  readonly probe: CodeHostRecoveryProbe
}

export type CodeHostProbeOutcome =
  | Readonly<{
      kind: 'applied'
      proofCode: string
      responseStatus: number
      responseBody: string
    }>
  | Readonly<{
      kind: 'definitely-not-applied'
      proofCode: string
      responseStatus: number
      responseBody: string
    }>
  | Readonly<{
      kind: 'unknown'
      proofCode: string
      responseStatus: number | null
      responseBody: string
    }>

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function codeHostRecoveryBaseUrlDigest(baseUrl: string): string {
  return digest(baseUrl.replace(/\/+$/, ''))
}

function normalizedBody(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : ''
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function valueDigests(values: readonly unknown[]): readonly string[] {
  return [...new Set(values.map((value) => digest(String(value))))].sort()
}

function csv(value: unknown): readonly string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : []
}

function parsedPreMutation(snapshot: CodeHostMutationRequestSnapshot): unknown {
  if (
    snapshot.preMutationResponse === undefined ||
    snapshot.preMutationResponse.status < 200 ||
    snapshot.preMutationResponse.status >= 300
  ) {
    return null
  }
  try {
    return JSON.parse(snapshot.preMutationResponse.body)
  } catch {
    return null
  }
}

function stripSuffix(pathname: string, suffix: string): string {
  return pathname.endsWith(suffix) ? pathname.slice(0, -suffix.length) : pathname
}

function buildProbe(snapshot: CodeHostMutationRequestSnapshot): CodeHostRecoveryProbe {
  const body = record(snapshot.body)
  switch (PROBE_BY_ACTION[snapshot.action]) {
    case 'actor-replay':
    case 'read-only':
      return { kind: 'actor-replay' }
    case 'exact-comment-body':
      return {
        kind: 'exact-body',
        pathname: snapshot.pathname,
        expectedBodyDigest: digest(normalizedBody(body.body)),
      }
    case 'discussion-resolved':
      return { kind: 'discussion-resolved', pathname: snapshot.pathname }
    case 'draft-existence-partial':
      return { kind: 'draft-existence-partial', pathname: snapshot.pathname }
    case 'commit-status-projection': {
      const expected =
        snapshot.provider === 'gitlab'
          ? {
              state: snapshot.query.state ?? '',
              context: snapshot.query.name ?? 'default',
              description: snapshot.query.description ?? '',
              targetUrl: snapshot.query.target_url ?? '',
            }
          : {
              state: stringValue(body.state),
              context: stringValue(body.context) || 'default',
              description: stringValue(body.description),
              targetUrl: stringValue(body.target_url),
            }
      const pathname =
        snapshot.provider === 'gitlab'
          ? snapshot.pathname.replace(/\/statuses\/([^/]+)$/, '/repository/commits/$1/statuses')
          : snapshot.pathname.replace(/\/statuses\/([^/]+)$/, '/commits/$1/statuses')
      return {
        kind: 'commit-status-projection',
        pathname,
        expectedContextDigest: digest(expected.context),
        expectedProjectionDigest: digest(expected),
      }
    }
    case 'labels-contain': {
      const labels = snapshot.provider === 'gitlab' ? csv(body.add_labels) : array(body.labels)
      return {
        kind: 'labels-contain',
        pathname: snapshot.pathname,
        expectedValueDigests: valueDigests(labels),
      }
    }
    case 'assignees-contain': {
      const assignees =
        snapshot.provider === 'gitlab' ? array(body.assignee_ids) : array(body.assignees)
      return {
        kind: 'assignees',
        pathname:
          snapshot.provider === 'github'
            ? stripSuffix(snapshot.pathname, '/assignees')
            : snapshot.pathname,
        comparison: snapshot.provider === 'gitlab' ? 'equal' : 'contain',
        expectedValueDigests: valueDigests(assignees),
      }
    }
    case 'merge-state': {
      const before = record(parsedPreMutation(snapshot))
      const head =
        snapshot.provider === 'gitlab'
          ? stringValue(before.sha) || stringValue(record(before.diff_refs).head_sha)
          : stringValue(record(before.head).sha)
      return {
        kind: 'merge-state',
        pathname: stripSuffix(snapshot.pathname, '/merge'),
        expectedHeadDigest: head.length > 0 ? digest(head) : null,
      }
    }
    case 'run-generation-advanced': {
      const before = parsedPreMutation(snapshot)
      if (snapshot.provider === 'github') {
        const runAttempt = record(before).run_attempt
        return {
          kind: 'run-generation-advanced',
          pathname: stripSuffix(snapshot.pathname, '/rerun-failed-jobs'),
          beforeAttempt: typeof runAttempt === 'number' ? runAttempt : null,
          beforeJobIdDigests: [],
        }
      }
      return {
        kind: 'run-generation-advanced',
        pathname: `${stripSuffix(snapshot.pathname, '/retry')}/jobs?include_retried=true`,
        beforeAttempt: null,
        beforeJobIdDigests: valueDigests(
          array(before)
            .map((item) => record(item).id)
            .filter((id) => id !== undefined),
        ),
      }
    }
    case 'pipeline-terminal-state':
      return {
        kind: 'pipeline-terminal-state',
        pathname: stripSuffix(snapshot.pathname, '/cancel'),
      }
  }
}

export function buildCodeHostRecoveryDescriptor(
  snapshot: CodeHostMutationRequestSnapshot,
  nodeRunId: string | null = null,
): CodeHostRecoveryDescriptor {
  return {
    v: 1,
    provider: snapshot.provider,
    action: snapshot.action,
    candidateId: snapshot.candidateId,
    method: snapshot.method,
    mutationPathname: snapshot.pathname,
    baseUrlDigest: codeHostRecoveryBaseUrlDigest(snapshot.baseUrl),
    connectionGeneration: snapshot.connectionGeneration ?? null,
    nodeRunId,
    probe: buildProbe(snapshot),
  }
}

export function decodeCodeHostRecoveryDescriptor(value: string): CodeHostRecoveryDescriptor {
  const parsed: unknown = JSON.parse(value)
  const top = record(parsed)
  if (
    top.v !== 1 ||
    (top.provider !== 'gitlab' && top.provider !== 'github') ||
    !isCodeHostAction(top.action) ||
    typeof top.candidateId !== 'string' ||
    typeof top.method !== 'string' ||
    typeof top.mutationPathname !== 'string' ||
    typeof top.baseUrlDigest !== 'string' ||
    (top.connectionGeneration !== null && typeof top.connectionGeneration !== 'string') ||
    (top.nodeRunId !== null && typeof top.nodeRunId !== 'string') ||
    typeof top.probe !== 'object' ||
    top.probe === null
  ) {
    throw new Error('invalid code-host recovery descriptor')
  }
  return parsed as CodeHostRecoveryDescriptor
}

function parsedProbeBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function unknownProbe(
  proofCode: string,
  responseStatus: number | null,
  responseBody: string,
): CodeHostProbeOutcome {
  return { kind: 'unknown', proofCode, responseStatus, responseBody }
}

/** Provider-independent classifier; fake providers can exercise it directly. */
export function classifyCodeHostProbeResponse(input: {
  descriptor: CodeHostRecoveryDescriptor
  status: number
  body: string
}): CodeHostProbeOutcome {
  const { probe } = input.descriptor
  if (probe.kind === 'actor-replay') {
    return unknownProbe('actor-replay-required', input.status, input.body)
  }
  if (probe.kind === 'draft-existence-partial') {
    return input.status >= 200 && input.status < 300
      ? {
          kind: 'definitely-not-applied',
          proofCode: 'exact-draft-still-exists',
          responseStatus: input.status,
          responseBody: input.body,
        }
      : unknownProbe('draft-absence-is-ambiguous', input.status, input.body)
  }
  if (input.status < 200 || input.status >= 300) {
    return unknownProbe('probe-http-non-success', input.status, input.body)
  }
  const parsed = parsedProbeBody(input.body)
  const current = record(parsed)
  let applied = false
  let retryableMismatch = false
  let proofCode = 'probe-projection-mismatch'
  switch (probe.kind) {
    case 'exact-body':
      applied = digest(normalizedBody(current.body)) === probe.expectedBodyDigest
      retryableMismatch = !applied
      proofCode = applied ? 'exact-object-body-matched' : proofCode
      break
    case 'discussion-resolved':
      applied = current.resolved === true
      retryableMismatch = !applied
      proofCode = applied ? 'exact-discussion-resolved' : proofCode
      break
    case 'commit-status-projection': {
      const rows = array(parsed).map(record)
      const matching = rows.find((row) => {
        const context =
          input.descriptor.provider === 'gitlab' ? stringValue(row.name) : stringValue(row.context)
        return digest(context) === probe.expectedContextDigest
      })
      if (matching !== undefined) {
        const projection =
          input.descriptor.provider === 'gitlab'
            ? {
                state: stringValue(matching.status),
                context: stringValue(matching.name),
                description: stringValue(matching.description),
                targetUrl: stringValue(matching.target_url),
              }
            : {
                state: stringValue(matching.state),
                context: stringValue(matching.context),
                description: stringValue(matching.description),
                targetUrl: stringValue(matching.target_url),
              }
        applied = digest(projection) === probe.expectedProjectionDigest
      }
      retryableMismatch = !applied
      proofCode = applied ? 'effective-commit-status-matched' : proofCode
      break
    }
    case 'labels-contain': {
      const labels = array(input.descriptor.provider === 'gitlab' ? current.labels : parsed).map(
        (value) =>
          input.descriptor.provider === 'gitlab'
            ? value
            : typeof value === 'string'
              ? value
              : record(value).name,
      )
      const actual = new Set(valueDigests(labels))
      applied = probe.expectedValueDigests.every((value) => actual.has(value))
      retryableMismatch = !applied
      proofCode = applied ? 'requested-labels-present' : proofCode
      break
    }
    case 'assignees': {
      const values = array(current.assignees).map((value) => {
        const item = record(value)
        return input.descriptor.provider === 'gitlab' ? item.id : item.login
      })
      const actual = valueDigests(values)
      applied =
        probe.comparison === 'equal'
          ? canonicalJson(actual) === canonicalJson(probe.expectedValueDigests)
          : probe.expectedValueDigests.every((value) => actual.includes(value))
      retryableMismatch = !applied
      proofCode = applied ? 'requested-assignees-projection-matched' : proofCode
      break
    }
    case 'merge-state': {
      const merged =
        input.descriptor.provider === 'gitlab'
          ? current.state === 'merged' ||
            (typeof current.merged_at === 'string' && current.merged_at.length > 0)
          : current.merged === true
      const head =
        input.descriptor.provider === 'gitlab'
          ? stringValue(current.sha) || stringValue(record(current.diff_refs).head_sha)
          : stringValue(record(current.head).sha)
      applied =
        merged &&
        probe.expectedHeadDigest !== null &&
        head.length > 0 &&
        digest(head) === probe.expectedHeadDigest
      retryableMismatch =
        !merged &&
        probe.expectedHeadDigest !== null &&
        head.length > 0 &&
        digest(head) === probe.expectedHeadDigest
      proofCode = applied ? 'merged-at-frozen-head' : proofCode
      break
    }
    case 'run-generation-advanced':
      if (input.descriptor.provider === 'github') {
        const attempt = current.run_attempt
        applied =
          probe.beforeAttempt !== null &&
          typeof attempt === 'number' &&
          attempt > probe.beforeAttempt
        retryableMismatch =
          probe.beforeAttempt !== null &&
          typeof attempt === 'number' &&
          attempt === probe.beforeAttempt
      } else {
        const after = new Set(
          valueDigests(
            array(parsed)
              .map((item) => record(item).id)
              .filter((id) => id !== undefined),
          ),
        )
        applied =
          probe.beforeJobIdDigests.length > 0 &&
          [...after].some((value) => !probe.beforeJobIdDigests.includes(value))
        retryableMismatch =
          probe.beforeJobIdDigests.length > 0 &&
          after.size === probe.beforeJobIdDigests.length &&
          [...after].every((value) => probe.beforeJobIdDigests.includes(value))
      }
      proofCode = applied ? 'pipeline-retry-generation-advanced' : proofCode
      break
    case 'pipeline-terminal-state': {
      const status = stringValue(current.status).toLowerCase()
      const conclusion = stringValue(current.conclusion).toLowerCase()
      applied =
        status === 'canceled' ||
        status === 'cancelled' ||
        status === 'success' ||
        status === 'failed' ||
        (status === 'completed' && conclusion.length > 0)
      retryableMismatch =
        !applied &&
        ['queued', 'pending', 'waiting', 'in_progress', 'running', 'canceling'].includes(status)
      proofCode = applied
        ? status === 'canceled' || status === 'cancelled' || conclusion === 'cancelled'
          ? 'pipeline-canceled'
          : 'pipeline-already-terminal'
        : proofCode
      break
    }
  }
  return applied
    ? {
        kind: 'applied',
        proofCode,
        responseStatus: input.status,
        responseBody: input.body,
      }
    : retryableMismatch
      ? {
          kind: 'definitely-not-applied',
          proofCode: `${proofCode}-retryable`,
          responseStatus: input.status,
          responseBody: input.body,
        }
      : unknownProbe(proofCode, input.status, input.body)
}

export function codeHostTransportProfile(method: string): CodeHostTransportProfile {
  if (method === 'GET') return 'T-READ'
  if (method === 'POST') return 'T-POST'
  if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    return 'T-IDEMPOTENT-METHOD'
  }
  throw new Error(`unsupported code-host transport method '${method}'`)
}

/**
 * Executable projection of RFC-328's action × provider × candidate matrix.
 * The action registry remains the source of methods, paths and candidate
 * order; this module owns only recovery/probe semantics.  Adding an action or
 * provider therefore fails typecheck or the structural validator instead of
 * silently falling into a generic safety default.
 */
export function buildCodeHostRecoveryBindingManifest(): readonly CodeHostRecoveryBindingManifestEntry[] {
  const entries: CodeHostRecoveryBindingManifestEntry[] = []
  for (const action of CODE_HOST_ACTIONS) {
    if (action === 'custom') {
      for (const provider of CODE_HOST_PROVIDERS) {
        for (const [index, method] of CUSTOM_METHODS.entries()) {
          const recoveryClass = codeHostRecoveryClass(action, method)
          entries.push({
            id: `${action}:${provider}:${method}`,
            action,
            provider,
            candidateId: `custom:${method.toLowerCase()}`,
            candidateIndex: index,
            supported: true,
            method,
            path: '<dynamic>',
            recoveryClass,
            transportProfile: codeHostTransportProfile(method),
            compatibilityFallbackAvailable: false,
            probeProfile: method === 'GET' ? 'read-only' : PROBE_BY_ACTION[action],
          })
        }
      }
      continue
    }
    for (const provider of CODE_HOST_PROVIDERS) {
      const binding = codeHostActionDef(action).bindings[provider]
      if (isUnsupportedBinding(binding)) {
        entries.push({
          id: `${action}:${provider}:unsupported`,
          action,
          provider,
          candidateId: 'unsupported',
          candidateIndex: null,
          supported: false,
          method: null,
          path: null,
          recoveryClass: 'R-UNSUPPORTED',
          transportProfile: null,
          compatibilityFallbackAvailable: false,
          probeProfile: 'unsupported',
        })
        continue
      }
      const candidates = codeHostBindingCandidates(binding)
      candidates.forEach((candidate, index) => {
        entries.push({
          id: `${action}:${provider}:c${index}`,
          action,
          provider,
          candidateId: `${action}:c${index}`,
          candidateIndex: index,
          supported: true,
          method: candidate.method,
          path: candidate.path,
          recoveryClass: codeHostRecoveryClass(action, candidate.method),
          transportProfile: codeHostTransportProfile(candidate.method),
          compatibilityFallbackAvailable: index + 1 < candidates.length,
          probeProfile: PROBE_BY_ACTION[action],
        })
      })
    }
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id))
}

export function validateCodeHostRecoveryBindingManifest(
  entries: readonly CodeHostRecoveryBindingManifestEntry[],
): readonly string[] {
  const errors: string[] = []
  const ids = entries.map((entry) => entry.id)
  if (entries.length === 0) errors.push('code-host recovery binding denominator is empty')
  if (new Set(ids).size !== ids.length) errors.push('duplicate code-host recovery binding id')

  const expected = buildCodeHostRecoveryBindingManifest()
  const actualById = new Map(entries.map((entry) => [entry.id, entry]))
  const expectedById = new Map(expected.map((entry) => [entry.id, entry]))
  for (const entry of expected) {
    const actual = actualById.get(entry.id)
    if (actual === undefined) {
      errors.push(`missing code-host recovery binding '${entry.id}'`)
      continue
    }
    if (JSON.stringify(actual) !== JSON.stringify(entry)) {
      errors.push(`drifted code-host recovery binding '${entry.id}'`)
    }
  }
  for (const entry of entries) {
    if (!expectedById.has(entry.id)) errors.push(`unknown code-host recovery binding '${entry.id}'`)
    if (entry.action === 'mr.approve' && entry.recoveryClass !== 'R-ACTOR') {
      errors.push(`mr.approve must remain actor-replay for ${entry.provider}`)
    }
  }
  return [...new Set(errors)].sort()
}

export function codeHostRecoveryClass(
  action: CodeHostAction,
  method: string,
): CodeHostRecoveryClass {
  return action === 'custom' && method === 'GET' ? 'R-READ' : RECOVERY_BY_ACTION[action]
}

export const CODE_HOST_CLASSIFIER_VERSION = 'rfc328-v1'
export const CODE_HOST_TRANSPORT_POLICY_VERSION = 'rfc269-compatible-v1'
