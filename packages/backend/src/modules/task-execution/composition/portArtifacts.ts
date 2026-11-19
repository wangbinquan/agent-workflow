import { Paths } from '@/util/paths'
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
  requirePortArtifactOperations,
  requirePortArtifactReader,
  runNativePortArtifactPolicy,
  runPortArtifactPolicy,
} from '../application/portArtifacts'
import { createFilePortArtifactContent } from '../infrastructure/local/filePortArtifactContent'
export {
  requirePortArtifactContentEffects,
  requirePortArtifactOperations,
} from '../application/portArtifacts'

/** Undefined alone selects one complete native binding without performing IO. */
export function composePortArtifactOperations(
  selected?: PortArtifactContentEffects,
  appHome: string = Paths.root,
): PortArtifactOperations {
  const content = selected === undefined ? createFilePortArtifactContent(appHome) : selected
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

export function selectPortArtifactOperations(
  selected?: PortArtifactOperations,
  appHome: string = Paths.root,
): PortArtifactOperations {
  const operations =
    selected === undefined ? composePortArtifactOperations(undefined, appHome) : selected
  requirePortArtifactOperations(operations)
  return operations
}

/** Read-only consumers receive the original selected reader, with no per-method fallback. */
export function selectPortArtifactReader(
  selected?: PortArtifactReader,
  appHome: string = Paths.root,
): PortArtifactReader {
  const reader =
    selected === undefined ? composePortArtifactOperations(undefined, appHome) : selected
  requirePortArtifactReader(reader)
  return reader
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
