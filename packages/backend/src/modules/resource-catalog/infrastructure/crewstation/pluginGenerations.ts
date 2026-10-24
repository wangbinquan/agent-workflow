// RFC-370 v3 V6 — hosted plugin generations. The generation row is Resource
// Catalog's owner reference: its installation receipt precedes every upload,
// and every generation file plus its manifest are `plugin-generation`
// publications scoped to the generation. Files are registered in one journal
// transaction and transferred with bounded parallelism (no per-file rewrite of
// a shared JSON document). Retirement releases the whole scope in the same
// transaction that marks the generation retired; physical unpin is deferred to
// the hosted object maintenance job.
import {
  isLegacyHostedPluginReference,
  legacyPluginGenerationReference as generationReference,
  parseLegacyPluginReference as parseReference,
  legacyPluginFileKey as fileKey,
  legacyPluginManifestKey as manifestKey,
  legacyPluginCachedReference as cachedReference,
} from '@/platform/content/legacyPlugin'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { eq, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedObjectPublications } from '@/modules/system-operations/public/participants'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type { CrewStationStreamObjectStorage } from '@/platform/crewstation/objectStorage'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { sha256Hex } from '@/util/hash'
import { ValidationError } from '@/util/errors'
import { inferSourceKind } from '../local/filePluginInstallation'
import { validatePluginMaterialTree } from './pluginMaterialTree'
import type { PluginInstallerPort } from '../../application/plugins/ports'
import type { PluginGenerationFilesystemGcPort } from '../../application/ports/pluginGenerationGc'

export const HOSTED_PLUGIN_OWNER = 'plugin-generation'

const FilePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !/[\\\0]/.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
  )
const ObjectReceipt = z
  .object({
    id: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict()
const Link = z.object({ kind: z.literal('symlink'), path: FilePath, target: z.string().min(1) })
const WireFile = z.object({
  kind: z.literal('file'),
  path: FilePath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  mode: z.number().int().min(0).max(511),
})
const Installed = z.object({
  sourceKind: z.enum(['file', 'npm', 'git']),
  resolvedVersion: z.string().nullable(),
  sourceIdentity: z.string().nullable(),
  root: z.string(),
  entry: z.union([z.literal('.'), FilePath]),
  files: z.array(z.discriminatedUnion('kind', [WireFile, Link])).max(100_000),
})
const Manifest = Installed.omit({ root: true, files: true }).extend({
  version: z.literal(2),
  pluginId: z.string(),
  generationId: z.string(),
  requestedSpec: z.string(),
  files: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('file'),
        path: FilePath,
        mode: z.number().int().min(0).max(511),
        object: ObjectReceipt,
      }),
      Link,
    ]),
  ),
})
export type HostedPluginManifest = z.infer<typeof Manifest>
const TASK = 'resource:plugins'
type Row = PersistenceTables['pluginArtifactGenerations']['$inferSelect']

export function createHostedPluginGenerations(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  readonly publications: HostedObjectPublications
  readonly helper: WorkspaceHelper
  readonly reference: (taskId: string, path: string) => string
  readonly openFile: (reference: string) => Promise<ReadableStream<Uint8Array>>
  readonly retainedReferences: (db?: PersistenceDb) => Promise<readonly string[]>
  readonly now?: () => number
}) {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const write = async <T>(run: (tx: PersistenceDb) => Promise<T>) => {
    const lease = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      return run(tx)
    })
  }
  const find = async (reference: string, db = input.db) => {
    const { pluginArtifactGenerations } = tablesOf(db)
    return (
      await db
        .select()
        .from(pluginArtifactGenerations)
        .where(eq(pluginArtifactGenerations.reference, reference))
        .limit(1)
    )[0]
  }
  const lock = async (tx: PersistenceDb, reference: string) => {
    const { pluginArtifactGenerations } = tablesOf(tx)
    await session.engine.lockAggregateRoot(
      tx,
      pluginArtifactGenerations,
      pluginArtifactGenerations.reference,
      reference,
    )
    return find(reference, tx)
  }
  const manifest = async (row: Row) => {
    if (row.objectId === null || row.digest === null || row.size === null)
      throw new Error('hosted-plugin-generation-not-ready')
    const value = Manifest.parse(
      JSON.parse(
        await new Response(
          await input.objects.open({ id: row.objectId, sha256: row.digest, size: row.size }),
        ).text(),
      ),
    )
    validatePluginMaterialTree(value.files, value.entry)
    if (
      value.pluginId !== row.pluginId ||
      value.generationId !== row.generationId ||
      generationReference(value.pluginId, value.generationId) !== row.reference
    )
      throw new Error('hosted-plugin-object-owner-mismatch')
    return value
  }
  const read = async (reference: string) => {
    const parsed = parseReference(reference)
    const row = await find(parsed.root)
    if (!row || row.state !== 'ready') throw new Error('hosted-plugin-generation-not-ready')
    const value = await manifest(row)
    if (parsed.entry !== null && parsed.entry !== value.entry)
      throw new Error('hosted-plugin-entry-mismatch')
    return value
  }
  const begin = (reference: string, pluginId: string, generationId: string, spec: string) =>
    write(async (tx) => {
      const epoch = input.fence.current().epoch
      const { pluginArtifactGenerations } = tablesOf(tx)
      await tx
        .insert(pluginArtifactGenerations)
        .values({
          reference,
          pluginId,
          generationId,
          spec,
          state: 'installing',
          epoch,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoNothing()
      const row = (await lock(tx, reference))!
      if (row.pluginId !== pluginId || row.generationId !== generationId || row.spec !== spec)
        throw new Error('hosted-plugin-request-changed')
      if (row.state !== 'installing') throw new Error('hosted-plugin-generation-retired')
      await tx
        .update(pluginArtifactGenerations)
        .set({ epoch, updatedAt: now() })
        .where(eq(pluginArtifactGenerations.reference, reference))
      return row
    })
  const install = async (pluginId: string, spec: string, generationId: string) => {
    const reference = generationReference(pluginId, generationId)
    const existing = await find(reference)
    if (existing?.state === 'ready') {
      const previous = await manifest(existing)
      if (previous.requestedSpec !== spec) throw new Error('hosted-plugin-request-changed')
      return {
        sourceKind: previous.sourceKind,
        resolvedVersion: previous.resolvedVersion,
        cachedPath: cachedReference(reference, previous.entry),
      }
    }
    const installation = await begin(reference, pluginId, generationId, spec)
    const installed = Installed.parse(
      installation.installedJson === null
        ? await input.helper.call(
            TASK,
            'plugin-installation',
            { method: 'install', pluginId, generationId, spec },
            { operationId: `plugin-install:${sha256Hex(reference)}`, timeoutMs: 180_000 },
          )
        : JSON.parse(installation.installedJson),
    )
    validatePluginMaterialTree(installed.files, installed.entry)
    const installedJson = JSON.stringify(installed)
    await write(async (tx) => {
      const row = await lock(tx, reference)
      if (row?.state !== 'installing') throw new Error('hosted-plugin-installation-not-writable')
      if (row.installedJson !== null && row.installedJson !== installedJson)
        throw new Error('hosted-plugin-installation-receipt-changed')
      const { pluginArtifactGenerations } = tablesOf(tx)
      await tx
        .update(pluginArtifactGenerations)
        .set({ installedJson, updatedAt: now() })
        .where(eq(pluginArtifactGenerations.reference, reference))
    })
    const regular = installed.files.filter(
      (file): file is z.infer<typeof WireFile> => file.kind === 'file',
    )
    const objects = await input.publications.publish(
      regular.map((file) => ({
        owner: HOSTED_PLUGIN_OWNER,
        key: fileKey(reference, file.path),
        scope: reference,
        content: {
          sha256: file.sha256,
          size: file.size,
          open: () => input.openFile(input.reference(TASK, `${installed.root}/${file.path}`)),
        },
      })),
      { concurrency: 4 },
    )
    const byPath = new Map(regular.map((file, index) => [file.path, objects[index]!]))
    const value: HostedPluginManifest = {
      version: 2,
      pluginId,
      generationId,
      requestedSpec: spec,
      sourceKind: installed.sourceKind,
      resolvedVersion: installed.resolvedVersion,
      sourceIdentity: installed.sourceIdentity,
      entry: installed.entry,
      files: installed.files.map((file) =>
        file.kind === 'symlink'
          ? file
          : {
              kind: 'file' as const,
              path: file.path,
              mode: file.mode,
              object: byPath.get(file.path)!,
            },
      ),
    }
    await input.publications.publish(
      [
        {
          owner: HOSTED_PLUGIN_OWNER,
          key: manifestKey(reference),
          scope: reference,
          bytes: Buffer.from(JSON.stringify(value)),
        },
      ],
      {
        async commit(tx, [object]) {
          const row = await lock(tx, reference)
          if (row?.state === 'ready' && row.objectId === object!.id) return
          if (row?.state !== 'installing')
            throw new Error('hosted-plugin-installation-not-writable')
          const { pluginArtifactGenerations } = tablesOf(tx)
          await tx
            .update(pluginArtifactGenerations)
            .set({
              state: 'ready',
              objectId: object!.id,
              digest: object!.sha256,
              size: object!.size,
              updatedAt: now(),
            })
            .where(eq(pluginArtifactGenerations.reference, reference))
        },
      },
    )
    return {
      sourceKind: value.sourceKind,
      resolvedVersion: value.resolvedVersion,
      cachedPath: cachedReference(reference, value.entry),
    }
  }
  const discard = async (reference: string, collecting = false) => {
    const parsed = parseReference(reference)
    const claimed = await write(async (tx) => {
      // Lock the generation before looking at current plugin pointers: every
      // publication of a cached path locks this same row.
      const generation = await lock(tx, parsed.root)
      if (generation === undefined) return 'physical' as const
      if (generation.state === 'retired') return 'retired' as const
      const { plugins, pluginArtifactGenerations } = tablesOf(tx)
      const current = await tx
        .select({ cachedPath: plugins.cachedPath })
        .from(plugins)
        .where(eq(plugins.id, parsed.pluginId))
      if (
        current.some(
          (plugin) =>
            plugin.cachedPath === parsed.root || plugin.cachedPath.startsWith(parsed.root + '/'),
        )
      )
        throw new Error('hosted-plugin-generation-in-use')
      if (
        collecting &&
        (await input.retainedReferences(tx)).some(
          (path) => path === parsed.root || path.startsWith(parsed.root + '/'),
        )
      )
        throw new Error('hosted-plugin-generation-retained')
      if (
        collecting &&
        generation.state === 'installing' &&
        generation.epoch === input.fence.current().epoch
      )
        throw new Error('hosted-plugin-installation-active')
      await tx
        .update(pluginArtifactGenerations)
        .set({ state: 'releasing', updatedAt: now() })
        .where(eq(pluginArtifactGenerations.reference, parsed.root))
      return 'claimed' as const
    })
    if (claimed === 'retired') return
    // The task-image writer guard decides whether physical cleanup is safe; a
    // lost reply resumes from the durable releasing phase.
    await input.helper.call(TASK, 'plugin-installation', {
      method: 'discard',
      pluginId: parsed.pluginId,
      generationId: parsed.generationId,
    })
    if (claimed === 'physical') return
    await write(async (tx) => {
      const row = await lock(tx, parsed.root)
      if (row?.state !== 'releasing') return
      await input.publications.release({ owner: HOSTED_PLUGIN_OWNER, scope: parsed.root }, tx)
      const { pluginArtifactGenerations } = tablesOf(tx)
      await tx
        .update(pluginArtifactGenerations)
        .set({ state: 'retired', updatedAt: now() })
        .where(eq(pluginArtifactGenerations.reference, parsed.root))
    })
  }
  const installer: PluginInstallerPort = {
    async install(pluginId, spec) {
      const generationId = ulid()
      const reference = generationReference(pluginId, generationId)
      try {
        const installed = await install(pluginId, spec, generationId)
        return { ...installed, cleanup: () => discard(reference) }
      } catch (error) {
        // Retain the durable retirement phase if the process, volume or lease
        // cannot yet prove that cleanup is safe. Preserve the installation error.
        await discard(reference).catch(() => undefined)
        throw error
      }
    },
    async checkForUpdate(pluginId, spec, currentCachedPath) {
      if (inferSourceKind(spec) === 'file')
        throw new ValidationError(
          'plugin-install-failed',
          'file source is externally managed and cannot be checked',
        )
      const currentRow = isLegacyHostedPluginReference(currentCachedPath)
        ? await find(parseReference(currentCachedPath).root)
        : undefined
      const current = currentRow ? await read(currentCachedPath) : null
      const generationId = ulid(),
        reference = generationReference(pluginId, generationId)
      try {
        await install(pluginId, spec, generationId)
        const latest = await read(reference)
        if (latest.sourceKind === 'file')
          throw new ValidationError(
            'plugin-install-failed',
            'file source is externally managed and cannot be checked',
          )
        if (
          !current ||
          current.pluginId !== pluginId ||
          current.sourceKind !== latest.sourceKind ||
          current.requestedSpec !== spec
        )
          return { available: false, latest: latest.resolvedVersion, identityStatus: 'unknown' }
        return {
          available: current.sourceIdentity !== latest.sourceIdentity,
          latest: latest.resolvedVersion,
          identityStatus: 'known',
        }
      } finally {
        await discard(reference)
      }
    },
  }
  const candidates = async (request: { now?: number; graceMs?: number }) => {
    const retained = await input.retainedReferences()
    const { pluginArtifactGenerations } = tablesOf(input.db)
    const rows = await input.db
      .select()
      .from(pluginArtifactGenerations)
      .where(ne(pluginArtifactGenerations.state, 'retired'))
    const epoch = input.fence.current().epoch
    return rows.filter(
      (row) =>
        !(row.state === 'installing' && row.epoch === epoch) &&
        !retained.some((path) => path === row.reference || path.startsWith(row.reference + '/')) &&
        (row.state !== 'ready' ||
          row.createdAt <= (request.now ?? Date.now()) - (request.graceMs ?? 86400_000)),
    )
  }
  const gc: PluginGenerationFilesystemGcPort = {
    hasCandidates: async (request) => (await candidates(request)).length > 0,
    async collect(request) {
      const removed: string[] = []
      for (const row of await candidates(request)) {
        if (
          [...request.referencedCachedPaths].some(
            (path) => path === row.reference || path.startsWith(row.reference + '/'),
          )
        )
          continue
        try {
          await discard(row.reference, true)
          removed.push(row.reference)
        } catch (error) {
          // A reference or an installation may have appeared after the scan.
          // The transaction rolls back its retirement claim in these cases.
          if (
            !(error instanceof Error) ||
            ![
              'hosted-plugin-generation-in-use',
              'hosted-plugin-generation-retained',
              'hosted-plugin-installation-active',
            ].includes(error.message)
          )
            throw error
        }
      }
      return removed
    },
  }
  return { installer, installGeneration: install, generationReference, read, discard, gc }
}
