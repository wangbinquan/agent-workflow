import { createReadStream, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { requireWorkPathWithoutSymlinks } from '@/platform/crewstation/workVolumePath'
import { assertWorkVolumeWritersSettled } from '@/platform/crewstation/workVolumeWriters'
import { createSha256DigestBuilder } from '@/util/hash'
import { assertSameFileIdentityForHost } from '@/util/fileTrust'

const Request = z
  .object({
    kind: z.enum(['runs', 'logs']),
    taskId: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()
export async function executeTaskImageArchive(value: unknown, volumeRoot = '/work') {
  const input = Request.parse(value)
  const root = requireWorkPathWithoutSymlinks(
    join(volumeRoot, input.kind, input.taskId),
    volumeRoot,
  )
  assertWorkVolumeWritersSettled(volumeRoot, volumeRoot)
  const files: { path: string; size: number; sha256: string }[] = []
  const visit = async (path: string, relative: string): Promise<void> => {
    const before = lstatSync(path)
    if (before.isDirectory()) {
      for (const name of readdirSync(path).sort())
        await visit(join(path, name), relative ? `${relative}/${name}` : name)
      return
    }
    if (!before.isFile()) throw new Error('hosted-archive-special-file-refused')
    if (files.length >= 100_000) throw new Error('hosted-archive-file-count-exceeded')
    const hash = createSha256DigestBuilder()
    let size = 0
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      size += chunk.length
      hash.update(chunk)
    }
    const after = lstatSync(path)
    if (
      size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      !assertSameFileIdentityForHost(before, after).trusted
    )
      throw new Error('hosted-archive-source-changed')
    files.push({ path: relative, size, sha256: hash.digestHex() })
  }
  const exists = lstatSync(root, { throwIfNoEntry: false }) !== undefined
  if (exists) await visit(root, '')
  return { exists, files }
}
