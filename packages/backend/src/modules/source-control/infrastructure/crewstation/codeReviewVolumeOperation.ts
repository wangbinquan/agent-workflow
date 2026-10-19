// RFC-370 §10 V16 — the task-image side of hosted code-review reads. The same
// local revision content the standalone daemon uses runs against the volume;
// a result too large for the outcome file is written to the volume scratch and
// read back by the control plane with the platform file API, then released.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import { bindLocalRepositoryRevisionContent } from '../local/repositoryRevisionContent'
import {
  CODE_REVIEW_INLINE_BYTES,
  CODE_REVIEW_SCRATCH_TTL_MS,
  type CodeReviewOutcome,
  type CodeReviewVolumeRequest,
  type CodeReviewVolumeResults,
} from './codeReviewProtocol'

function pruneScratch(scratch: string, now: number): void {
  let names: string[]
  try {
    names = readdirSync(scratch)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(scratch, name)
    try {
      if (now - statSync(file).mtimeMs > CODE_REVIEW_SCRATCH_TTL_MS) rmSync(file, { force: true })
    } catch {
      // a concurrent release removed it
    }
  }
}

async function answer(
  request: Exclude<CodeReviewVolumeRequest, { method: 'release' }>,
  root: string,
) {
  const content = bindLocalRepositoryRevisionContent(requireWorkPath(request.path, root))
  switch (request.method) {
    case 'presence':
      return (await content.presence()) satisfies CodeReviewVolumeResults['presence']
    case 'changes': {
      const changes = await content.changes({
        from: request.from,
        ...(request.to === undefined ? {} : { to: request.to }),
        ...(request.lineStats === true ? { lineStats: true } : {}),
      })
      const result: CodeReviewVolumeResults['changes'] = {
        entries: changes.entries,
        ...(changes.lineStats === undefined
          ? {}
          : {
              lineStats: [...changes.lineStats].map(
                ([path, stat]) => [path, stat.added, stat.removed] as const,
              ),
            }),
      }
      return result
    }
    case 'read-revision':
      return [
        ...(await content.readRevision({
          rev: request.rev,
          paths: request.paths,
          maxBytes: request.maxBytes,
        })),
      ] satisfies CodeReviewVolumeResults['read-revision']
    case 'grep':
      return [...(await content.grep(request.patterns))] satisfies CodeReviewVolumeResults['grep']
    case 'class-index':
      return [...(await content.classIndex())] satisfies CodeReviewVolumeResults['class-index']
    case 'snapshot-digest':
      return (await content.snapshotDigest()) satisfies CodeReviewVolumeResults['snapshot-digest']
    default:
      throw new Error('hosted-code-review-method-unknown')
  }
}

export async function executeCodeReviewVolumeOperation(
  value: unknown,
  root: string,
  now: () => number = Date.now,
): Promise<CodeReviewOutcome | null> {
  const request = value as CodeReviewVolumeRequest
  const scratch = requireWorkPath(join(root, 'tmp', 'code-review'), root)
  if (request.method === 'release') {
    const file = requireWorkPath(request.file, root)
    if (dirname(file) !== scratch || !file.endsWith('.json'))
      throw new Error('hosted-code-review-file-invalid')
    rmSync(file, { force: true })
    return null
  }
  const result = await answer(request, root)
  const json = JSON.stringify(result)
  if (Buffer.byteLength(json) <= CODE_REVIEW_INLINE_BYTES) return { value: result }
  // A whole class index or a batch of revision blobs is read back with the
  // platform file API, never through the outcome file.
  mkdirSync(scratch, { recursive: true })
  pruneScratch(scratch, now())
  const file = join(scratch, `${randomUUID()}.json`)
  writeFileSync(file, json)
  return { resultFile: file }
}
