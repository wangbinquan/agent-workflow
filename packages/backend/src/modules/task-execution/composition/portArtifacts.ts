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
  runNativePortArtifactPolicy,
  runPortArtifactPolicy,
} from '../application/portArtifacts'
import { createFilePortArtifactContent } from '../infrastructure/local/filePortArtifactContent'

export function requirePortArtifactContentEffects(
  value: unknown,
): asserts value is PortArtifactContentEffects {
  const methods: readonly (keyof PortArtifactContentEffects)[] = [
    'prepareArchive',
    'reference',
    'size',
    'copy',
    'readPrefix',
    'write',
    'linkTarget',
    'readArchive',
    'existsArchive',
    'readWorkspace',
    'existsWorkspace',
  ]
  if (
    value === null ||
    typeof value !== 'object' ||
    methods.some((name) => typeof (value as PortArtifactContentEffects)[name] !== 'function')
  ) {
    throw new TypeError('Port artifacts require a complete content effects receiver')
  }
}

export function requirePortArtifactOperations(
  value: unknown,
): asserts value is PortArtifactOperations {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as PortArtifactOperations).archive !== 'function' ||
    typeof (value as PortArtifactOperations).read !== 'function'
  ) {
    throw new TypeError('Port artifacts require complete operations')
  }
}

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
  if (reader === null || typeof reader !== 'object' || typeof reader.read !== 'function') {
    throw new TypeError('Port artifacts require a complete reader')
  }
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
      worktreeDirName: opts.worktreeDirName,
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
