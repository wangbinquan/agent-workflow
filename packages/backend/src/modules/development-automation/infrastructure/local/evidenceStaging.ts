import { EvidenceStore } from '../evidenceStore'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { EvidenceArtifactPort } from '../../application/ports/evidenceArtifacts'
import type {
  EvidenceStagingFactory,
  EvidenceStagingLease,
  EvidenceStagingNamespace,
  EvidenceStagingReference,
} from '../../application/ports/evidenceStaging'

/** Bootstrap owns selection; the native content adapter owns physical construction. */
export function createLocalEvidenceArtifactPort(appHome: string): EvidenceArtifactPort {
  return new EvidenceStore(join(appHome, 'evidence'))
}

export interface LocalEvidenceStagingNamespace {
  readonly namespace: EvidenceStagingNamespace
  adopt(directory: string): EvidenceStagingLease
  resolve(reference: EvidenceStagingReference): string
}

/** Only this native content package interprets the stage as a host directory. */
export function createLocalEvidenceStagingNamespace(
  evidence: EvidenceArtifactPort | (() => EvidenceArtifactPort),
): LocalEvidenceStagingNamespace {
  const namespace: EvidenceStagingNamespace = {
    kind: 'evidence-staging-namespace',
    reference: {},
  }
  const directories = new WeakMap<object, string>()
  const content = () => (typeof evidence === 'function' ? evidence() : evidence)
  return {
    namespace,
    resolve(reference) {
      const directory = directories.get(reference.reference)
      if (directory === undefined || reference.namespace.reference !== namespace.reference) {
        throw new Error('native-evidence-staging-unknown')
      }
      return directory
    },
    adopt(directory) {
      const reference: EvidenceStagingReference = {
        kind: 'evidence-staging',
        namespace,
        reference: {},
      }
      directories.set(reference.reference, directory)
      return {
        reference,
        writeText(input) {
          writeFileSync(join(directory, input.relativeName), input.text)
        },
        importTree(budget) {
          return content().importStagedTree(directory, budget)
        },
        async putDocument(text) {
          // The original manifest mechanism allocates its own temporary directory.
          const tmp = mkdtempSync(join(tmpdir(), 'aw-pipeline-manifest-'))
          try {
            const file = join(tmp, 'manifest.json')
            writeFileSync(file, text)
            const blob = await content().putBlobFromFile(file)
            return { sha256: blob.sha256, bytes: blob.bytes }
          } finally {
            rmSync(tmp, { recursive: true, force: true })
          }
        },
        close() {
          rmSync(directory, { recursive: true, force: true })
        },
      }
    },
  }
}

export type LocalEvidenceStagingAllocation =
  | { readonly kind: 'requirement'; readonly root: string }
  | { readonly kind: 'temporary'; readonly prefix: string }

export function createLocalEvidenceStagingFactory(
  content: LocalEvidenceStagingNamespace,
  allocation: LocalEvidenceStagingAllocation,
): EvidenceStagingFactory {
  return {
    namespace: content.namespace,
    create() {
      const directory =
        allocation.kind === 'requirement'
          ? join(allocation.root, ulid())
          : mkdtempSync(join(tmpdir(), allocation.prefix))
      if (allocation.kind === 'requirement') mkdirSync(directory, { recursive: true })
      return content.adopt(directory)
    },
  }
}
