import type {
  ArchivePortArtifactsResult,
  NativeArchivePortArtifactsOptions,
  NativeReadPortArtifactOptions,
  PortArtifactArchiveRequest,
  PortArtifactContentEffects,
  PortArtifactOperations,
  PortArtifactReader,
  PortArtifactReadItem,
  PortArtifactReadRequest,
  PortArtifactWorkspaceFile,
} from '../application/ports/portArtifactContent'
import {
  archivePortArtifactPolicy,
  readPortArtifactPolicy,
  requirePortArtifactContentEffects,
  requirePortArtifactReader,
  runNativePortArtifactPolicy,
  runPortArtifactPolicy,
} from '../application/portArtifacts'
import { createFilePortArtifactContent } from '../infrastructure/local/filePortArtifactContent'
export {
  requirePortArtifactContentEffects,
  requirePortArtifactOperations,
} from '../application/portArtifacts'
/** RFC-526: the standalone selection's port artifact content — local archive files under an app home. */
export { createFilePortArtifactContent }

/** RFC-526: the caller's port artifact content (standalone: `createFilePortArtifactContent(appHome)`; no IO here). */
export function composePortArtifactOperations(
  content: PortArtifactContentEffects,
): PortArtifactOperations {
  requirePortArtifactContentEffects(content)
  return Object.freeze({
    async archive(request: PortArtifactArchiveRequest) {
      return await runPortArtifactPolicy(archivePortArtifactPolicy(content, request))
    },
    async read(request: PortArtifactReadRequest) {
      return await runPortArtifactPolicy(readPortArtifactPolicy(content, request))
    },
  })
}

/**
 * Read-only consumers receive the original selected reader, with no per-method fallback. RFC-526: the selection is
 * required (the daemon always gives it); this only checks it is complete.
 */
export function selectPortArtifactReader(selected: PortArtifactReader): PortArtifactReader {
  requirePortArtifactReader(selected)
  return selected
}

/** Preserve every original native input location without exposing it to the neutral policy. */
export function archivePortArtifacts(
  opts: NativeArchivePortArtifactsOptions,
): ArchivePortArtifactsResult {
  const locations = new WeakMap<PortArtifactWorkspaceFile, string>()
  const items = opts.items.map((it) => {
    const source: PortArtifactWorkspaceFile = {
      workspaceRef: opts.worktreeRootAbs,
      relativePath: it.sourcePath,
    }
    locations.set(source, it.sourceAbs)
    return { source, sourcePath: it.sourcePath }
  })
  return runNativePortArtifactPolicy(
    archivePortArtifactPolicy(createFilePortArtifactContent(opts.appHome, locations), {
      taskId: opts.taskId,
      nodeRunId: opts.nodeRunId,
      portName: opts.portName,
      items,
      mountPath: opts.mountPath,
    }),
  )
}

export function readPortArtifact(opts: NativeReadPortArtifactOptions): {
  items: PortArtifactReadItem[]
} {
  return runNativePortArtifactPolicy(
    readPortArtifactPolicy(createFilePortArtifactContent(opts.appHome), {
      taskId: opts.taskId,
      archiveJson: opts.archiveJson,
      content: opts.content,
      kind: opts.kind,
      fallbackWorkspaceRef: opts.fallbackWorktreeRoot,
      ...(opts.legacyRepoDirName === undefined
        ? {}
        : { legacyRepoDirName: opts.legacyRepoDirName }),
      ...(opts.only === undefined ? {} : { only: opts.only }),
    }),
  )
}
