import { createReadStream, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EvidenceBudget } from '../../domain/evidence'
import { createSha256DigestBuilder } from '@/util/hash'

/** Shared native file mechanics: service-side use is limited to HTTP staging files. */
export async function inspectEvidenceFile(path: string): Promise<{ sha256: string; size: number }> {
  const stat = lstatSync(path)
  if (!stat.isFile()) throw new Error('hosted-evidence-not-regular-file')
  const hash = createSha256DigestBuilder()
  let size = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    hash.update(chunk)
    size += chunk.length
  }
  if (size !== stat.size) throw new Error('hosted-evidence-source-changed')
  return { sha256: hash.digestHex(), size }
}

export function scanEvidenceTree(root: string, budget: EvidenceBudget) {
  const files: { relativePath: string; reference: string; size: number }[] = []
  let total = 0
  const visit = (relativePath: string): void => {
    const reference = join(root, relativePath)
    const stat = lstatSync(reference)
    if (stat.isDirectory()) {
      for (const name of readdirSync(reference).sort())
        visit(relativePath ? `${relativePath}/${name}` : name)
      return
    }
    if (!stat.isFile()) throw new Error('hosted-evidence-not-regular-file')
    if (files.length >= budget.maxFiles) throw new Error('budget: too many files')
    if (stat.size > budget.maxFileBytes) throw new Error('budget: file too large')
    total += stat.size
    if (total > budget.maxTotalBytes) throw new Error('budget: total too large')
    files.push({ relativePath, reference, size: stat.size })
  }
  visit('')
  return files
}
