import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewArtifactContentPort } from '../../application/ports/reviewArtifactContent'

export function createFileReviewArtifactContent(appHome: string): ReviewArtifactContentPort {
  return Object.freeze({
    async read(reference: string) {
      const path = join(appHome, ...reference.split('/'))
      return existsSync(path) ? { body: readFileSync(path), label: path } : null
    },
  })
}
