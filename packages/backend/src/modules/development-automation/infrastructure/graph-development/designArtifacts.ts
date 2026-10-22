import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { EvidenceArtifactPort } from '../../application/ports/evidenceArtifacts'
import type {
  GraphArtifactReference,
  GraphDesignArtifacts,
} from '../../application/ports/graphDesignArtifacts'
import { graphDigest } from '../../domain/graph-development/model'
import { sha256Hex } from '@/util/hash'

export function createGraphDesignArtifacts(evidence: EvidenceArtifactPort): GraphDesignArtifacts {
  async function bundle(reference: GraphArtifactReference) {
    const value = await evidence.getBundle(reference.artifactRef)
    if (!value) throw new Error(`graph-artifact-missing: ${reference.artifactRef}`)
    const digest = graphDigest(
      value.entries
        .map((e) => ({ path: e.relativePath, digest: e.sha256 }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    )
    if (digest !== reference.digest) throw new Error('graph-artifact-digest-mismatch')
    return value
  }
  return {
    async put(files) {
      const paths = new Set<string>()
      for (const file of files) {
        if (
          !file.path ||
          file.path.startsWith('/') ||
          file.path.split(/[\\/]/).some((p) => p === '..' || p === '') ||
          paths.has(file.path)
        )
          throw new Error('graph-artifact-invalid-path')
        paths.add(file.path)
      }
      const directory = await mkdtemp(join(tmpdir(), 'aw-graph-artifact-'))
      try {
        for (const file of files) {
          await mkdir(dirname(join(directory, file.path)), { recursive: true })
          await writeFile(join(directory, file.path), file.content, 'utf8')
        }
        const value = await evidence.importStagedTree(directory, {
          maxFiles: 10_000,
          maxFileBytes: 32 * 1024 * 1024,
          maxTotalBytes: 128 * 1024 * 1024,
        })
        return {
          artifactRef: value.bundleId,
          digest: graphDigest(
            value.entries
              .map((e) => ({ path: e.relativePath, digest: e.sha256 }))
              .sort((a, b) => a.path.localeCompare(b.path)),
          ),
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    async read(reference, path) {
      const value = await bundle(reference)
      const entry = value.entries.find((item) => item.relativePath === path)
      if (!entry) return null
      const content = await evidence.documents.readText({
        bundleRef: reference.artifactRef,
        relativePath: path,
      })
      if (content !== null && sha256Hex(content) !== entry.sha256)
        throw new Error('graph-artifact-content-digest-mismatch')
      return content
    },
    async files(reference) {
      const value = await bundle(reference)
      return await Promise.all(
        value.entries.map(async (entry) => {
          const content = await evidence.documents.readText({
            bundleRef: reference.artifactRef,
            relativePath: entry.relativePath,
          })
          if (content === null)
            throw new Error(`graph-artifact-file-missing: ${entry.relativePath}`)
          if (sha256Hex(content) !== entry.sha256)
            throw new Error('graph-artifact-content-digest-mismatch')
          return { path: entry.relativePath, content }
        }),
      )
    },
  }
}
