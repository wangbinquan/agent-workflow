import {
  TASK_ENGINE_KINDS,
  type TaskEngine,
  type TaskEngineKind,
  type TaskEngineRegistry,
} from '../../domain/taskEngine'

function assertClosedRegistry(engines: Readonly<Record<TaskEngineKind, TaskEngine>>): void {
  const actual = Object.keys(engines).sort()
  const expected = [...TASK_ENGINE_KINDS].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`task-engine-registry-keys:${actual.join(',')}`)
  }
  for (const kind of TASK_ENGINE_KINDS) {
    if (engines[kind].kind !== kind) throw new Error(`task-engine-registry-kind-mismatch:${kind}`)
  }
}

export class ClosedTaskEngineRegistry implements TaskEngineRegistry {
  constructor(private readonly engines: Readonly<Record<TaskEngineKind, TaskEngine>>) {
    assertClosedRegistry(engines)
  }

  resolve(kind: TaskEngineKind): TaskEngine {
    return this.engines[kind]
  }
}

export interface ResolvedTaskEngine {
  readonly engine: TaskEngineKind
  readonly wgDispatch: WorkgroupDispatch | null
}

export function resolveTaskEngineSelection(
  task: { readonly workgroupId?: string | null; readonly workgroupConfigJson?: string | null },
  dwPhase: DynamicWorkflowPhase | null,
): ResolvedTaskEngine {
  if (!isWorkgroupTask(task)) return { engine: 'dag', wgDispatch: null }
  const wgDispatch = deriveWorkgroupDispatch(
    workgroupModeOf(task.workgroupConfigJson) ?? 'leader_worker',
    dwPhase,
  )
  const engine: TaskEngineKind =
    wgDispatch === 'dw-generate'
      ? 'dw-generate'
      : wgDispatch === 'turn-engine'
        ? 'workgroup-turns'
        : 'dag'
  return { engine, wgDispatch }
}
import {
  deriveWorkgroupDispatch,
  isWorkgroupTask,
  workgroupModeOf,
  type DynamicWorkflowPhase,
  type WorkgroupDispatch,
} from '@agent-workflow/shared'
