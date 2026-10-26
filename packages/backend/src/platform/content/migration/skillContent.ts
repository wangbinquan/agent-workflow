import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow, TargetRef } from '@/platform/persistence/migration/conversion/types'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { artifactReceipt } from '@/platform/persistence/migration/conversion/content'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { contentRefColumns } from '../contentStore'
import type { ContentRef } from '../contentRef'
import { createSha256DigestBuilder } from '@/util/hash'

export interface LegacySkillBytes {
  readonly bytes: Uint8Array
  readonly bom: boolean
  readonly validUtf8: boolean
  readonly empty: boolean
}

export function decodeLegacySkillBytes(encoding: string, content: string): LegacySkillBytes {
  let bytes: Uint8Array
  if (encoding === 'utf8') {
    bytes = new TextEncoder().encode(content)
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== content)
      throw new Error('v2-skill-text-not-lossless')
  } else if (encoding === 'base64') {
    bytes = Uint8Array.from(Buffer.from(content, 'base64'))
    if (Buffer.from(bytes).toString('base64') !== content)
      throw new Error('v2-skill-base64-invalid')
  } else throw new Error('v2-skill-encoding-unknown')
  let validUtf8 = true
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    validUtf8 = false
  }
  return {
    bytes,
    bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    validUtf8,
    empty: bytes.byteLength === 0,
  }
}

/** Frozen tree locations remain explicit. Only a synthetic snapshot needs new
 * per-path database bytes; existing trees keep their original storage identity. */
export async function convertFrozenSkillContent(
  input: {
    readonly skillId: string
    readonly tree: 'live' | `version:${number}`
    readonly source: SourceRow
    readonly target: TargetRef
    readonly synthesized?: boolean
    readonly snapshot: {
      readonly source: 'local-file' | 'database-bytes'
      readonly reference: string
      readonly present: boolean
      readonly files: readonly {
        readonly path: string
        readonly base64: string
        readonly size: number
        readonly sha256: string
      }[]
      readonly contentHash: string
    }
  },
  ctx: RuleContext,
): Promise<{ readonly refJson: string; readonly inline: Uint8Array | null }> {
  const { snapshot, source, target, skillId, tree } = input
  if (!snapshot.present) throw new Error('v2-boot-skill-tree-missing')
  const files = [...snapshot.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const paths = new Set<string>()
  const hash = createSha256DigestBuilder()
  for (const file of files) {
    if (
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('v2-boot-skill-file-path-invalid')
    if (paths.has(file.path)) throw new Error('v2-boot-skill-duplicate-path')
    paths.add(file.path)
    const bytes = decodeLegacySkillBytes('base64', file.base64).bytes
    if (bytes.length !== file.size || bytesDigest(bytes).slice(7) !== file.sha256)
      throw new Error('v2-boot-skill-frozen-bytes-mismatch')
    hash.update(Buffer.from(file.path))
    hash.update(new Uint8Array([0]))
    hash.update(bytes)
    hash.update(new Uint8Array([0]))
  }
  if (hash.digestHex() !== snapshot.contentHash)
    throw new Error('v2-boot-skill-frozen-hash-mismatch')
  const local = snapshot.source === 'local-file' && !input.synthesized
  const ref: ContentRef = {
    version: 1,
    kind: local ? 'local-file' : 'database-bytes',
    location: local
      ? { codec: 'skill-path', value: snapshot.reference }
      : { codec: 'skill-tree', value: { skillId, tree } },
    contentId: null,
    contentVersion: null,
    sha256: null,
    size: null,
    mediaType: null,
  }
  // Existing database trees are emitted once by content/skill_content_entries.
  // A synthetic initial snapshot has no source entry rows and is materialized here.
  if (input.synthesized) {
    for (const [ordinal, file] of files.entries()) {
      const bytes = decodeLegacySkillBytes('base64', file.base64).bytes
      const contentId = ctx.ids.child(`boot-skill-entry@1:${skillId}:${tree}`, target.key, ordinal)
      const entryRef: ContentRef = {
        version: 1,
        kind: 'database-bytes',
        location: { codec: 'content-bytes', value: contentId },
        contentId,
        contentVersion: 1,
        sha256: file.sha256,
        size: file.size,
        mediaType: null,
      }
      ctx.out.row(
        'content_objects',
        {
          content_id: contentId,
          content_version: 1,
          sha256: file.sha256,
          size: file.size,
          media_type: null,
          kind: 'database-bytes',
          location_json: canonicalSchemaJson(entryRef.location),
          created_at: ctx.planTime,
        },
        source,
      )
      ctx.out.row('content_bytes', { content_id: contentId, bytes }, source)
      const columns = contentRefColumns.encode(entryRef)
      ctx.out.row(
        'skill_content_entries',
        {
          skill_id: skillId,
          tree,
          path: file.path,
          size: file.size,
          content_ref_json: columns.json,
          content_inline_bytes: columns.inlineBytes,
          updated_at: ctx.planTime,
        },
        source,
      )
    }
  }
  ctx.out.artifact(
    artifactReceipt({
      source,
      target,
      column: source.table === 'skills' ? 'managed_path' : 'files_path',
      originalReference: String(
        source.values.managed_path ?? source.values.files_path ?? snapshot.reference,
      ),
      ref,
      stat: {
        state: 'present',
        sha256: snapshot.contentHash,
        size: files.reduce((size, file) => size + file.size, 0),
      },
    }),
  )
  const columns = contentRefColumns.encode(ref)
  return { refJson: columns.json, inline: columns.inlineBytes }
}
