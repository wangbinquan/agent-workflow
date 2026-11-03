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

/**
 * RFC-431: a local evidence store opened on first use. The store creates its `blobs/` and `bundles/`
 * directories when constructed; the standalone profile is built before the startup lock and its
 * selections perform no IO, so the store is constructed by the first member access.
 */
function openedOnFirstUse(root: string): EvidenceArtifactPort {
  let store: EvidenceStore | undefined
  const open = (): EvidenceStore => (store ??= new EvidenceStore(root))
  return Object.freeze<EvidenceArtifactPort>({
    get contents() {
      return open().contents
    },
    get documents() {
      return open().documents
    },
    get downloads() {
      return open().downloads
    },
    get contexts() {
      return open().contexts
    },
    putFile: (absolutePath) => open().putFile(absolutePath),
    putBlobFromFile: (absolutePath) => open().putBlobFromFile(absolutePath),
    importStagedTree: (stagedRoot, budget) => open().importStagedTree(stagedRoot, budget),
    getBundle: (bundleRef) => open().getBundle(bundleRef),
    materializeBundle: (bundleRef, destination) => open().materializeBundle(bundleRef, destination),
    materializeBlob: (blobRef, destination) => open().materializeBlob(blobRef, destination),
    hasBlob: (blobRef) => open().hasBlob(blobRef),
  })
}

/** Bootstrap owns selection; the native content adapter owns physical construction (`appHome/evidence`). */
export function createLocalEvidenceArtifactPort(appHome: string): EvidenceArtifactPort {
  return openedOnFirstUse(join(appHome, 'evidence'))
}

/**
 * RFC-431: the standalone graph-development (RFC-396) artifact store. Since v0.19.3 standalone keeps these
 * under the app home root itself (`appHome/blobs`, `appHome/bundles`), apart from `appHome/evidence`.
 */
export function createLocalGraphDevelopmentArtifactPort(appHome: string): EvidenceArtifactPort {
  return openedOnFirstUse(appHome)
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
