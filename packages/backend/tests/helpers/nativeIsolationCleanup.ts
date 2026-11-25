// RFC-585 — native isolation handles in tests.
//
// Tests that build a node isolation workspace straight from the implementation (`createNodeIso`) hold a handle with no
// Source Control scope. Production creates every handle through a scope, so Task Execution's cleanup binding no longer
// falls back to the native discard for scope-less handles; this helper keeps that fallback for tests only (handles that
// do carry a scope still go through Task Execution's view, exactly as before).
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { IsolationCleanupBinding } from '@/modules/task-execution/application/ports/executionKernel'
import { bindIsolationCleanup } from '@/modules/task-execution/infrastructure/executionKernelBinding'
import { workspaceRecord } from '@/modules/task-execution/infrastructure/isolationWorkspaceView'
import { discardIsolationWorkspace } from '@/modules/source-control/infrastructure/local/nodeIsolation'

function hasRetainedScope(handle: IsoHandle): boolean {
  try {
    workspaceRecord(handle)
    return true
  } catch {
    return false
  }
}

/** Task Execution's cleanup binding, with the native discard for scope-less (test-built) handles. */
export function nativeIsolationCleanup(): IsolationCleanupBinding {
  const binding = bindIsolationCleanup()
  return {
    cleanupEffectFactory: (taskId) => binding.cleanupEffectFactory(taskId),
    discardIsolatedWorkspace: (handle, ...args) =>
      hasRetainedScope(handle)
        ? binding.discardIsolatedWorkspace(handle, ...args)
        : discardIsolationWorkspace(handle, ...args),
  }
}
