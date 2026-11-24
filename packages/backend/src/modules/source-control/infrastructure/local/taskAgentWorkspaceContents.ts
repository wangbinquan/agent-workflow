import { ulid } from 'ulid'
import { resolveBoundaryMounts } from '../../domain/taskAgentMounts'

/**
 * RFC-563: content references in this module's own shapes. A reference handed in is only read for its `reference`; the
 * ones issued here name Source Control as their owner. The material compiler's reference type is not named.
 */
interface WorkspaceContentReference {
  readonly reference: string
}
interface IssuedMountReference extends WorkspaceContentReference {
  readonly owner: 'source-control'
  readonly version: null
}

/** Local Source Control interprets its stored working/mount dialect. Only
 * owner-issued references leave this receiver for material compilation. */
export function createLocalTaskAgentWorkspaceContents(input: {
  workspaceRef(): string
  taskMountRefs(): readonly string[]
}) {
  const locations = new Map<string, string>()
  function bind(reference: WorkspaceContentReference, workspaceRef: string) {
    locations.set(reference.reference, workspaceRef)
  }
  function workingDirectory(reference: string): string {
    const location = locations.get(reference)
    if (location === undefined) throw new Error('task-agent-workspace-reference-unavailable')
    return location
  }
  return Object.freeze({
    bindWorking(reference: WorkspaceContentReference) {
      bind(reference, input.workspaceRef())
    },
    workingDirectory,
    workspace(reference: WorkspaceContentReference) {
      return workingDirectory(reference.reference)
    },
    prepareMounts(): readonly IssuedMountReference[] {
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
