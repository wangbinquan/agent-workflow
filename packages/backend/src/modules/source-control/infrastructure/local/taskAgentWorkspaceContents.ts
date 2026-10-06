import { ulid } from 'ulid'
import type { AgentMaterialContentReference } from '@/modules/runtime-management/public/participants'
import { resolveBoundaryMounts } from '@/services/execution/workspaceBoundary'

/** Local Source Control interprets its stored working/mount dialect. Only
 * owner-issued references leave this receiver for material compilation. */
export function createLocalTaskAgentWorkspaceContents(input: {
  workspaceRef(): string
  taskMountRefs(): readonly string[]
}) {
  const locations = new Map<string, string>()
  function bind(reference: AgentMaterialContentReference, workspaceRef: string) {
    locations.set(reference.reference, workspaceRef)
  }
  function workingDirectory(reference: string): string {
    const location = locations.get(reference)
    if (location === undefined) throw new Error('task-agent-workspace-reference-unavailable')
    return location
  }
  return Object.freeze({
    bindWorking(reference: AgentMaterialContentReference) {
      bind(reference, input.workspaceRef())
    },
    workingDirectory,
    workspace(reference: AgentMaterialContentReference) {
      return workingDirectory(reference.reference)
    },
    prepareMounts(): readonly AgentMaterialContentReference[] {
      const mounts = resolveBoundaryMounts(input.workspaceRef(), input.taskMountRefs())
      return mounts.map((location) => {
        const reference = Object.freeze({
          owner: 'source-control' as const,
          reference: `aw-task-mount:${ulid()}`,
          version: null,
        })
        bind(reference, location)
        return reference
      })
    },
  })
}
