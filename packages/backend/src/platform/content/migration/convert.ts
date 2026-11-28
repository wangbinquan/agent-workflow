import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import type { ContentLocation, ContentRef } from '@/platform/content/contentRef'
import {
  artifactReceipt,
  legacyLocationToContentRef,
  type ContentStat,
} from '@/platform/persistence/migration/conversion/content'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  ConversionContractError,
  rowBlock,
} from '@/platform/persistence/migration/conversion/blockCodes'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type {
  JsonValue,
  MigrationRecord,
  SourceRow,
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { contentSlotKey, type CatalogSlot } from './catalog'
import { contentUncertainty } from './receipts'

export interface ConvertedContent {
  readonly refJson: string | null
  readonly inline: Uint8Array | null
  readonly contentId: string | null
  readonly blocked: boolean
  /**
   * RFC-626 §3.4 row 2b①: set only when automatic resolution kept bytes that differ from the
   * size and digest the row registered. The row's own registration takes these measured facts,
   * so it agrees with the reference that now describes the bytes on disk.
   */
  readonly measured?: { readonly sha256: string; readonly size: number }
}

/** RFC-626 §3.4 row 2b①: bytes kept as found although the row registered other ones. */
export const CONTENT_KEPT_DIFFERS = 'v2-content-kept-differs-from-registered'
/** RFC-626 §3.4 rows 2a and 2b②: content converted as missing instead of blocking its row. */
export const CONTENT_LOST_AT_FREEZE_KEPT = 'v2-content-lost-at-freeze-kept'
export const CONTENT_BYTES_UNPROVABLE_KEPT = 'v2-content-bytes-unprovable-kept'

type PresentStat = Extract<ContentStat, { readonly state: 'present' }>

/** Stat a location and prove that the bytes read are the inventoried ones. */
async function observe(ctx: RuleContext, location: ContentLocation): Promise<ContentStat> {
  const stat = await ctx.content.stat(location)
  if (stat.state === 'present') {
    const bytes = await ctx.content.read(location)
    if (bytes.byteLength !== stat.size || bytesDigest(bytes).slice(7) !== stat.sha256)
      throw new Error('v2-content-inventory-bytes-mismatch')
  }
  return stat
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/**
 * RFC-626 §3.4 row 2b②: with automatic resolution, bytes that cannot be proven — a file that
 * is on disk but not in the freeze listing, bytes that changed while being read, a read that
 * failed, a location the inventory cannot resolve — are treated as missing at freeze, with the
 * reason as evidence. Only an engine contract error still ends the conversion.
 */
async function observeOrMissing(
  ctx: RuleContext,
  location: ContentLocation,
): Promise<{ readonly stat: ContentStat; readonly unprovable: string | null }> {
  try {
    return { stat: await observe(ctx, location), unprovable: null }
  } catch (error) {
    if (error instanceof ConversionContractError) throw error
    return { stat: unprovableStat(errorText(error)), unprovable: errorText(error) }
  }
}
function unprovableStat(message: string): ContentStat {
  return {
    state: 'absent',
    cause: 'missing-at-freeze',
    evidence: `content bytes unprovable: ${message}`,
  }
}
/** The measured bytes `artifactReceipt` would reject against declared legacy metadata, if any. */
function differingStat(ref: ContentRef, stat: ContentStat): PresentStat | null {
  return stat.state === 'present' &&
    ((ref.size !== null && ref.size !== stat.size) ||
      (ref.sha256 !== null && ref.sha256 !== stat.sha256))
    ? stat
    : null
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
  // RFC-626: automatic resolution keeps every row this slot would otherwise block (design
  // §3.4 rows 2a-2c). Its decisions are written once the slot has converted.
  const automatic = ctx.resolution === 'automatic'
  const decoded: ContentRef = slot.ref
  const decisions: MigrationRecord[] = []
  const keptDiffers = (
    registered: ContentRef,
    stat: PresentStat,
    source: 'reference' | 'fallback',
  ): void => {
    decisions.push({
      kind: 'decision',
      code: CONTENT_KEPT_DIFFERS,
      payload: {
        automatic: 'kept',
        sourceTable: row.table,
        sourceKey: row.encodedKey,
        column: slot.column,
        reference: slot.originalReference,
        source,
        location: canonicalSchemaJson(registered.location),
        registered: { sha256: registered.sha256, size: registered.size },
        measured: { sha256: stat.sha256, size: stat.size },
      },
    })
  }
  /** Rows 2a and 2b②: the reference stays, the receipt says missing; required bytes go the way of row 1. */
  const keepMissing = (code: string, detail: JsonValue): boolean => {
    decisions.push({
      kind: 'decision',
      code:
        code === 'v2-content-lost-at-freeze'
          ? CONTENT_LOST_AT_FREEZE_KEPT
          : CONTENT_BYTES_UNPROVABLE_KEPT,
      payload: {
        automatic: 'kept',
        sourceTable: row.table,
        sourceKey: row.encodedKey,
        column: slot.column,
        reference: slot.originalReference,
        required: slot.required,
        evidence: detail,
      },
    })
    return slot.required
      ? contentUncertainty({
          row,
          ctx,
          code,
          fields: [slot.column],
          detail,
          targets: [slot.target],
        })
      : false
  }
  let measured: ConvertedContent['measured']
  let emitted = false
  let stat: ContentStat
  let unprovable: string | null = null
  try {
    const embedded = slot.ref.kind === 'inline' ? slot.ref.bytes : slot.databaseBytes
    if (embedded)
      stat = { state: 'present', size: embedded.byteLength, sha256: bytesDigest(embedded).slice(7) }
    else if (automatic) {
      const observed = await observeOrMissing(ctx, slot.ref.location)
      stat = observed.stat
      unprovable = observed.unprovable
    } else stat = await observe(ctx, slot.ref.location)
    const metadata = {
      contentId: catalog?.id ?? null,
      contentVersion: catalog ? 1 : slot.ref.contentVersion,
      sha256: stat.state === 'present' ? stat.sha256 : slot.ref.sha256,
      size: stat.state === 'present' ? stat.size : slot.ref.size,
      mediaType: slot.ref.mediaType,
    }
    // Verify declared legacy metadata before enriching a reference with inventory facts.
    // RFC-626 row 2b①: automatic resolution keeps the bytes on disk, as the old version served them.
    const differing = automatic ? differingStat(slot.ref, stat) : null
    if (differing) {
      measured = { sha256: differing.sha256, size: differing.size }
      keptDiffers(slot.ref, differing, 'reference')
    } else
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
    emitted = true
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
        if (!automatic) {
          ctx.out.block(rowBlock('v2-content-lost-at-freeze', row, detail, [slot.column]))
          blocked = true
        } else
          blocked =
            unprovable === null
              ? keepMissing('v2-content-lost-at-freeze', detail)
              : keepMissing('v2-content-bytes-unprovable', { ...detail, message: unprovable })
      } else if (slot.required) {
        let recovered = false
        let decided = false
        if (slot.fallback) {
          const fallback = automatic
            ? await observeOrMissing(ctx, slot.fallback.location)
            : { stat: await observe(ctx, slot.fallback.location), unprovable: null }
          const fallbackStat = fallback.stat
          if (fallbackStat.state === 'present') {
            const differingFallback = automatic ? differingStat(slot.fallback, fallbackStat) : null
            if (differingFallback) keptDiffers(slot.fallback, differingFallback, 'fallback')
            else
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
            const lost = {
              ...detail,
              fallback: canonicalSchemaJson(slot.fallback.location),
              evidence: fallbackStat.evidence,
            }
            if (!automatic) {
              ctx.out.block(rowBlock('v2-content-lost-at-freeze', row, lost, [slot.column]))
              blocked = true
            } else {
              blocked =
                fallback.unprovable === null
                  ? keepMissing('v2-content-lost-at-freeze', lost)
                  : keepMissing('v2-content-bytes-unprovable', {
                      ...lost,
                      message: fallback.unprovable,
                    })
              decided = true
            }
          }
        }
        if (!recovered && !blocked && !decided)
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
    // A slot that still blocks (set aside, or an unfinished task during discovery) keeps nothing.
    if (!blocked) for (const decision of decisions) ctx.out.record(decision, row)
    return {
      refJson: columns.json,
      inline: columns.inlineBytes,
      contentId: ref.contentId,
      blocked,
      ...(measured ? { measured } : {}),
    }
  } catch (error) {
    if (!automatic) {
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
    // An engine contract error is not a property of the data; neither is a failure after the
    // receipt went out, where converting the slot a second time would contradict it.
    if (error instanceof ConversionContractError || emitted) throw error
    return convertUnprovable(slot, decoded, row, ctx, errorText(error))
  }
}

/**
 * RFC-626 §3.4 row 2b②, the catch-all: a slot whose conversion failed for a reason no step
 * above anticipated still keeps the reference it was decoded with, and its receipt says missing.
 */
function convertUnprovable(
  slot: CatalogSlot,
  ref: ContentRef,
  row: SourceRow,
  ctx: RuleContext,
  message: string,
): ConvertedContent {
  const stat = unprovableStat(message)
  ctx.out.artifact(
    artifactReceipt({
      source: row,
      column: slot.column,
      originalReference: slot.originalReference,
      target: slot.target,
      ref,
      stat,
    }),
  )
  const columns = encodeContentRefColumns(ref)
  const detail = {
    column: slot.column,
    cause: stat.state === 'absent' ? stat.cause : null,
    evidence: stat.state === 'absent' ? stat.evidence : null,
    reference: slot.originalReference,
    message,
  }
  ctx.out.record(
    {
      kind: 'decision',
      code: CONTENT_BYTES_UNPROVABLE_KEPT,
      payload: {
        automatic: 'kept',
        sourceTable: row.table,
        sourceKey: row.encodedKey,
        column: slot.column,
        reference: slot.originalReference,
        required: slot.required,
        evidence: detail,
      },
    },
    row,
  )
  const blocked = slot.required
    ? contentUncertainty({
        row,
        ctx,
        code: 'v2-content-bytes-unprovable',
        fields: [slot.column],
        detail,
        targets: [slot.target],
      })
    : false
  return {
    refJson: columns.json,
    inline: columns.inlineBytes,
    contentId: ref.contentId,
    blocked,
  }
}
