import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { requireWorkPathWithoutSymlinks } from '@/platform/crewstation/workVolumePath'
import { assertWorkVolumeWritersSettled } from '@/platform/crewstation/workVolumeWriters'
import { inspectEvidenceFile, scanEvidenceTree } from '../infrastructure/local/evidenceFileFacts'

const Request = z.discriminatedUnion('method', [
  z.object({ method: z.literal('inspect'), path: z.string() }),
  z.object({
    method: z.literal('scan'),
    path: z.string(),
    budget: z.object({
      maxFiles: z.number().int().nonnegative(),
      maxFileBytes: z.number().int().nonnegative(),
      maxTotalBytes: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    method: z.literal('allocate'),
    id: z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/),
  }),
  z.object({
    method: z.literal('dispose'),
    id: z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/),
  }),
])

/** No symlink parent can redirect material reads or deletion outside /work. */
export function requireEvidenceWorkPath(path: string, root: string): string {
  return requireWorkPathWithoutSymlinks(path, root)
}

export async function executeTaskImageEvidence(value: unknown, root: string): Promise<unknown> {
  const input = Request.parse(value)
  if (input.method === 'allocate' || input.method === 'dispose') {
    const path = requireEvidenceWorkPath(join(root, 'evidence-staging', input.id), root)
    if (input.method === 'allocate') mkdirSync(path, { recursive: true })
    else {
      assertWorkVolumeWritersSettled(root, path)
      rmSync(path, { recursive: true, force: true })
    }
    return path
  }
  const path = requireEvidenceWorkPath(input.path, root)
  if (input.method === 'inspect') return inspectEvidenceFile(path)
  return scanEvidenceTree(path, input.budget)
}
