import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AttemptContextStorePort } from '../../application/ports/attemptContextStore'
import type { EvidenceStore } from '../evidenceStore'

export function createAttemptContextStore(evidence: EvidenceStore) {
  return {
    async save(json) {
      const staging = mkdtempSync(join(tmpdir(), 'aw-attempt-ctx-'))
      try {
        const file = join(staging, 'context.json')
        writeFileSync(file, json)
        const blob = await evidence.putBlobFromFile(file)
        return blob.sha256
      } finally {
        rmSync(staging, { recursive: true, force: true })
      }
    },
    load(ref) {
      if (!/^[0-9a-f]{64}$/.test(ref)) return null
      const path = evidence.blobPath(ref)
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
  } satisfies AttemptContextStorePort
}
