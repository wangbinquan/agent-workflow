import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import {
  artifactReceipt,
  legacyLocationToContentRef,
  type ContentStat,
} from '@/platform/persistence/migration/conversion/content'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { contentSlotKey, type CatalogSlot } from './catalog'
import { contentUncertainty } from './receipts'

export interface ConvertedContent {
  readonly refJson: string | null
  readonly inline: Uint8Array | null
  readonly contentId: string | null
  readonly blocked: boolean
}

export async function convertContentReference(
  slot: CatalogSlot,
  row: SourceRow,
  ctx: RuleContext,
): Promise<ConvertedContent> {
  const absent = { refJson: null, inline: null, contentId: null, blocked: false }
  if (!slot.ref) {
    ctx.out.artifact(
      artifactReceipt({
        source: row,
        column: slot.column,
        originalReference: null,
        target: slot.target,
        ref: legacyLocationToContentRef({
          location: { codec: 'epoch1-null', value: null },
          kind: 'local-file',
        }),
        stat: {
          state: 'absent',
          cause: 'originally-absent',
          evidence: `${row.table}.${slot.column} is SQL NULL`,
        },
      }),
    )
    if (slot.required) {
      ctx.out.block(
        rowBlock('v2-content-required-null', row, { column: slot.column }, [slot.column]),
      )
      return { ...absent, blocked: true }
    }
    return absent
  }
  const catalog = slot.catalog
  if (catalog?.conflict) {
    ctx.out.block(
      rowBlock(
        'v2-content-object-conflict',
        row,
        { contentId: catalog.id, location: canonicalSchemaJson(catalog.location) },
        [slot.column],
      ),
    )
    return { ...absent, blocked: true }
  }
  let stat: ContentStat
  try {
    const embedded = slot.ref.kind === 'inline' ? slot.ref.bytes : slot.databaseBytes
    if (embedded)
      stat = { state: 'present', size: embedded.byteLength, sha256: bytesDigest(embedded).slice(7) }
    else {
      stat = await ctx.content.stat(slot.ref.location)
      if (stat.state === 'present') {
        const bytes = await ctx.content.read(slot.ref.location)
        if (bytes.byteLength !== stat.size || bytesDigest(bytes).slice(7) !== stat.sha256)
          throw new Error('v2-content-inventory-bytes-mismatch')
      }
    }
    const metadata = {
      contentId: catalog?.id ?? null,
      contentVersion: catalog ? 1 : slot.ref.contentVersion,
      sha256: stat.state === 'present' ? stat.sha256 : slot.ref.sha256,
      size: stat.state === 'present' ? stat.size : slot.ref.size,
      mediaType: slot.ref.mediaType,
    }
    // Verify declared legacy metadata before enriching a reference with inventory facts.
    artifactReceipt({
      source: row,
      column: slot.column,
      originalReference: slot.originalReference,
      target: slot.target,
      ref: slot.ref,
      stat,
    })
    const ref = legacyLocationToContentRef({
      location: slot.ref.location,
      kind: slot.ref.kind,
      metadata,
      ...(slot.ref.kind === 'inline' ? { bytes: slot.ref.bytes } : {}),
    })
    const receipt = artifactReceipt({
      source: row,
      column: slot.column,
      originalReference: slot.originalReference,
      target: slot.target,
      ref,
      stat,
      publication:
        row.table === 'hosted_object_publications' && row.values.state === 'ready'
          ? 'existing-ready'
          : 'not-required',
    })
    ctx.out.artifact(receipt)
    const columns = encodeContentRefColumns(ref)
    let blocked = false
    if (stat.state === 'absent') {
      const detail = {
        column: slot.column,
        cause: stat.cause,
        evidence: stat.evidence,
        reference: slot.originalReference,
      }
      if (stat.cause === 'missing-at-freeze') {
        ctx.out.block(rowBlock('v2-content-lost-at-freeze', row, detail, [slot.column]))
        blocked = true
      } else if (slot.required) {
        let recovered = false
        if (slot.fallback) {
          const fallbackStat = await ctx.content.stat(slot.fallback.location)
          if (fallbackStat.state === 'present') {
            const bytes = await ctx.content.read(slot.fallback.location)
            if (
              bytes.byteLength !== fallbackStat.size ||
              bytesDigest(bytes).slice(7) !== fallbackStat.sha256
            )
              throw new Error('v2-content-inventory-bytes-mismatch')
            artifactReceipt({
              source: row,
              column: slot.column,
              originalReference: slot.originalReference,
              target: slot.target,
              ref: slot.fallback,
              stat: fallbackStat,
            })
            recovered = true
            ctx.out.record(
              {
                kind: 'decision',
                code: 'v2-content-staged-fallback',
                payload: {
                  sourceKey: row.encodedKey,
                  column: slot.column,
                  originalReference: slot.originalReference,
                  stagedLocation: canonicalSchemaJson(slot.fallback.location),
                  sha256: fallbackStat.sha256,
                  size: fallbackStat.size,
                },
              },
              row,
            )
          } else if (fallbackStat.cause === 'missing-at-freeze') {
            ctx.out.block(
              rowBlock(
                'v2-content-lost-at-freeze',
                row,
                {
                  ...detail,
                  fallback: canonicalSchemaJson(slot.fallback.location),
                  evidence: fallbackStat.evidence,
                },
                [slot.column],
              ),
            )
            blocked = true
          }
        }
        if (!recovered && !blocked)
          blocked = contentUncertainty({
            row,
            ctx,
            code: 'v2-content-required-missing',
            fields: [slot.column],
            detail,
            targets: [slot.target],
          })
      }
    }
    if (
      !blocked &&
      catalog &&
      catalog.ownerKey === row.encodedKey &&
      catalog.ownerSlot === contentSlotKey(slot)
    ) {
      const sha256 = stat.state === 'present' ? stat.sha256 : catalog.sha256
      const size = stat.state === 'present' ? stat.size : catalog.size
      if (sha256 === null || size === null) {
        ctx.out.block(
          rowBlock('v2-content-catalog-metadata-missing', row, { contentId: catalog.id }, [
            slot.column,
          ]),
        )
        blocked = true
      } else {
        const object: TargetRow = {
          content_id: catalog.id,
          content_version: 1,
          sha256,
          size,
          media_type: catalog.mediaType,
          kind: catalog.kind,
          location_json: canonicalSchemaJson(catalog.location),
          created_at: ctx.planTime,
        }
        ctx.out.row('content_objects', object, row)
        if (slot.databaseBytes)
          ctx.out.row('content_bytes', { content_id: catalog.id, bytes: slot.databaseBytes }, row)
        ctx.out.exception({
          sourceTable: row.table,
          sourceKey: row.encodedKey,
          class: 'converted',
          kind: catalog.shared ? 'merged' : 'derived-id',
          targets: [
            slot.target,
            { table: 'content_objects', key: ctx.target.key('content_objects', object) },
          ],
          archive: null,
          decision: {
            code: catalog.shared ? 'v2-content-shared-location' : 'v2-content-catalog-id',
            detail: { contentId: catalog.id, location: canonicalSchemaJson(catalog.location) },
          },
        })
      }
    }
    if (slot.skill)
      ctx.out.record({
        kind: 'decision',
        code: 'v2-skill-byte-profile',
        payload: {
          sourceKey: row.encodedKey,
          ...slot.skill,
          sha256: stat.state === 'present' ? stat.sha256 : null,
        },
      })
    if (slot.skill?.strippedBom)
      ctx.out.record(
        {
          kind: 'decision',
          code: 'v2-skill-stripped-bom-size',
          payload: {
            sourceKey: row.encodedKey,
            storedSize: slot.skill.storedSize,
            actualSize: slot.skill.actualSize,
            servedBytes: 'unchanged',
          },
        },
        row,
      )
    return { refJson: columns.json, inline: columns.inlineBytes, contentId: ref.contentId, blocked }
  } catch (error) {
    ctx.out.block(
      rowBlock(
        'v2-content-bytes-unprovable',
        row,
        { column: slot.column, message: error instanceof Error ? error.message : String(error) },
        [slot.column],
      ),
    )
    return { ...absent, blocked: true }
  }
}
