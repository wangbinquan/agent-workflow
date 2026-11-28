// RFC-626 §4.6: a logical artifact directory — above all the retained RFC-349 archive a
// PostgreSQL source is composed with — was hashed byte for byte every time its reader was
// asked whether it had changed (about 36 times in one upgrade), and its chunks were verified
// one by one every time it was resolved (about 7 times). Both now happen once per process for
// as long as the directory stays as it was.
//
// "As it was" is decided without reading the data: the path, every entry's size, inode, change
// and modification times, and the bytes of the small files that bind the chunks. A write to a
// file changes its change time (at the file system's timestamp resolution), and the binding
// files are compared by content, so a directory whose content moved is measured again.
import { createSha256DigestBuilder, sha256Hex } from '@/platform/contracts/hash'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalSchemaJson } from '../schema/canonical'
import {
  openVerifiedLogicalDatabaseArtifactSource,
  type VerifiedLogicalDatabaseArtifactSource,
} from './legacy/logicalDatabaseRestore'
import { sourceFilesDigest } from './sourceReader'
import type { SourceMeasurementObserver } from './sourceTypes'

/** The small files that bind a logical artifact or backup: their bytes are always compared. */
const MANIFEST_FILES = [
  'logical-manifest.json',
  'legacy-archive/manifest.json',
  'logical-backup.json',
  'source-evidence/binding.json',
  'manifest.json',
  'hosted-backup.json',
  'database/logical/logical-manifest.json',
  'database/logical/legacy-archive/manifest.json',
  'database/logical/logical-backup.json',
  'database/logical/source-evidence/binding.json',
] as const

/**
 * What the directory looks like without reading its data: a digest over its path, the shape and
 * stat of every entry, and the bytes of its manifest files.
 */
export function artifactDirectorySignature(root: string): string {
  const path = resolve(root)
  const hash = createSha256DigestBuilder()
  hash.update(`${path}\n`)
  const visit = (absolute: string, relative: string): void => {
    const info = statSync(absolute, { bigint: true })
    hash.update(
      `${JSON.stringify([relative, info.isDirectory() ? 'd' : 'f', String(info.size), String(info.ino), String(info.mtimeNs), String(info.ctimeNs)])}\n`,
    )
    if (info.isDirectory())
      for (const name of readdirSync(absolute).sort())
        visit(join(absolute, name), `${relative}/${name}`)
  }
  visit(path, '')
  for (const name of MANIFEST_FILES) {
    const file = join(path, name)
    if (existsSync(file)) hash.update(`${name}:${sha256Hex(readFileSync(file))}\n`)
  }
  return `sha256:${hash.digestHex()}`
}

/** Null when the directory cannot be listed: the uncached call then fails the way it always did. */
function signatureOf(root: string): string | null {
  try {
    return artifactDirectorySignature(root)
  } catch {
    return null
  }
}

const digests = new Map<string, { readonly signature: string; readonly digest: string }>()
/**
 * `sourceFilesDigest(root)`, computed once while the directory keeps its signature. A directory
 * that changed while it was being hashed is not remembered under either signature.
 * `onMeasure` (RFC-626 §7) is told when the directory is hashed, not when the cache answers.
 */
export async function cachedSourceFilesDigest(
  root: string,
  onMeasure?: SourceMeasurementObserver,
): Promise<string> {
  const path = resolve(root)
  const signature = signatureOf(path)
  const cached = digests.get(path)
  if (signature !== null && cached?.signature === signature) return cached.digest
  digests.delete(path)
  onMeasure?.('directory-digest')
  const digest = await sourceFilesDigest(path)
  if (signature !== null && signatureOf(path) === signature)
    digests.set(path, { signature, digest })
  return digest
}

const verified = new Map<
  string,
  { readonly signature: string; readonly source: VerifiedLogicalDatabaseArtifactSource }
>()
/**
 * `openVerifiedLogicalDatabaseArtifactSource`, verified once while the directory keeps its
 * signature. The returned source still verifies every chunk it hands out; only the complete
 * pass over the tree is not repeated. `onMeasure` (RFC-626 §7) is told when the tree is
 * verified, not when the cache answers.
 */
export function cachedVerifiedArtifactSource(
  input: Parameters<typeof openVerifiedLogicalDatabaseArtifactSource>[0],
  onMeasure?: SourceMeasurementObserver,
): VerifiedLogicalDatabaseArtifactSource {
  const path = resolve(input.artifactRoot)
  const key = canonicalSchemaJson({
    path,
    manifest: input.expectedManifestDigest,
    legacyArchive: input.expectedLegacyArchiveFileDigest,
    contract: input.contract.digest,
    valueRule: input.valueRule ?? 'strict',
  })
  const signature = signatureOf(path)
  const cached = verified.get(key)
  if (signature !== null && cached?.signature === signature) return cached.source
  // A tree that fails verification is never remembered, and neither is its predecessor.
  verified.delete(key)
  onMeasure?.('tree-verification')
  const source = openVerifiedLogicalDatabaseArtifactSource(input)
  if (signature !== null && signatureOf(path) === signature)
    verified.set(key, { signature, source })
  return source
}
