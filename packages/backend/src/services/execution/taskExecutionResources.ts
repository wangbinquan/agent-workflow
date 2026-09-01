// RFC-345 T4a — task-execution consumer adapter for the named Resource
// Catalog participant. Every call binds one exact authority/actor pair to one
// synchronous SQLite transaction; callers see frozen data-only snapshots.

import { join } from 'node:path'

import type {
  FrozenTaskExecutionResourceSnapshot,
  TaskExecutionAgentSnapshot,
  TaskExecutionMcpSnapshot,
  TaskExecutionPluginSnapshot,
  TaskExecutionResourceRequest,
} from '@/modules/resource-catalog/public/types'
import type { ResolvedSkill } from '@/services/runtime/types'
import { DomainError } from '@/util/errors'
import type {
  TaskExecutionResourceAuthority,
  TaskExecutionResourceAuthorityPair,
  TaskExecutionResourceBinding,
} from '@/modules/task-execution/application/ports/taskExecutionResourceSnapshots'

/**
 * Consumer-owned structural seam. Bootstrap composition may satisfy it, but
 * task execution never imports the Resource Catalog composition directory.
 */
export type {
  TaskExecutionResourceAuthority,
  TaskExecutionResourceAuthorityPair,
  TaskExecutionResourceBinding,
} from '@/modules/task-execution/application/ports/taskExecutionResourceSnapshots'
export { createSqliteTaskExecutionResourceBinding } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionResourceSnapshots'
export { createPostgresqlTaskExecutionResourceBinding } from '@/modules/task-execution/infrastructure/postgresqlTaskExecutionResourceSnapshots'

export async function loadTaskExecutionResourceSnapshot<
  K extends TaskExecutionResourceRequest['kind'],
>(
  resourceAuthority: TaskExecutionResourceAuthority,
  request: Extract<TaskExecutionResourceRequest, { readonly kind: K }>,
): Promise<Extract<FrozenTaskExecutionResourceSnapshot, { readonly kind: K }>> {
  const loaded = await resourceAuthority.resources.loadAuthorized(resourceAuthority, [request])
  const snapshot = loaded[0]
  if (loaded.length !== 1 || snapshot === undefined || snapshot.kind !== request.kind) {
    throw new Error(`task-execution-resource-kind-mismatch:${request.kind}`)
  }
  return snapshot as Extract<FrozenTaskExecutionResourceSnapshot, { readonly kind: K }>
}

export interface TaskExecutionResolvedInjectionSpec {
  readonly agent: TaskExecutionAgentSnapshot
  readonly dependents: readonly TaskExecutionAgentSnapshot[]
  readonly skills: readonly ResolvedSkill[]
  readonly mcps: readonly TaskExecutionMcpSnapshot[]
  readonly plugins: readonly TaskExecutionPluginSnapshot[]
}

export type TaskExecutionInjectionResolution =
  | {
      readonly kind: 'ok'
      readonly spec: TaskExecutionResolvedInjectionSpec
      readonly notices: readonly []
    }
  | { readonly kind: 'failed'; readonly summary: string; readonly message: string }

/**
 * Built-in merge/commit agents are code-owned and intentionally have no
 * catalog resources. Keep that invariant explicit instead of routing them
 * back through a DB resolver or silently dropping future references.
 */
export function resolveSyntheticTaskExecutionInjection(
  agent: TaskExecutionAgentSnapshot,
): TaskExecutionInjectionResolution {
  if (
    agent.dependsOn.length > 0 ||
    agent.skills.length > 0 ||
    agent.mcp.length > 0 ||
    agent.plugins.length > 0
  ) {
    return {
      kind: 'failed',
      summary: `internal agent '${agent.name}' declares managed resources`,
      message: 'internal-agent-resources-unsupported',
    }
  }
  return {
    kind: 'ok',
    spec: Object.freeze({
      agent,
      dependents: Object.freeze([]),
      skills: Object.freeze([]),
      mcps: Object.freeze([]),
      plugins: Object.freeze([]),
    }),
    notices: [],
  }
}

/** Preserve the historical node-level typed failure boundary. */
export async function resolveTaskExecutionInjection(
  resourceAuthority: TaskExecutionResourceAuthority,
  agentId: string,
  appHome: string,
): Promise<TaskExecutionInjectionResolution> {
  try {
    const snapshot = await loadTaskExecutionResourceSnapshot(resourceAuthority, {
      kind: 'agent-injection',
      agentId,
    })
    const skills: ResolvedSkill[] = snapshot.skills.map((skill) =>
      skill.kind === 'project'
        ? { name: skill.name, sourceKind: 'project' }
        : {
            name: skill.name,
            sourceKind: 'managed',
            sourcePath: join(appHome, 'skills', skill.skillId, 'files'),
            skillId: skill.skillId,
            contentVersion: skill.contentVersion,
          },
    )
    return {
      kind: 'ok',
      spec: Object.freeze({
        agent: snapshot.root,
        dependents: snapshot.dependents,
        skills: Object.freeze(skills),
        mcps: snapshot.mcps,
        plugins: snapshot.plugins,
      }),
      notices: [],
    }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    const details = error.details as { readonly runtimeMessage?: unknown } | undefined
    return {
      kind: 'failed',
      summary: error.message,
      message: typeof details?.runtimeMessage === 'string' ? details.runtimeMessage : error.code,
    }
  }
}

/** One per-task cache: the first authorized snapshot is immutable for this run. */
export function createTaskExecutionResourceSession(
  resourceAuthority: TaskExecutionResourceAuthorityPair & {
    readonly resources: TaskExecutionResourceBinding
  },
  appHome: string,
) {
  const injections = new Map<string, Promise<TaskExecutionInjectionResolution>>()
  const injection = (agentId: string): Promise<TaskExecutionInjectionResolution> => {
    let found = injections.get(agentId)
    if (found === undefined) {
      found = resolveTaskExecutionInjection(resourceAuthority, agentId, appHome)
      injections.set(agentId, found)
    }
    return found
  }
  return Object.freeze({ injection })
}

export type TaskExecutionResourceSession = ReturnType<typeof createTaskExecutionResourceSession>
