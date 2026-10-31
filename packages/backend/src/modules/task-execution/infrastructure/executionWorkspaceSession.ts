import type { ExecutionWorkspaceSession } from '../application/ports/executionWorkspaceSession'
import type {
  IsolationRestoreInput,
  IsolationWorkspaceBinding,
  IsolationWorkspaceFactory,
  IsolationWorkspaceScope,
} from '@/modules/source-control/public/types'
import { requireIsolationWorkspaceScope } from '@/modules/source-control/public/participants'
import { workspaceView } from './isolationWorkspaceView'

interface Scene {
  readonly factory: IsolationWorkspaceFactory
  readonly identity: string
  readonly scope: Promise<IsolationWorkspaceScope>
}

/** One session per mechanics state. Read current inputs only at the original acquisition site. */
export function createExecutionWorkspaceSession(
  selection: () => {
    readonly factory: IsolationWorkspaceFactory
    readonly binding: IsolationWorkspaceBinding
  },
): ExecutionWorkspaceSession {
  let scene: Scene | undefined
  function scopeFor(): Promise<IsolationWorkspaceScope> {
    const { factory, binding } = selection()
    const identity = JSON.stringify(binding)
    if (scene?.factory === factory && scene.identity === identity) return scene.scope
    const scope = Promise.resolve().then(async () => {
      const receiver = await factory.bind(binding)
      requireIsolationWorkspaceScope(receiver)
      return receiver
    })
    const current: Scene = { factory, identity, scope }
    scene = current
    void scope.catch(() => {
      if (scene === current) scene = undefined
    })
    return scope
  }
  return {
    scope: scopeFor,
    async restore(input) {
      const scope = await scopeFor()
      return workspaceView(scope, await scope.restore(input))
    },
  }
}

export function restoredSubmodules(
  input: Record<
    string,
    {
      subBases: Record<string, string>
      poolDirs?: Record<string, string>
      pendingSubResolves?: string[]
    }
  >,
): NonNullable<IsolationRestoreInput['submodules']> {
  return Object.fromEntries(
    Object.entries(input).map(([mount, value]) => [
      mount,
      {
        submoduleBases: value.subBases,
        ...(value.poolDirs === undefined ? {} : { poolRefs: value.poolDirs }),
        ...(value.pendingSubResolves === undefined
          ? {}
          : { pendingSubResolutions: value.pendingSubResolves }),
      },
    ]),
  )
}
