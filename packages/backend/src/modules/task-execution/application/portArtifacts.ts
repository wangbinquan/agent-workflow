import type { TaskArtifactPathQueries } from './ports/taskArtifactPathQueries'
import { extname, join } from 'node:path'
import { WORKTREE_FILE_MAX_BYTES, tryParseKind, splitPortItems } from '@agent-workflow/shared'
import { createLogger } from '@/util/log'
import { parseArchiveJson, truncationNotice } from '../domain/portArtifacts'
import type {
  ArchivePortArtifactsResult,
  PortArchive,
  PortArchiveItem,
  PortArtifactArchiveRequest,
  PortArtifactContentEffects,
  PortArtifactReadItem,
  PortArtifactReadRequest,
} from './ports/portArtifactContent'

const log = createLogger('port-artifacts')
const EMPTY_BYTES: Uint8Array = Buffer.alloc(0)
type ContentRequest = () => unknown
type Policy<T> = Generator<ContentRequest, T, unknown>

function* effect<T>(call: () => T | Promise<T>): Policy<T> {
  return (yield call) as T
}

/** One policy, interpreted synchronously only for the original native helpers. */
export function runNativePortArtifactPolicy<T>(policy: Policy<T>): T {
  let step = policy.next()
  while (!step.done) {
    let value: unknown
    try {
      value = step.value()
    } catch (error) {
      step = policy.throw(error)
      continue
    }
    step = policy.next(value)
  }
  return step.value
}

/** Await also assimilates object/callable thenables; rejection returns to the policy. */
export async function runPortArtifactPolicy<T>(policy: Policy<T>): Promise<T> {
  let step = policy.next()
  while (!step.done) {
    let value: unknown
    try {
      value = await step.value()
    } catch (error) {
      step = policy.throw(error)
      continue
    }
    step = policy.next(value)
  }
  return step.value
}

export function* archivePortArtifactPolicy(
  content: PortArtifactContentEffects,
  opts: PortArtifactArchiveRequest,
): Policy<ArchivePortArtifactsResult> {
  yield* effect(() => content.prepareArchive(opts))
  const items: PortArchiveItem[] = []
  const portFilePaths: string[] = []
  for (let i = 0; i < opts.items.length; i++) {
    const it = opts.items[i]!
    const containerRel = toContainerRelative(opts.worktreeDirName, it.sourcePath)
    const size = yield* effect(() => content.size(it.source))
    const reference = content.reference(opts, i, extname(it.sourcePath))
    if (size <= WORKTREE_FILE_MAX_BYTES) {
      yield* effect(() => content.copy(it.source, reference))
      items.push({ path: containerRel, file: reference, size, truncated: false })
    } else if ((yield* effect(() => content.readPrefix(it.source, 8192))).includes(0)) {
      items.push({ path: containerRel, file: null, size, truncated: true })
    } else {
      const head = yield* effect(() => content.readPrefix(it.source, WORKTREE_FILE_MAX_BYTES))
      yield* effect(() =>
        content.write(
          reference,
          Buffer.concat([head, Buffer.from(truncationNotice(containerRel))]),
        ),
      )
      items.push({ path: containerRel, file: reference, size, truncated: true })
    }
    portFilePaths.push(it.sourcePath)
    try {
      const target = yield* effect(() => content.linkTarget(it.source))
      if (target?.kind === 'inside') {
        portFilePaths.push(target.relativePath)
        const last = items[items.length - 1]
        if (last !== undefined) {
          last.linkTarget = toContainerRelative(opts.worktreeDirName, target.relativePath)
        }
      } else if (target?.kind === 'outside') {
        log.warn('symlink port target outside worktree — workspace semantics not guaranteed', {
          port: opts.portName,
          source: it.sourcePath,
        })
      }
    } catch {
      // Original metadata failure behavior: leave the file roster as it stands.
    }
  }
  const archive: PortArchive = { v: 1, items }
  return { archiveJson: JSON.stringify(archive), portFilePaths }
}

function* readableBytes(
  call: () => Uint8Array | null | Promise<Uint8Array | null>,
): Policy<Buffer | null> {
  try {
    const bytes = yield* effect(call)
    return bytes === null ? null : Buffer.from(bytes)
  } catch {
    return null
  }
}

function* readableExists(call: () => boolean | Promise<boolean>): Policy<boolean> {
  try {
    return yield* effect(call)
  } catch {
    return false
  }
}

export function* readPortArtifactPolicy(
  content: PortArtifactContentEffects,
  opts: PortArtifactReadRequest,
): Policy<{ items: PortArtifactReadItem[] }> {
  const wantBytes = (idx: number): boolean =>
    opts.only === undefined ? true : opts.only === 'meta' ? false : opts.only === idx
  const archive = parseArchiveJson(opts.archiveJson)
  const items: PortArtifactReadItem[] = []
  if (archive !== null) {
    for (let idx = 0; idx < archive.items.length; idx++) {
      const it = archive.items[idx]!
      if (it.file !== null) {
        if (!wantBytes(idx)) {
          if (yield* readableExists(() => content.existsArchive(opts.taskId, it.file!))) {
            items.push({
              path: it.path,
              body: '',
              bytes: EMPTY_BYTES,
              size: it.size,
              truncated: it.truncated,
              source: 'archive',
            })
            continue
          }
        } else {
          const buf = yield* readableBytes(() => content.readArchive(opts.taskId, it.file!))
          if (buf !== null) {
            items.push({
              path: it.path,
              body: buf.toString('utf8'),
              bytes: buf,
              size: it.size,
              truncated: it.truncated,
              source: 'archive',
            })
            continue
          }
        }
      }
      if (opts.fallbackWorkspaceRef !== null) {
        const source = { workspaceRef: opts.fallbackWorkspaceRef, relativePath: it.path }
        if (!wantBytes(idx)) {
          if (yield* readableExists(() => content.existsWorkspace(source))) {
            items.push({
              path: it.path,
              body: '',
              bytes: EMPTY_BYTES,
              size: it.size,
              truncated: false,
              source: 'worktree',
            })
            continue
          }
        } else {
          const buf = yield* readableBytes(() => content.readWorkspace(source))
          if (buf !== null) {
            items.push({
              path: it.path,
              body: buf.toString('utf8'),
              bytes: buf,
              size: it.size,
              truncated: false,
              source: 'worktree',
            })
            continue
          }
        }
      }
      items.push({
        path: it.path,
        body: '',
        bytes: EMPTY_BYTES,
        size: it.size,
        truncated: it.truncated,
        source: 'missing',
      })
    }
    return { items }
  }
  const parsed = opts.kind !== null ? tryParseKind(opts.kind) : null
  const isPathish =
    parsed !== null &&
    (parsed.kind === 'path' || (parsed.kind === 'list' && parsed.item.kind === 'path'))
  if (!isPathish) {
    const buf = Buffer.from(opts.content, 'utf8')
    return {
      items: [
        {
          path: null,
          body: opts.content,
          bytes: buf,
          size: buf.length,
          truncated: false,
          source: 'archive',
        },
      ],
    }
  }
  const lines =
    parsed.kind === 'list' ? splitPortItems(parsed, opts.content) : [opts.content.trim()]
  const dirName = opts.legacyRepoDirName ?? ''
  for (let idx = 0; idx < lines.length; idx++) {
    const containerRel = toContainerRelative(dirName, lines[idx]!)
    if (opts.fallbackWorkspaceRef !== null) {
      const source = { workspaceRef: opts.fallbackWorkspaceRef, relativePath: containerRel }
      if (!wantBytes(idx)) {
        if (yield* readableExists(() => content.existsWorkspace(source))) {
          items.push({
            path: containerRel,
            body: '',
            bytes: EMPTY_BYTES,
            size: 0,
            truncated: false,
            source: 'worktree',
          })
          continue
        }
      } else {
        const buf = yield* readableBytes(() => content.readWorkspace(source))
        if (buf !== null) {
          items.push({
            path: containerRel,
            body: buf.toString('utf8'),
            bytes: buf,
            size: buf.length,
            truncated: false,
            source: 'worktree',
          })
          continue
        }
      }
    }
    items.push({
      path: containerRel,
      body: '',
      bytes: EMPTY_BYTES,
      size: 0,
      truncated: false,
      source: 'missing',
    })
  }
  return { items }
}

export function portArchiveRootRel(taskId: string, nodeRunId: string): string {
  return join('runs', taskId, 'ports', nodeRunId)
}

export function toContainerRelative(worktreeDirName: string, repoRelPath: string): string {
  return worktreeDirName === '' ? repoRelPath : join(worktreeDirName, repoRelPath)
}

export async function forcedPortPathsForTask(
  queries: TaskArtifactPathQueries,
  taskId: string,
): Promise<string[]> {
  return [...(await queries.forcedPaths(taskId))]
}
