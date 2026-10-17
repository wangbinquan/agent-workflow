// RFC-370 §9.2 V3 — where the employee Case workspace use cases execute.
//
// Standalone runs each use case in this process over per-step effects. A
// hosted deployment keeps Case scenes in a remote task volume: each whole use
// case is ONE operation there, calling the same application function with the
// volume's native step effects instead of one round trip per file.
import type {
  checkpointEmployeeCaseWorkspace,
  discardEmployeeCaseWorkspace,
  fetchEmployeeWorkspaceRemoteHead,
  importEmployeeWorkspaceCommit,
  materializeEmployeeCaseWorkspace,
  rematerializeEmployeeCaseWorkspace,
  resolveEmployeeWorkspaceBaseline,
  restoreEmployeeCaseWorkspace,
} from '../employeeCaseWorkspace'
import type { EmployeeCaseWorkspaceStepEffectsFactory } from './employeeCaseWorkspaceEffects'

type Operation<F extends (input: never, effects: never) => unknown> = (
  input: Parameters<F>[0],
) => ReturnType<F>

export interface EmployeeCaseWorkspaceOperations {
  materialize: Operation<typeof materializeEmployeeCaseWorkspace>
  rematerialize: Operation<typeof rematerializeEmployeeCaseWorkspace>
  /** Fetches with the environment's own Git credentials. */
  fetchRemoteHead: Operation<typeof fetchEmployeeWorkspaceRemoteHead>
  checkpoint: Operation<typeof checkpointEmployeeCaseWorkspace>
  restore: Operation<typeof restoreEmployeeCaseWorkspace>
  discard: Operation<typeof discardEmployeeCaseWorkspace>
  resolveBaseline: Operation<typeof resolveEmployeeWorkspaceBaseline>
  importCommit: Operation<typeof importEmployeeWorkspaceCommit>
}

export const EMPLOYEE_CASE_WORKSPACE_OPERATIONS = [
  'materialize',
  'rematerialize',
  'fetchRemoteHead',
  'checkpoint',
  'restore',
  'discard',
  'resolveBaseline',
  'importCommit',
] as const satisfies readonly (keyof EmployeeCaseWorkspaceOperations)[]

export interface EmployeeCaseWorkspaceOperationHost {
  readonly operations: EmployeeCaseWorkspaceOperations
}

/** The deployment's Case workspace selection: in-process per-step effects, or
 * a host that runs each whole use case where the scene lives. */
export type EmployeeCaseWorkspaceEffectsFactory =
  | EmployeeCaseWorkspaceStepEffectsFactory
  | EmployeeCaseWorkspaceOperationHost

export function isEmployeeCaseWorkspaceOperationHost(
  selected: EmployeeCaseWorkspaceEffectsFactory,
): selected is EmployeeCaseWorkspaceOperationHost {
  return 'operations' in selected
}
