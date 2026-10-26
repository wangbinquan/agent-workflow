import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { ContentLocation } from '../contentRef'
import { skillTreeKey } from '../migration/specs'
import type { ContentStat } from '@/platform/persistence/migration/conversion/content'
import type {
  ContentDrift,
  ContentRootSpec,
  FreezeContentManifest,
  FrozenSourceHandle,
  VerifiableContentInventory,
} from '@/platform/persistence/migration/run/types'
import { frozenSourceDetails } from '@/platform/persistence/migration/freeze/sourceAccess'
import {
  readInventorySource,
  emptyInventoryIndex,
  inventoryLocationKey,
  inventoryReceiptKey,
  type InventorySourceIndex,
} from './databaseTrees'
import {
  resolveContentLocation,
  inventoryRelativePath,
  inventoryManifestPath,
  inventoryHomePath,
  type InventoryResolution,
} from './resolvers'
import { readInventoryObject, statInventoryObject, type InventoryObjectReader } from './objects'
import { contentByteFacts, skillTreeManifestBytes } from './treeDigest'
import { verifyContentManifest } from './manifest'

interface Observation {
  readonly stat: ContentStat
  readonly bytes: Uint8Array | null
}
export function createFreezeContentInventory(input: {
  readonly manifest: FreezeContentManifest
  readonly root: ContentRootSpec
  readonly source?: FrozenSourceHandle
  readonly objects?: InventoryObjectReader
  readonly operationRoot?: string
}): VerifiableContentInventory {
  verifyContentManifest(input.manifest)
  const files = new Map(input.manifest.files.map((entry) => [entry.path, entry]))
  let index: Promise<InventorySourceIndex> | undefined
  const sourceIndex = () =>
    (index ??= input.source
      ? readInventorySource(input.source, input.root, input.operationRoot)
      : Promise.resolve(emptyInventoryIndex()))
  let live = false
  if (input.source) {
    try {
      live = frozenSourceDetails(input.source).mode === 'live'
    } catch {
      /* Synthetic inventories are frozen by default. */
    }
  }
  let pending: { key: string; result: Observation } | null = null
  const observed = new Map<string, { size: number; sha256: string }>()
  const seen = new Map<string, ContentLocation>()
  const absent = (listed: boolean, evidence: string): Observation => ({
    stat: { state: 'absent', cause: listed ? 'missing-at-freeze' : 'originally-absent', evidence },
    bytes: null,
  })
  const present = (bytes: Uint8Array): Observation => ({
    stat: { state: 'present', ...contentByteFacts(bytes) },
    bytes,
  })
  const file = (path: string): Observation => {
    const relative = inventoryManifestPath(input.root, path)
    const entry = files.get(relative)
    if (!existsSync(path))
      return absent(
        !!entry && !live,
        entry
          ? 'listed freeze file is now missing'
          : 'file absent from the freeze listing and source tree',
      )
    if (!entry && !live) throw new Error('content-unlisted-present')
    const before = statSync(path)
    if (
      !before.isFile() ||
      (!live && (before.size !== entry!.size || Math.trunc(before.mtimeMs) !== entry!.mtimeMs))
    )
      return absent(!live, 'listed freeze file metadata changed')
    const bytes = readFileSync(path)
    const after = statSync(path)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== before.size
    )
      return absent(!live, 'listed file changed while reading')
    return present(bytes)
  }
  const tree = (path: string): Observation => {
    const relative = inventoryManifestPath(input.root, path)
    const prefix = posix.join(relative, '/')
    const listed =
      input.manifest.roots.some(
        (directory) => inventoryRelativePath(input.manifest.roots[0]!, directory) === relative,
      ) || input.manifest.files.some((entry) => entry.path.startsWith(prefix))
    if (!existsSync(path))
      return absent(
        listed && !live,
        listed ? 'listed skill tree is now missing' : 'skill tree absent at freeze',
      )
    if (!listed && !live) throw new Error('content-unlisted-present')
    if (!statSync(path).isDirectory())
      return absent(!live, 'listed skill tree is no longer a directory')
    const paths: string[] = []
    const walk = (directory: string) => {
      for (const name of readdirSync(directory).sort()) {
        const item = join(directory, name)
        if (statSync(item).isDirectory()) walk(item)
        else paths.push(item)
      }
    }
    walk(path)
    if (!live && paths.some((item) => !files.has(inventoryManifestPath(input.root, item))))
      throw new Error('content-unlisted-present')
    const entries = []
    const entriesToRead = live
      ? paths.map((path) => ({ path: inventoryManifestPath(input.root, path) }))
      : input.manifest.files.filter((entry) => entry.path.startsWith(prefix))
    for (const entry of entriesToRead) {
      const read = file(inventoryHomePath(input.root, entry.path))
      if (read.stat.state !== 'present') return read
      entries.push({
        path: entry.path.slice(prefix.length),
        size: read.stat.size,
        sha256: read.stat.sha256,
      })
    }
    return present(skillTreeManifestBytes(entries))
  }
  const observeResolution = async (
    resolution: InventoryResolution,
    source: InventorySourceIndex,
  ): Promise<Observation> => {
    if (resolution.kind === 'unsupported') throw new Error(resolution.reason)
    if (resolution.kind === 'file' || resolution.kind === 'directory-tree') {
      const relative = inventoryManifestPath(input.root, resolution.path)
      if (
        input.root.kind === 'backup' &&
        !input.root.runsSupplied &&
        /^(runs|logs|evidence)(\/|$)/.test(relative)
      ) {
        const kind = input.source?.preflight.kind ?? 'backup'
        return absent(
          false,
          `epoch-1 ${kind} run content was not supplied to the restore; absence recorded`,
        )
      }
      return resolution.kind === 'file' ? file(resolution.path) : tree(resolution.path)
    }
    if (resolution.kind === 'database-tree') {
      const listed = input.manifest.databaseTrees.find(
        (entry) => entry.skillId === resolution.skillId && entry.tree === resolution.tree,
      )
      const actual = source.trees.get(skillTreeKey(resolution.skillId, resolution.tree))
      if (!actual)
        return absent(!!listed && !live, 'database skill tree absent from the frozen source')
      if (!listed && !live) throw new Error('content-unlisted-present')
      const facts = contentByteFacts(actual.bytes)
      if (!live && (facts.size !== listed!.size || facts.sha256 !== listed!.sha256))
        return absent(true, 'database skill tree differs from the freeze manifest')
      if (resolution.path !== undefined) {
        const bytes = actual.entries.get(resolution.path)
        return bytes
          ? present(bytes)
          : absent(false, 'database skill entry absent from the frozen tree')
      }
      return present(actual.bytes)
    }
    if (!input.objects || input.root.objects === 'none') throw new Error('object-store-unavailable')
    const listed = input.manifest.objects.find((entry) => entry.id === resolution.objectId)
    const actual = await statInventoryObject(input.objects, resolution.objectId)
    if (!actual)
      return absent(
        listed?.present === true && !live,
        listed?.present ? 'listed object is now missing' : 'object absent at freeze',
      )
    if (!listed?.present && !live) throw new Error('content-unlisted-present')
    if (
      !live &&
      (actual.id !== listed!.id || actual.size !== listed!.size || actual.sha256 !== listed!.sha256)
    )
      return absent(true, 'object facts changed after freeze')
    if (
      (resolution.sha256 !== null && resolution.sha256 !== actual.sha256) ||
      (resolution.size !== null && resolution.size !== actual.size)
    )
      throw new Error('content-object-reference-differs')
    return present(await readInventoryObject(input.objects, actual))
  }
  const observe = async (location: ContentLocation): Promise<Observation> => {
    const source = await sourceIndex()
    seen.set(
      typeof location.value === 'string' ? location.value : JSON.stringify(location.value),
      location,
    )
    try {
      return await observeResolution(
        source.locations.get(inventoryLocationKey(location)) ??
          resolveContentLocation(location, input.root),
        source,
      )
    } catch (error) {
      if (live && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return absent(false, 'file disappeared during live planning')
      throw error
    }
  }
  return {
    async stat(location) {
      const result = await observe(location)
      if (result.stat.state === 'present') observed.set(inventoryLocationKey(location), result.stat)
      if (
        live ||
        (await sourceIndex()).locations.get(inventoryLocationKey(location))?.kind === 'object' ||
        resolveContentLocation(location, input.root).kind === 'object'
      )
        pending = { key: inventoryLocationKey(location), result }
      return result.stat
    },
    async read(location) {
      const cached = pending?.key === inventoryLocationKey(location) ? pending.result : null
      pending = null
      const result = cached ?? (await observe(location))
      if (result.stat.state !== 'present' || !result.bytes) throw new Error('content-bytes-absent')
      const prior = observed.get(inventoryLocationKey(location))
      if (prior && (prior.sha256 !== result.stat.sha256 || prior.size !== result.stat.size))
        throw new Error('content-stat-read-drift')
      observed.set(inventoryLocationKey(location), result.stat)
      return result.bytes
    },
    async verifyUnchanged(receipts) {
      pending = null
      const source = await sourceIndex()
      const drift: ContentDrift[] = []
      const verified = new Map<string, ContentStat>()
      if (input.source) await input.source.reader.assertUnchanged(input.source.preflight)
      for await (const receipt of receipts) {
        if (receipt.target.backend === 'inline' || receipt.target.backend === 'database-bytes')
          continue
        const key = inventoryReceiptKey(receipt)
        if (source.receipts.has(key) && source.receipts.get(key) === null) continue
        let location =
          source.receipts.get(key) ??
          (receipt.originalReference === null ? undefined : seen.get(receipt.originalReference))
        if (
          !location &&
          receipt.originalReference !== null &&
          receipt.target.backend === 'local-file'
        )
          location = {
            codec: receipt.sourceColumn === 'prompt_path' ? 'prompt' : 'review-body',
            value:
              receipt.sourceColumn === 'prompt_path'
                ? { promptText: null, promptPath: receipt.originalReference }
                : receipt.originalReference,
          }
        let reason: ContentDrift['reason'] | null = null
        let actual: ContentDrift['actual'] = null
        if (!location)
          reason =
            receipt.bytes === null && receipt.originalReference === null ? null : 'unreadable'
        else
          try {
            const key = inventoryLocationKey(location)
            const stat = verified.get(key) ?? (await observe(location)).stat
            verified.set(key, stat)
            const result = { stat }
            if (result.stat.state === 'present') {
              actual = { size: result.stat.size, sha256: result.stat.sha256 }
              reason =
                receipt.bytes === null
                  ? 'unlisted'
                  : receipt.bytes.size !== actual.size
                    ? 'size-changed'
                    : receipt.bytes.sha256 !== actual.sha256
                      ? 'digest-changed'
                      : null
            } else if (receipt.bytes !== null || receipt.missing?.state !== result.stat.cause)
              reason = 'missing'
          } catch (error) {
            reason =
              error instanceof Error && error.message === 'content-unlisted-present'
                ? 'unlisted'
                : 'unreadable'
          }
        if (reason)
          drift.push({
            sourceTable: receipt.sourceTable,
            sourceKey: receipt.sourceKey,
            sourceColumn: receipt.sourceColumn,
            originalReference: receipt.originalReference,
            reason,
            expected: receipt.bytes,
            actual,
          })
      }
      return drift
    },
  }
}
