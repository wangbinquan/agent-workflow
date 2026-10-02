import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { EvidenceDocumentCommands } from '../../application/evidenceDocumentCommands'
import type { EvidenceStore } from '../evidenceStore'

/** Standalone one-shot staging, import and cleanup retain their original order. */
export function createFileEvidenceDocumentCommands(deps: {
  readonly stagingRoot: string
  readonly evidence: Pick<EvidenceStore, 'importStagedTree'>
}): EvidenceDocumentCommands {
  mkdirSync(deps.stagingRoot, { recursive: true })
  return {
    async writeDocument(input) {
      const directory = join(deps.stagingRoot, ulid())
      mkdirSync(directory, { recursive: true })
      try {
        writeFileSync(join(directory, input.relativePath), input.content)
        return await deps.evidence.importStagedTree(directory, input.budget)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}
