import { parse as parsePath } from 'node:path'
import { isPlatformWorkspacePath, sanitizeUploadFilename } from '@agent-workflow/shared'
import type {
  WorkspaceUploadContent,
  WorkspaceUploadContentFactory,
} from '@/modules/source-control/public/types'
import {
  requireWorkspaceUploadContent,
  selectWorkspaceUploadContentFactory,
} from '@/modules/source-control/public/participants'
import { ValidationError } from '@/util/errors'
import { validateUploadPlan } from '../domain/uploads'
import type { WorkspaceUploadPlan, WorkspaceUploadResult } from './ports/workspaceUploads'

type UploadEffect = () => unknown
type Policy<T> = Generator<UploadEffect, T, unknown>

function* effect<T>(call: () => T | Promise<T>): Policy<T> {
  return (yield call) as T
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

/** Sync native batches finish before returning; asynchronous ACKs return to the same policy. */
export async function runWorkspaceUploadPolicy<T>(policy: Policy<T>): Promise<T> {
  let step = policy.next()
  while (!step.done) {
    let value: unknown
    try {
      value = step.value()
      if (isThenable(value)) value = await value
    } catch (error) {
      step = policy.throw(error)
      continue
    }
    step = policy.next(value)
  }
  return step.value
}

function* uniqueNamePolicy(
  filename: string,
  isTaken: (candidate: string) => Policy<boolean>,
): Policy<string> {
  if (!(yield* isTaken(filename))) return filename
  const { name, ext } = parsePath(filename)
  for (let i = 1; i < 1000; i++) {
    const candidate = `${name} (${i})${ext}`
    if (!(yield* isTaken(candidate))) return candidate
  }
  throw new ValidationError(
    'upload-name-clash',
    `cannot pick a non-clashing name for '${filename}' after 999 attempts`,
  )
}

/** Native legacy helper probes the same naming policy without preparing a directory. */
export function resolveUniqueUploadNameSync(
  filename: string,
  isTaken: (candidate: string) => boolean,
): string {
  const policy = uniqueNamePolicy(filename, (candidate) => effect(() => isTaken(candidate)))
  let step = policy.next()
  while (!step.done) step = policy.next(step.value())
  return step.value
}

export function* workspaceUploadPolicy(
  plan: WorkspaceUploadPlan,
  selected?: WorkspaceUploadContentFactory,
): Policy<WorkspaceUploadResult> {
  const { defs, files, limits } = plan
  validateUploadPlan({ defs, files, limits })
  const factory = selectWorkspaceUploadContentFactory(selected)
  const content: WorkspaceUploadContent = yield* effect(() => factory.bind(plan.workspace))
  requireWorkspaceUploadContent(content)
  const written: string[] = []
  const packedByKey = new Map<string, string[]>()
  for (const def of defs.values()) packedByKey.set(def.key, [])
  let idx = 0
  try {
    for (const f of files) {
      idx++
      const def = defs.get(f.inputKey)!
      const effectiveTarget =
        plan.inputsSubdir !== undefined &&
        plan.inputsSubdir !== '' &&
        !isPlatformWorkspacePath(def.targetDir)
          ? `${plan.inputsSubdir}/${def.targetDir}`
          : def.targetDir
      const target = yield* effect(() => content.prepareTarget(effectiveTarget))
      const safeName = sanitizeUploadFilename(f.filename, idx)
      const restoredName = plan.recovery?.placement(idx - 1) ?? null
      let finalName: string
      if (restoredName !== null) {
        finalName = restoredName
      } else if ((def.onConflict ?? 'rename') === 'overwrite') {
        const fileRef = yield* effect(() => content.file(target.directoryRef, safeName))
        const entry = yield* effect(() => content.entry(fileRef))
        if (entry !== 'missing') {
          if (entry === 'directory') {
            throw new ValidationError(
              'upload-target-is-dir',
              `cannot overwrite '${safeName}': a directory already exists at that path`,
            )
          }
          yield* effect(() => content.remove(fileRef))
        }
        finalName = safeName
      } else {
        finalName = yield* uniqueNamePolicy(safeName, function* (candidate) {
          const fileRef = yield* effect(() => content.file(target.directoryRef, candidate))
          return (yield* effect(() => content.entry(fileRef))) !== 'missing'
        })
      }
      const fileRef = yield* effect(() => content.file(target.directoryRef, finalName))
      if (restoredName === null && plan.recovery !== undefined)
        yield* effect(() => plan.recovery!.reserve(idx - 1, finalName))
      const existing =
        restoredName === null ? 'missing' : yield* effect(() => content.entry(fileRef))
      if (existing !== 'missing') {
        if (existing !== 'file' || !sameBytes(yield* effect(() => content.read(fileRef)), f.bytes))
          throw new ValidationError(
            'upload-replay-changed',
            'an interrupted upload path contains different content',
          )
      } else {
        yield* effect(() => content.write(fileRef, f.bytes))
        written.push(fileRef)
      }
      const rel = target.packedDirectory
      const packed = rel === '.' || rel === '' ? finalName : `${rel}/${finalName}`
      packedByKey.get(def.key)!.push(packed)
    }
  } catch (err) {
    for (const fileRef of written) {
      try {
        yield* effect(() => content.remove(fileRef))
      } catch {
        // Best-effort cleanup; preserve the original upload failure.
      }
    }
    throw err
  }
  return { packedByKey }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}
