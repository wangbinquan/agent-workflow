import type { ContentLocation, ContentRef } from '../contentRef'
import { legacyContentRef } from '../contentRef'
import { decodeLegacySkillBytes } from '../migration/skillContent'
import {
  contentSourceTables,
  decodeContentSlots,
  skillTreeKey,
  type ContentSlot,
} from '../migration/specs'
import { hostedReviewReceipt } from '../migration/hostedObjects'
import type {
  FrozenSourceHandle,
  ContentRootSpec,
} from '@/platform/persistence/migration/run/types'
import type { SourceRow, ArtifactReceipt } from '@/platform/persistence/migration/conversion/types'
import { join } from 'node:path'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { frozenSourceDetails } from '@/platform/persistence/migration/freeze/sourceAccess'
import { stageSourceTable } from '@/platform/persistence/migration/conversion/readSource'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { resolveContentLocation, type InventoryResolution } from './resolvers'
import { contentByteFacts, skillTreeManifestBytes } from './treeDigest'

export interface DatabaseTree {
  readonly skillId: string
  readonly tree: string
  readonly entries: ReadonlyMap<string, Uint8Array>
  readonly bytes: Uint8Array
}
export interface InventorySourceIndex {
  readonly trees: ReadonlyMap<string, DatabaseTree>
  readonly locations: ReadonlyMap<string, InventoryResolution>
  readonly receipts: ReadonlyMap<string, ContentLocation | null>
  readonly objects: ReadonlySet<string>
  readonly failures: ReadonlyMap<string, string>
}
export const inventoryLocationKey = (location: ContentLocation): string =>
  canonicalSchemaJson(location)
export function inventoryReceiptKey(
  receipt: Pick<
    ArtifactReceipt,
    'sourceTable' | 'sourceKey' | 'sourceColumn' | 'originalReference'
  >,
): string {
  return canonicalSchemaJson([
    receipt.sourceTable,
    receipt.sourceKey,
    receipt.sourceColumn,
    receipt.originalReference,
  ])
}
export function emptyInventoryIndex(): InventorySourceIndex {
  return {
    trees: new Map(),
    locations: new Map(),
    receipts: new Map(),
    objects: new Set(),
    failures: new Map(),
  }
}

const indexes = new WeakMap<FrozenSourceHandle, Map<string, Promise<InventorySourceIndex>>>()
export function readInventorySource(
  source: FrozenSourceHandle,
  root: ContentRootSpec,
  operationRoot?: string,
): Promise<InventorySourceIndex> {
  const key = canonicalSchemaJson(root)
  let cached = indexes.get(source)
  if (!cached) {
    cached = new Map()
    indexes.set(source, cached)
  }
  let result = cached.get(key)
  if (!result) {
    result = buildInventorySource(source, root, operationRoot)
    cached.set(key, result)
    void result.catch(() => cached!.delete(key))
  }
  return result
}
async function buildInventorySource(
  source: FrozenSourceHandle,
  root: ContentRootSpec,
  operationRoot?: string,
): Promise<InventorySourceIndex> {
  await source.reader.assertUnchanged(source.preflight)
  const tables = [...contentSourceTables, 'node_runs'].filter((table) =>
    source.preflight.contract?.tables.some((entry) => entry.id === table),
  )
  if (!tables.length) return emptyInventoryIndex()
  const scratchRoot = operationRoot ?? frozenSourceDetails(source).operationRoot
  const inventoryRoot = join(scratchRoot, 'inventory')
  // The caller holds the operation lock; a previous process may have died mid-index.
  if (existsSync(inventoryRoot))
    for (const entry of readdirSync(inventoryRoot, { withFileTypes: true }))
      if (entry.isDirectory() && entry.name.startsWith('conversion-'))
        rmSync(join(inventoryRoot, entry.name), { recursive: true, force: true })
  const staged = createStagingStore(inventoryRoot)
  const groups = new Map<
    string,
    { skillId: string; tree: string; entries: Map<string, Uint8Array> }
  >()
  const invalidTrees = new Set<string>()
  const reviewObjects = new Map<string, ContentRef>()
  const portObjects = new Map<string, ContentRef>()
  const failures = new Map<string, string>()
  const facts = { reviewObjects, portObjects, databaseSkillTrees: new Set<string>() }
  const failure = (row: SourceRow, error: unknown) =>
    failures.set(row.encodedKey, error instanceof Error ? error.message : String(error))
  const stage = (table: string) =>
    stageSourceTable({
      source: source.reader,
      preflight: source.preflight,
      table,
      phase: 'current',
      raw: false,
      limit: 1000,
      staged,
    })
  const dependencies = [
    'skill_content_entries',
    'hosted_task_artifacts',
    'collaboration_gate_artifacts',
  ].filter((table) => tables.includes(table))
  const locations = new Map<string, InventoryResolution>()
  const receipts = new Map<string, ContentLocation | null>()
  const objects = new Set<string>()
  const register = (row: SourceRow, slot: ContentSlot) => {
    const ref = slot.ref
    // Target-owned bytes need no external recheck or large inline-reference index key.
    if (!ref || ref.kind === 'inline' || slot.databaseBytes) return
    const location = slot.catalogLocation ?? ref.location
    const resolution = resolveContentLocation(location, root)
    receipts.set(
      inventoryReceiptKey({
        sourceTable: row.table,
        sourceKey: row.encodedKey,
        sourceColumn: slot.column,
        originalReference: slot.originalReference,
      }),
      location,
    )
    const key = inventoryLocationKey(ref.location)
    const prior = locations.get(key)
    locations.set(
      key,
      prior && canonicalSchemaJson(prior) !== canonicalSchemaJson(resolution)
        ? { kind: 'unsupported', reason: 'content-location-ambiguous-source-identity' }
        : resolution,
    )
    if (resolution.kind === 'object') objects.add(resolution.objectId)
  }
  try {
    for (const table of dependencies) {
      await stage(table)
      for (const row of staged.rows(table)) {
        const v = row.values
        if (
          table === 'skill_content_entries' &&
          typeof v.skill_id === 'string' &&
          typeof v.tree === 'string'
        )
          facts.databaseSkillTrees.add(skillTreeKey(v.skill_id, v.tree))
        try {
          if (row.codecFailure) throw new Error(row.codecFailure.message)
          if (table === 'skill_content_entries') {
            if (
              typeof v.skill_id !== 'string' ||
              typeof v.tree !== 'string' ||
              typeof v.path !== 'string' ||
              typeof v.encoding !== 'string' ||
              typeof v.content !== 'string'
            )
              throw new Error('skill-tree-row-invalid')
            const key = skillTreeKey(v.skill_id, v.tree)
            const group = groups.get(key) ?? {
              skillId: v.skill_id,
              tree: v.tree,
              entries: new Map<string, Uint8Array>(),
            }
            const decoded = decodeLegacySkillBytes(v.encoding, v.content)
            const bytes = decoded.bytes
            if (
              bytes.length !== v.size &&
              !(v.encoding === 'utf8' && !decoded.bom && v.size === bytes.length + 3)
            )
              throw new Error('v2-skill-size-mismatch')
            if (group.entries.has(v.path)) throw new Error('skill-tree-duplicate-path')
            group.entries.set(v.path, bytes)
            groups.set(key, group)
          }
          if (table === 'hosted_task_artifacts' && typeof v.object_id === 'string') {
            decodeContentSlots(row, facts)
            portObjects.set(
              String(v.reference),
              legacyContentRef('hosted-object-id', 'object', v.object_id),
            )
          }
          if (table === 'collaboration_gate_artifacts') {
            const receipt = hostedReviewReceipt(row)
            if (receipt)
              for (const reference of [receipt.stagedPath, receipt.finalPath])
                reviewObjects.set(
                  reference,
                  legacyContentRef('review-object', 'object', {
                    reference,
                    objectId: receipt.object.id,
                  }),
                )
          }
        } catch (error) {
          failure(row, error)
          if (table === 'skill_content_entries')
            invalidTrees.add(skillTreeKey(String(v.skill_id), String(v.tree)))
        }
      }
    }
    for (const table of tables) {
      if (!dependencies.includes(table)) await stage(table)
      for (const row of staged.rows(table)) {
        try {
          if (row.codecFailure) throw new Error(row.codecFailure.message)
          if (failures.has(row.encodedKey)) continue
          if (row.table === 'node_runs') {
            const path = row.values.prompt_path
            if (typeof path === 'string' && row.values.prompt_text === null) {
              const location = { codec: 'prompt', value: { promptText: null, promptPath: path } }
              locations.set(inventoryLocationKey(location), resolveContentLocation(location, root))
              receipts.set(
                inventoryReceiptKey({
                  sourceTable: row.table,
                  sourceKey: row.encodedKey,
                  sourceColumn: 'prompt_path',
                  originalReference: path,
                }),
                location,
              )
            }
          } else {
            const slots = decodeContentSlots(row, facts)
            // Resolve the whole row first: a malformed slot cannot leave half a row indexed.
            for (const slot of slots)
              if (slot.ref && slot.ref.kind !== 'inline' && !slot.databaseBytes)
                resolveContentLocation(slot.catalogLocation ?? slot.ref.location, root)
            for (const slot of slots) register(row, slot)
          }
        } catch (error) {
          failure(row, error)
        }
      }
      staged.clear(table)
    }
    const trees = new Map<string, DatabaseTree>()
    for (const [key, group] of groups)
      if (!invalidTrees.has(key))
        trees.set(key, {
          ...group,
          bytes: skillTreeManifestBytes(
            [...group.entries].map(([path, bytes]) => ({ path, ...contentByteFacts(bytes) })),
          ),
        })
    await source.reader.assertUnchanged(source.preflight)
    return { trees, locations, receipts, objects, failures }
  } finally {
    staged.close()
  }
}
