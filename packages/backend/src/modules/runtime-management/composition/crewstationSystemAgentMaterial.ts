import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  AgentMaterialSeedFile,
  AgentMaterialWorkspace,
} from '../application/ports/agentMaterialWorkspace'
import type {
  SystemAgentRetainedContents,
  SystemAgentWorkspaceScope,
  SystemAgentWorkspaceScopes,
} from '../application/ports/systemAgentRetainedContents'
import { sha256Hex } from '@/util/hash'

/** System scratch namespaces share durable parent volumes; each invocation has
 * its own directory. Closing a scratch never closes another Agent's parent. */
export function composeCrewStationSystemAgentContents(input: {
  readonly helper: WorkspaceHelper
  readonly reference: (taskId: string, path: string) => string
  readonly canRelease: (taskId: string, invocationId: string, path: string) => Promise<boolean>
}) {
  const scopes = new WeakSet<SystemAgentWorkspaceScope>()
  const forgotten = new Set<string>()
  const requireScope = (scope: SystemAgentWorkspaceScope) => {
    if (!scopes.has(scope)) throw new Error('system-workspace-scope-unavailable')
    return scope
  }
  const workspaces: SystemAgentWorkspaceScopes = {
    capture(scope) {
      const captured = Object.freeze({ namespace: scope.namespace, name: scope.name })
      scopes.add(captured)
      return captured
    },
    withName(scope, name) {
      requireScope(scope)
      return this.capture({ namespace: scope.namespace, name })
    },
  }
  const remove = async (
    entry: { namespace: 'intent' | 'shared'; key: string; taskId: string; invocationId: string },
    operationId?: string,
  ) => {
    if (
      !(await input.canRelease(
        entry.taskId,
        entry.invocationId,
        `/work/system/${entry.namespace}/${entry.key}`,
      ))
    )
      return { removed: false, reason: 'remove-failed' as const }
    const result = await input.helper.call<{
      removed: boolean
      reason?: 'unsafe-path' | 'remove-failed'
    }>(
      entry.taskId,
      'system-workspace',
      { method: 'release', namespace: entry.namespace, key: entry.key },
      operationId === undefined ? undefined : { operationId },
    )
    return result
  }
  const contents: SystemAgentRetainedContents = {
    forget: ({ retainedRef }) => {
      forgotten.add(retainedRef)
    },
    async release({ retainedRef, scope }) {
      requireScope(scope)
      const match = /^aw-hosted-system:v1:(intent|shared):([a-f0-9]{64}):([A-Za-z0-9_-]+)$/.exec(
        retainedRef,
      )
      if (
        !match ||
        forgotten.has(retainedRef) ||
        !scope.name ||
        match[1] !== scope.namespace ||
        match[2] !== sha256Hex(scope.name)
      )
        return { removed: false, reason: 'unsafe-path' }
      const entry = {
        namespace: scope.namespace,
        key: match[2]!,
        taskId: `system:${scope.namespace}`,
        invocationId: match[3]!,
      }
      try {
        return await remove(entry)
      } catch {
        return { removed: false, reason: 'remove-failed' }
      }
    },
  }
  return {
    workspaces,
    contents,
    open(request: {
      scope: SystemAgentWorkspaceScope
      invocationId: string
      seeds?: readonly AgentMaterialSeedFile[]
    }) {
      const scope = requireScope(request.scope)
      if (!/^[A-Za-z0-9_-]+$/.test(request.invocationId))
        throw new Error('hosted-system-invocation-invalid')
      const key = sha256Hex(scope.name ?? request.invocationId)
      const taskId = `system:${scope.namespace}`
      const path = `/work/system/${scope.namespace}/${key}`
      const retainedRef = `aw-hosted-system:v1:${scope.namespace}:${key}:${request.invocationId}`
      const entry = { namespace: scope.namespace, key, taskId, invocationId: request.invocationId }
      const workspace: AgentMaterialWorkspace = {
        workspace: {
          owner: 'source-control',
          reference: input.reference(taskId, `${path}/worktree`),
          version: null,
        },
        runContent: {
          owner: 'runtime-management',
          reference: input.reference(taskId, `${path}/run`),
          version: null,
        },
        retainedRef,
        async prepare(seeds) {
          await input.helper.call(
            taskId,
            'system-workspace',
            {
              method: 'prepare',
              namespace: scope.namespace,
              key,
              seeds: seeds ?? request.seeds ?? [],
            },
            { operationId: `system:${request.invocationId}:prepare` },
          )
        },
        async discard() {
          const result = await remove(entry, `system:${request.invocationId}:discard`)
          if (!result.removed) throw new Error(`hosted-system-workspace-${result.reason}`)
        },
      }
      return { workspace, taskId, cwd: `${path}/worktree` }
    },
  }
}
