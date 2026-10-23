import { legacyReviewAbsolutePath } from '@/platform/content/legacyReview'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ReviewArtifactContentPort } from '../../application/ports/reviewArtifactContent'

export function createFileReviewArtifactContent(appHome: string): ReviewArtifactContentPort {
  return Object.freeze({
    async read(reference: string) {
      const path = legacyReviewAbsolutePath(appHome, reference)
      return existsSync(path) ? { body: readFileSync(path), label: path } : null
    },
  })
}

/** The pre-journal repair path keeps its original direct local overwrite behavior. */
export function writeLegacyReviewBody(appHome: string, reference: string, body: string): void {
  const path = legacyReviewAbsolutePath(appHome, reference)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
}
