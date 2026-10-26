import { z } from 'zod'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  repositoryUrlFacts,
  resolveRepositoryUrlFact,
  emitBootRow,
  blockBootRow,
  createBootUpgradeFacts,
  type BootUpgradeFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type { LookupReader } from '@/platform/persistence/migration/conversion/lookups'
import type { RepositoryUrlFact } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'
import {
  bootSourceRows,
  probeLocalGit,
  type LocalGitFact,
  type BootUpgradeEnvironmentContribution,
} from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'

const ref = { id: 'integration/boot-scheduled-payload', version: 2 } as const
const localGitSchema = z.strictObject({
  path: z.string(),
  ref: z.string().nullable(),
  state: z.enum(['present', 'absent', 'not-repository', 'unavailable']),
  realRoot: z.string().nullable(),
  fileUrl: z.string().nullable(),
  bare: z.boolean().nullable(),
  branchOid: z.string().nullable(),
  tagOid: z.string().nullable(),
  remoteOid: z.string().nullable(),
  resolvedOid: z.string().nullable(),
  remoteOnly: z.boolean(),
})
export const scheduleGitFactId = (path: string, branch: string | null): string =>
  `schedule-git:${valueDigest([path, branch])}`
export function scheduleGitMaterial(fact: LocalGitFact) {
  return {
    path: fact.path,
    ref: fact.ref,
    state: fact.state,
    realRoot: fact.realRoot,
    fileUrl: fact.fileUrl,
    refClass:
      fact.ref === null
        ? 'head'
        : /^(origin\/|refs\/remotes\/|remotes\/)/.test(fact.ref)
          ? fact.remoteOnly
            ? 'remote-tracking'
            : 'local'
          : 'literal',
  }
}
function staysDisabled(enabled: boolean, lastError: string | null): boolean {
  return !enabled && /^(rfc165-|rfc248-multi-repo-retired)/.test(lastError ?? '')
}
class ScheduledPayloadFactError extends Error {
  constructor(
    reason: string,
    readonly path: string,
    readonly factIds: readonly string[],
  ) {
    super(reason)
  }
}
function payloadDigest(payload: string): string {
  try {
    return valueDigest(JSON.parse(payload))
  } catch {
    return valueDigest(payload)
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function payloadObjects(body: Record<string, unknown>): Record<string, unknown>[] {
  if (
    body.repos !== undefined &&
    (!Array.isArray(body.repos) || body.repos.some((entry) => !object(entry)))
  )
    throw new Error('v2-boot-schedule-repos-invalid')
  return [body, ...(Array.isArray(body.repos) ? (body.repos as Record<string, unknown>[]) : [])]
}
function pathOf(body: Record<string, unknown>): string | null {
  if (
    (body.repoPath !== undefined && typeof body.repoPath !== 'string') ||
    (body.localRepoPath !== undefined && typeof body.localRepoPath !== 'string')
  )
    throw new Error('v2-boot-schedule-path-invalid')
  if (
    body.repoPath !== undefined &&
    body.localRepoPath !== undefined &&
    body.repoPath !== body.localRepoPath
  )
    throw new Error('v2-boot-schedule-path-conflict')
  return (body.repoPath ?? body.localRepoPath ?? null) as string | null
}
export function scheduledPayloadEnvironment(
  probe: (path: string, ref: string | null) => Promise<LocalGitFact> = probeLocalGit,
): BootUpgradeEnvironmentContribution {
  return {
    id: ref.id,
    async capture(input) {
      const captured = new Map<string, LocalGitFact>()
      for (const row of await bootSourceRows(input.source, 'scheduled_tasks')) {
        if (
          staysDisabled(
            row.enabled === true || row.enabled === 1,
            typeof row.last_error === 'string' ? row.last_error : null,
          )
        )
          continue
        try {
          const body: unknown = JSON.parse(String(row.launch_payload))
          if (!object(body)) continue
          if (
            body.fetchBeforeLaunch === true ||
            (Array.isArray(body.repos) && body.repos.length > 1)
          )
            continue
          for (const entry of payloadObjects(body)) {
            const path = pathOf(entry),
              branch = typeof entry.baseBranch === 'string' ? entry.baseBranch : null
            if (path !== null) {
              const id = scheduleGitFactId(path, branch)
              const fact = captured.get(id) ?? localGitSchema.parse(await probe(path, branch))
              captured.set(id, fact)
              if (fact.state !== 'present') break
            }
          }
        } catch {
          /* The rule records invalid JSON/fields, without guessing a filesystem input. */
        }
      }
      const facts = []
      for (const [id, fact] of [...captured].sort(([a], [b]) => a.localeCompare(b))) {
        facts.push({
          id,
          kind: 'local-git' as const,
          material: scheduleGitMaterial(fact),
          evidence: { ...fact },
        })
      }
      return facts
    },
  }
}
export interface ScheduledPayloadDecision {
  readonly payload: string
  readonly disableError: string | null
  readonly reason: string
  readonly factIds: readonly string[]
  readonly changes: readonly string[]
}
export function healFrozenScheduledPayload(input: {
  payload: string
  enabled: boolean
  lastError: string | null
  urls: LookupReader<RepositoryUrlFact>
  git: ReadonlyMap<string, LocalGitFact>
}): ScheduledPayloadDecision {
  const parsed: unknown = JSON.parse(input.payload)
  if (!object(parsed)) throw new Error('v2-boot-schedule-payload-invalid')
  const body = parsed
  const entries = payloadObjects(body),
    factIds = new Set<string>(),
    changes: string[] = []
  // URL linkage is fixed before retired payload fields are healed.
  for (const entry of entries) {
    for (const field of ['repoUrl', 'cachedRepoId', 'baseBranch', 'ref'])
      if (entry[field] !== undefined && typeof entry[field] !== 'string')
        throw new Error(`v2-boot-schedule-${field}-invalid`)
    if (entry.fetchBeforeLaunch !== undefined && typeof entry.fetchBeforeLaunch !== 'boolean')
      throw new Error('v2-boot-schedule-fetch-invalid')
    const rawUrl = typeof entry.repoUrl === 'string' && entry.repoUrl ? entry.repoUrl : null
    if (rawUrl || entry.cachedRepoId) {
      const result = resolveRepositoryUrlFact(
        input.urls,
        rawUrl,
        typeof entry.cachedRepoId === 'string' ? entry.cachedRepoId : null,
      )
      for (const id of result.factIds) factIds.add(id)
      if (result.state === 'blocked')
        throw new Error(result.reason ?? 'v2-boot-schedule-url-unproven')
      if (rawUrl && result.cachedRepoId) {
        delete entry.repoUrl
        entry.cachedRepoId = result.cachedRepoId
        changes.push('repoUrl -> cachedRepoId')
      }
    }
  }
  const urlPayload = changes.length ? JSON.stringify(body) : input.payload
  const urlChanges = [...changes]
  const decision = (
    payload: string,
    disableError: string | null,
    reason: string,
  ): ScheduledPayloadDecision => ({
    payload,
    disableError,
    reason,
    factIds: [...factIds].sort(),
    changes,
  })
  if (staysDisabled(input.enabled, input.lastError))
    return decision(urlPayload, null, 'v2-boot-schedule-kept-disabled')
  const disable = (reason: string) => ({
    ...decision(urlPayload, reason, reason.split(':')[0]!),
    changes: urlChanges,
  })
  for (const field of ['gitUserName', 'gitUserEmail'])
    if (field in body) {
      delete body[field]
      changes.push(`remove ${field}`)
    }
  if (body.fetchBeforeLaunch === true)
    return disable(
      'rfc165-fetch-semantic-review: fetchBeforeLaunch has no file:// equivalent — pick a repo source and re-save',
    )
  if (Array.isArray(body.repos) && body.repos.length > 1)
    return disable(
      `rfc248-multi-repo-retired: inline repos[] is retired (${body.repos.length} entries); create a repo group and re-save this schedule with repoGroupId`,
    )
  const pairs = entries.flatMap((entry) => {
    const path = pathOf(entry)
    return path === null
      ? []
      : [{ entry, path, branch: typeof entry.baseBranch === 'string' ? entry.baseBranch : null }]
  })
  for (const pair of pairs) {
    const id = scheduleGitFactId(pair.path, pair.branch)
    factIds.add(id)
    const fact = input.git.get(id)
    if (!fact || fact.state === 'unavailable')
      throw new ScheduledPayloadFactError(
        'v2-boot-schedule-git-unavailable',
        pair.path,
        [...factIds].sort(),
      )
    if (fact.state === 'absent' || fact.state === 'not-repository')
      return disable(`rfc165-local-path-retired: ${pair.path}`)
  }
  for (const pair of pairs) {
    const fact = input.git.get(scheduleGitFactId(pair.path, pair.branch))!
    if (fact.remoteOnly)
      return disable(
        `rfc165-remote-tracking-ref: baseBranch '${pair.branch}' names a remote-tracking ref — pick a concrete branch/URL and re-save`,
      )
    if (!fact.fileUrl || !fact.realRoot)
      throw new ScheduledPayloadFactError(
        'v2-boot-schedule-root-unproven',
        pair.path,
        [...factIds].sort(),
      )
    pair.entry.repoUrl = fact.fileUrl
    if (pair.branch !== null) pair.entry.ref = pair.branch
    delete pair.entry.repoPath
    delete pair.entry.localRepoPath
    delete pair.entry.baseBranch
    changes.push(`local path -> ${fact.fileUrl}; ref=${pair.branch ?? 'HEAD'}`)
  }
  if ('baseBranch' in body) {
    delete body.baseBranch
    changes.push('remove baseBranch')
  }
  if ('fetchBeforeLaunch' in body) {
    delete body.fetchBeforeLaunch
    changes.push('remove fetchBeforeLaunch')
  }
  if (Array.isArray(body.repos)) {
    const only = body.repos.length === 1 ? (body.repos[0] as Record<string, unknown>) : null
    if (only)
      for (const key of ['repoUrl', 'cachedRepoId', 'ref']) {
        if (body[key] === undefined && typeof only[key] === 'string') {
          body[key] = only[key]
          changes.push(`repos[0].${key} -> ${key}`)
        } else if (body[key] !== undefined && only[key] !== undefined)
          changes.push(`keep top-level ${key}`)
      }
    delete body.repos
    changes.push('remove repos')
  }
  return decision(
    changes.length ? JSON.stringify(body) : input.payload,
    null,
    changes.length ? 'v2-boot-schedule-healed' : 'v2-boot-schedule-unchanged',
  )
}
export function scheduledPayloadConversion(facts: BootUpgradeFacts): ConversionContribution {
  const git = new Map(
    facts.facts
      .filter((fact) => fact.kind === 'local-git')
      .map((fact) => [fact.id, localGitSchema.parse(fact.evidence)]),
  )
  const rule: ConversionRule = {
    ref,
    owner: 'integration',
    claims: ['scheduled_tasks'],
    produces: [{ table: 'scheduled_tasks' }],
    lookups: [repositoryUrlFacts],
    unit: { kind: 'source-chunk', table: 'scheduled_tasks' },
    convert(unit, ctx) {
      for (const row of unit.rows.get('scheduled_tasks') ?? []) {
        const before = {
          id: String(row.values.id),
          enabled: row.values.enabled === true || row.values.enabled === 1,
          payloadDigest: payloadDigest(String(row.values.launch_payload)),
          lastError: typeof row.values.last_error === 'string' ? row.values.last_error : null,
        }
        try {
          const result = healFrozenScheduledPayload({
            payload: String(row.values.launch_payload),
            enabled: before.enabled,
            lastError: before.lastError,
            urls: ctx.lookup(repositoryUrlFacts),
            git,
          })
          const changed =
            result.payload !== row.values.launch_payload || result.disableError !== null
          const values = {
            ...row.values,
            launch_payload: result.payload,
            ...(result.disableError
              ? { enabled: false, last_error: result.disableError, next_run_at: null }
              : {}),
            ...(changed ? { updated_at: ctx.planTime } : {}),
          }
          emitBootRow(ctx, ref, row, values, {
            changed,
            before,
            after: {
              ...before,
              enabled: result.disableError ? false : before.enabled,
              payloadDigest: payloadDigest(result.payload),
              lastError: result.disableError ?? before.lastError,
              changes: result.changes,
              nextRunCleared: result.disableError !== null,
              git: result.factIds.flatMap((id) =>
                git.has(id) ? [scheduleGitMaterial(git.get(id)!)] : [],
              ),
            },
            reason: result.reason,
            factIds: result.factIds,
          })
        } catch (error) {
          blockBootRow(
            ctx,
            ref,
            row,
            error instanceof Error && error.message.startsWith('v2-')
              ? error.message
              : 'v2-boot-schedule-payload-invalid',
            {
              ...before,
              ...(error instanceof ScheduledPayloadFactError
                ? { path: error.path, factIds: error.factIds }
                : {}),
            },
            error instanceof ScheduledPayloadFactError ? error.factIds : [],
          )
        }
      }
    },
  }
  return { rules: [rule], lookups: [], validators: [] }
}
export const conversion: ConversionContribution = {
  ...scheduledPayloadConversion(createBootUpgradeFacts([])),
  withBootUpgrade: scheduledPayloadConversion,
}
