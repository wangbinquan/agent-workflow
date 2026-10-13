import {
  isHostExecutionGroupReady,
  type HostExecutionGroup,
  type HostExecutionStatus,
} from '@agent-workflow/shared'
import { DomainError } from '@/util/errors'
import type {
  HostExecutionAdmission,
  HostExecutionAdmissionLease,
} from '@/modules/system-operations/public/participants'
import type { HostExecutionStatusQuery } from '@/modules/system-operations/public/queries'
import type { HostExecutionRecoveryCommands } from '@/modules/system-operations/public/commands'

export interface HttpHostExecutionSelection {
  readonly queries: HostExecutionStatusQuery
  readonly admission: HostExecutionAdmission
  readonly recovery?: HostExecutionRecoveryCommands
}

/** Transport wiring holds no execution state. Each root supplies its own
 * read-only controller query, shared by HTTP and bound operation invocations. */
const roots = new WeakMap<
  object,
  {
    readonly read: () => HostExecutionStatus
    readonly acquire: HostExecutionAdmission['acquire']
  }
>()

export function bindHttpHostExecutionAvailability(
  root: object,
  selection: HttpHostExecutionSelection | undefined,
): void {
  if (selection === undefined) return
  if (roots.has(root)) throw new Error('http-host-execution-status-already-bound')
  if (
    typeof selection.queries?.readCurrent !== 'function' ||
    typeof selection.admission?.acquire !== 'function'
  )
    throw new Error('http-host-execution-selection-incomplete')
  roots.set(root, {
    read: selection.queries.readCurrent.bind(selection.queries),
    acquire: selection.admission.acquire.bind(selection.admission),
  })
}

export function requireHttpHostExecutionGroup(
  root: object,
  group: HostExecutionGroup | undefined,
): HostExecutionAdmissionLease | undefined {
  if (group === undefined) return
  const selected = roots.get(root)
  // An unselected native root retains its original admission mechanisms.
  if (selected === undefined) return
  const view = selected.read()
  if (view.mode === 'native') return
  if (isHostExecutionGroupReady(view, group)) {
    const acquired = selected.acquire(group)
    if (acquired.kind === 'admitted') return acquired.lease
  }
  throw new DomainError(
    'host-execution-unavailable',
    'The requested execution capability is not ready',
    503,
    {
      group,
      mode: view.mode,
      status: view.status,
    },
  )
}

/** This lease covers the original request/acceptance promise. Task, MCP and
 * other owners retain their own effect/result ACKs after an HTTP receipt. */
export async function runHttpHostExecutionRequest<T>(
  root: object,
  group: HostExecutionGroup | undefined,
  request: () => Promise<T>,
): Promise<T> {
  const lease = requireHttpHostExecutionGroup(root, group)
  try {
    return await request()
  } finally {
    lease?.complete()
  }
}

/** A business cancellation may finish while execution is unavailable. Its
 * optional next dispatch still needs its own actual request admission. */
export async function tryRunHttpHostExecutionRequest(
  root: object,
  group: HostExecutionGroup,
  request: () => Promise<unknown>,
): Promise<boolean> {
  let lease: HostExecutionAdmissionLease | undefined
  try {
    lease = requireHttpHostExecutionGroup(root, group)
  } catch (error) {
    if (error instanceof DomainError && error.code === 'host-execution-unavailable') return false
    throw error
  }
  try {
    await request()
    return true
  } finally {
    lease?.complete()
  }
}
