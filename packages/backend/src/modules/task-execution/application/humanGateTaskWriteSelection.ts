import type { TaskExecutionPersistence } from './ports/taskExecutionPersistence'
import type {
  HumanGateTaskLifecycle,
  HumanGateTaskWritePurposes,
} from './ports/humanGateTaskLifecycle'

type Selection = Pick<
  TaskExecutionPersistence,
  'humanGateLifecycle' | 'humanGateWriteMode' | 'humanGateWritePurposes'
>

/** Resolve the original binding as part of HumanGate write selection. */
export function requireHumanGateTaskHostBinding<T>(
  binding: T | undefined,
  selected: boolean,
): T | undefined {
  if (selected && binding === undefined) {
    throw new Error('human-gate-task-host-binding-not-composed')
  }
  return binding
}

export function selectHumanGateTaskWrites(
  persistence: Selection,
  purpose: keyof HumanGateTaskWritePurposes,
): HumanGateTaskLifecycle {
  if (
    persistence.humanGateWriteMode === undefined &&
    persistence.humanGateWritePurposes === undefined
  )
    return persistence.humanGateLifecycle
  const view = persistence.humanGateWritePurposes?.[purpose]
  if (view === undefined) throw new Error('human-gate-task-write-purposes-not-composed')
  return view
}
