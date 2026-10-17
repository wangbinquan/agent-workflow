import { isAbsolute, join, posix } from 'node:path'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { HostedObjectPublications } from '@/modules/system-operations/public/participants'
import type { CrewStationStreamObjectStorage } from '@/platform/crewstation/objectStorage'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { createDevelopmentObjectIndex } from '../infrastructure/crewstation/objectIndex'
import {
  createCrewStationEvidenceArtifacts,
  assertEvidenceRelativePath,
} from '../infrastructure/crewstation/evidenceArtifacts'
import { inspectEvidenceFile, scanEvidenceTree } from '../infrastructure/local/evidenceFileFacts'

export function composeCrewStationDevelopmentEvidence(input: {
  readonly db: ProviderNeutralDatabase
  readonly objects: CrewStationStreamObjectStorage
  readonly publications: HostedObjectPublications
  readonly helper: WorkspaceHelper
  readonly locate: (ref: string) => { taskId: string; path: string }
  readonly reference: (taskId: string, path: string) => string
  readonly openFile: (ref: string) => Promise<ReadableStream<Uint8Array>>
  readonly writeFile: (
    ref: string,
    stream: ReadableStream<Uint8Array>,
    facts: { size: number; sha256: string },
  ) => Promise<void>
}) {
  const remote = (reference: string) => reference.startsWith('cs-workspace:')
  const selected = createCrewStationEvidenceArtifacts({
    objects: input.objects,
    index: createDevelopmentObjectIndex(input),
    publications: input.publications,
    files: {
      async inspect(reference) {
        if (!remote(reference)) {
          // HTTP upload staging only. Persistent application paths are opaque CS refs.
          if (!isAbsolute(reference)) throw new Error('hosted-evidence-source-reference-required')
          return {
            ...(await inspectEvidenceFile(reference)),
            open: () => Bun.file(reference).stream(),
          }
        }
        const source = input.locate(reference)
        const facts = await input.helper.call<{ size: number; sha256: string }>(
          source.taskId,
          'evidence-files',
          { method: 'inspect', path: source.path },
        )
        return { ...facts, open: () => input.openFile(reference) }
      },
      async scan(root, budget) {
        if (!remote(root)) {
          if (!isAbsolute(root)) throw new Error('hosted-evidence-source-reference-required')
          return scanEvidenceTree(root, budget)
        }
        const source = input.locate(root)
        const files = await input.helper.call<
          { relativePath: string; reference: string; size: number }[]
        >(source.taskId, 'evidence-files', {
          method: 'scan',
          path: source.path,
          budget,
        })
        return files.map((file) => ({
          ...file,
          reference: input.reference(source.taskId, file.reference),
        }))
      },
      write: input.writeFile,
      join(root, relativePath) {
        assertEvidenceRelativePath(relativePath)
        if (!remote(root)) return join(root, relativePath)
        const source = input.locate(root)
        return input.reference(source.taskId, posix.join(source.path, relativePath))
      },
    },
  })
  return {
    evidenceArtifacts: selected.artifacts,
    evidenceRead: {
      contents: selected.artifacts.contents,
      documents: selected.artifacts.documents,
      downloads: selected.artifacts.downloads,
    },
    evidenceDocumentCommands: selected.documents,
  }
}
