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

/**
 * RFC-431: the standalone requirement purpose's writer. The standalone profile is built before the
 * startup lock and its selections perform no IO, so the staging root is created by the first write.
 */
export function createFileEvidenceDocumentCommandsOnFirstWrite(deps: {
  readonly stagingRoot: string
  readonly evidence: Pick<EvidenceStore, 'importStagedTree'>
}): EvidenceDocumentCommands {
  let commands: EvidenceDocumentCommands | undefined
  return Object.freeze<EvidenceDocumentCommands>({
    writeDocument: (input) =>
      (commands ??= createFileEvidenceDocumentCommands(deps)).writeDocument(input),
  })
}
