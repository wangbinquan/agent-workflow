import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { digestSortedTree } from '../legacy/skillHash'
import { decodeLegacySkillBytes } from '@/platform/content/migration/skillContent'
import { DATABASE_SKILL_ROOT, rebaseSkillOperationPath } from '@/platform/content/locations/skill'
import { bytesDigest, valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  bootSourceRows,
  type BootUpgradeEnvironmentContribution,
} from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'

const fileSchema = z.strictObject({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  base64: z.string(),
})
export const FrozenSkillTreeSchema = z.strictObject({
  source: z.enum(['local-file', 'database-bytes']),
  reference: z.string(),
  present: z.boolean(),
  files: z.array(fileSchema),
  contentHash: z.string(),
})
export type FrozenSkillTree = z.infer<typeof FrozenSkillTreeSchema>
export const SkillBootFactSchema = z.strictObject({
  skillId: z.string(),
  name: z.string(),
  sourceDigest: z.string(),
  state: z.enum(['proven', 'husk', 'blocked']),
  reason: z.string().nullable(),
  live: FrozenSkillTreeSchema.nullable(),
  versions: z.array(
    z.strictObject({
      id: z.string(),
      version: z.number().int().positive(),
      sourceDigest: z.string(),
      tree: FrozenSkillTreeSchema,
    }),
  ),
  initialVersion: z.boolean(),
  rootEmpty: z.boolean(),
  roots: z.array(z.string()),
  operationsDigest: z.string(),
  references: z.array(z.string()),
})
export type SkillBootFact = z.infer<typeof SkillBootFactSchema>
export const skillBootFactId = (skillId: string) => `skill-content:${skillId}`
function freezeFiles(
  source: FrozenSkillTree['source'],
  reference: string,
  present: boolean,
  entries: readonly { path: string; bytes: Uint8Array }[],
): FrozenSkillTree {
  const files = entries
    .map(({ path, bytes }) => ({
      path,
      base64: Buffer.from(bytes).toString('base64'),
      size: bytes.byteLength,
      sha256: bytesDigest(bytes).slice(7),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error('v2-boot-skill-duplicate-path')
  return {
    source,
    reference,
    present,
    files,
    contentHash: digestSortedTree(
      files.map((file) => file.path),
      (path) => Buffer.from(files.find((file) => file.path === path)!.base64, 'base64'),
    ),
  }
}
async function readTree(path: string): Promise<FrozenSkillTree> {
  try {
    const root = await lstat(path)
    if (!root.isDirectory()) throw new Error('v2-boot-skill-tree-invalid')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return freezeFiles('local-file', path, false, [])
    throw error
  }
  const entries: { path: string; bytes: Uint8Array }[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) await walk(join(dir, item.name), path)
      else if (item.isFile()) entries.push({ path, bytes: await readFile(join(dir, item.name)) })
      else throw new Error('v2-boot-skill-tree-invalid')
    }
  }
  await walk(path, '')
  return freezeFiles('local-file', path, true, entries)
}
function sourceReferences(
  row: Readonly<Record<string, unknown>>,
  id: string,
  name: string,
): boolean {
  const match = (value: unknown, field: string): boolean => {
    if (typeof value === 'string') {
      if (/skill/i.test(field) && (value === id || value === name)) return true
      if (/^[[{]/.test(value)) {
        try {
          return match(JSON.parse(value), field)
        } catch {
          return /skill/i.test(field)
        }
      }
      return false
    }
    if (Array.isArray(value)) return value.some((entry) => match(entry, field))
    if (value && typeof value === 'object')
      return Object.entries(value).some(([key, entry]) =>
        match(entry, /skill/i.test(field) ? `${field}.${key}` : key),
      )
    return false
  }
  return (
    Object.entries(row).some(([field, value]) => match(value, field)) ||
    ((row.resource_type === 'skill' || row.resource_kind === 'skill') &&
      (row.resource_id === id ||
        row.resource_name === name ||
        row.resource_key === id ||
        row.resource_key === name))
  )
}
export function skillBootEnvironment(): BootUpgradeEnvironmentContribution {
  return {
    id: 'resource-catalog/boot-skills',
    async capture(input) {
      const skills = await bootSourceRows(input.source, 'skills')
      const versions = await bootSourceRows(input.source, 'skill_versions')
      const entries = await bootSourceRows(input.source, 'skill_content_entries')
      const operations = await bootSourceRows(input.source, 'skill_operations')
      const locks = await bootSourceRows(input.source, 'skill_operation_locks')
      const owners = new Map<string, Set<string>>()
      const facts: SkillBootFact[] = []
      for (const skill of skills) {
        const skillId = String(skill.id),
          name = String(skill.name)
        const fact: SkillBootFact = {
          skillId,
          name,
          sourceDigest: valueDigest(skill),
          state: 'blocked',
          reason: null,
          live: null,
          versions: [],
          initialVersion: false,
          rootEmpty: false,
          roots: [],
          operationsDigest: valueDigest({
            operations: operations.filter((op) => op.skill_id === skillId),
            locks: locks.filter((lock) => lock.locked_skill_id === skillId),
          }),
          references: [],
        }
        try {
          if (
            operations.some(
              (op) => op.skill_id === skillId && (op.active === 1 || op.active === true),
            ) ||
            locks.some((lock) => lock.locked_skill_id === skillId)
          )
            throw new Error('v2-boot-skill-operation-unsettled')
          const database =
            skill.managed_path === DATABASE_SKILL_ROOT ||
            entries.some((entry) => entry.skill_id === skillId)
          let physicalRoot: string | null = null
          if (!database) {
            if (typeof skill.managed_path !== 'string')
              throw new Error('v2-boot-skill-live-reference-missing')
            const stored = skill.managed_path.replaceAll('\\', '/')
            const match = /(?:^|\/)skills\/([^/]+)\/files\/?$/.exec(stored)
            if (!match || ![skillId, name].includes(match[1]!))
              throw new Error('v2-boot-skill-path-identity')
            // A canonical row owns its id root only. Its display name can be
            // another skill's id and never grants ownership of that directory.
            const roots = new Set([resolve(input.root.root, 'skills', skillId)])
            if (match[1] !== skillId) roots.add(resolve(input.root.root, 'skills', name))
            const presentRoots: string[] = []
            for (const path of roots) {
              const tree = await readTree(path)
              if (!tree.present) continue
              const names = await readdir(path)
              if (
                names.some((entry) =>
                  /^files\.op-[0-9A-HJKMNP-TV-Z]{26}\.(?:backup|staged)$/.test(entry),
                )
              )
                throw new Error('v2-boot-skill-operation-residue')
              presentRoots.push(path)
              const actual = await realpath(path)
              owners.set(actual, new Set([...(owners.get(actual) ?? []), skillId]))
              fact.roots.push(actual)
            }
            const distinct = [...new Set(fact.roots)].sort()
            if (distinct.length > 1) throw new Error('v2-boot-skill-root-conflict')
            physicalRoot = presentRoots[0] ?? resolve(input.root.root, 'skills', match[1]!)
            fact.rootEmpty = (await readTree(physicalRoot)).files.length === 0
          } else fact.rootEmpty = !entries.some((entry) => entry.skill_id === skillId)
          const treeFor = async (tree: string, stored: unknown): Promise<FrozenSkillTree> => {
            if (database) {
              const selected = entries.filter(
                (entry) => entry.skill_id === skillId && entry.tree === tree,
              )
              return freezeFiles(
                'database-bytes',
                JSON.stringify({ skillId, tree }),
                selected.length > 0,
                selected.map((entry) => ({
                  path: String(entry.path),
                  bytes: decodeLegacySkillBytes(String(entry.encoding), String(entry.content))
                    .bytes,
                })),
              )
            }
            const suffix = tree === 'live' ? 'files' : `versions/v${tree.slice(8)}/files`
            if (typeof stored !== 'string')
              throw new Error('v2-boot-skill-snapshot-reference-missing')
            const normalized = stored.replaceAll('\\', '/'),
              match = /(?:^|\/)skills\/([^/]+)\/(.*)$/.exec(normalized)
            if (
              !match ||
              ![skillId, name].includes(match[1]!) ||
              match[2]!.replace(/\/$/, '') !== suffix
            )
              throw new Error('v2-boot-skill-path-identity')
            rebaseSkillOperationPath(input.root.root, stored, match[1]!)
            return readTree(join(physicalRoot!, suffix))
          }
          fact.live = await treeFor('live', skill.managed_path)
          for (const version of versions
            .filter((version) => version.skill_id === skillId)
            .sort((a, b) => Number(a.version_index) - Number(b.version_index))) {
            const tree = await treeFor(`version:${version.version_index}`, version.files_path)
            if (!tree.present || !tree.files.some((file) => file.path === 'SKILL.md'))
              throw new Error('v2-boot-skill-snapshot-missing')
            if (version.content_hash !== null && version.content_hash !== tree.contentHash)
              throw new Error('v2-boot-skill-snapshot-hash-conflict')
            fact.versions.push({
              id: String(version.id),
              version: Number(version.version_index),
              sourceDigest: valueDigest(version),
              tree,
            })
          }
          if (!fact.live.files.some((file) => file.path === 'SKILL.md')) {
            if (
              skill.reservation_state === 'ready' &&
              skill.version_state === 'legacy-unbackfilled' &&
              !fact.versions.length &&
              fact.rootEmpty &&
              !fact.references.length
            )
              fact.state = 'husk'
            else
              throw new Error(
                fact.references.length
                  ? 'v2-boot-skill-husk-references'
                  : 'v2-boot-skill-main-missing',
              )
          } else {
            if (!fact.versions.length) {
              if (skill.reservation_state !== 'ready')
                throw new Error('v2-boot-skill-reservation-unsettled')
              fact.initialVersion = true
            } else {
              const authority = fact.versions.filter(
                (version) => version.version === skill.content_version,
              )
              if (
                authority.length !== 1 ||
                authority[0]!.tree.contentHash !== fact.live.contentHash
              )
                throw new Error('v2-boot-skill-authority-conflict')
            }
            fact.state = 'proven'
          }
        } catch (error) {
          fact.reason =
            error instanceof Error && error.message.startsWith('v2-')
              ? error.message
              : 'v2-boot-skill-content-unavailable'
          fact.state = 'blocked'
        }
        facts.push(fact)
      }
      for (const fact of facts) {
        if (fact.roots.some((path) => (owners.get(path)?.size ?? 0) > 1)) {
          fact.state = 'blocked'
          fact.reason = 'v2-boot-skill-ownership-conflict'
        }
      }
      const husks = facts.filter((fact) => fact.state === 'husk')
      if (husks.length) {
        const admitted = new Set(
          input.source.preflight.contract?.tables.map((table) => table.id) ?? [],
        )
        for (const table of input.source.preflight.tables) {
          if (
            !admitted.has(table.table) ||
            table.destination.kind !== 'business' ||
            table.disposition === 'archived' ||
            table.disposition === 'metadata' ||
            !table.rows ||
            [
              'skills',
              'skill_versions',
              'skill_content_entries',
              'skill_operations',
              'skill_operation_locks',
            ].includes(table.table)
          )
            continue
          // Raw chunks also cover admitted tables without a frozen decoding codec.
          let after = null
          for (;;) {
            const chunk = await input.source.reader.readRawChunk(table.table, after, 1000)
            for (const row of chunk.rows) {
              const values = Object.fromEntries(
                Object.entries(row.cells).map(([key, cell]) => [key, cell.value]),
              )
              for (const fact of husks)
                if (sourceReferences(values, fact.skillId, fact.name))
                  fact.references.push(`${table.table}:${valueDigest(row.key)}`)
            }
            if (chunk.lastKey === null || chunk.rows.length === 0) break
            after = chunk.lastKey
          }
        }
        for (const fact of husks)
          if (fact.references.length) {
            fact.references.sort()
            fact.state = 'blocked'
            fact.reason = 'v2-boot-skill-husk-references'
          }
      }
      const treeMaterial = (tree: FrozenSkillTree | null) =>
        tree === null
          ? null
          : {
              source: tree.source,
              reference: tree.reference,
              present: tree.present,
              contentHash: tree.contentHash,
              files: tree.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
            }
      return facts.map((fact) => ({
        id: skillBootFactId(fact.skillId),
        kind: 'skill-content',
        evidence: fact,
        material: {
          skillId: fact.skillId,
          state: fact.state,
          reason: fact.reason,
          initialVersion: fact.initialVersion,
          rootEmpty: fact.rootEmpty,
          roots: fact.roots,
          references: fact.references,
          live: treeMaterial(fact.live),
          versions: fact.versions.map((version) => ({
            id: version.id,
            version: version.version,
            tree: treeMaterial(version.tree),
          })),
        },
      }))
    },
  }
}
export function verifyFrozenSkillTree(tree: FrozenSkillTree): void {
  for (const file of tree.files) {
    const bytes = Buffer.from(file.base64, 'base64')
    if (
      bytes.toString('base64') !== file.base64 ||
      bytes.length !== file.size ||
      bytesDigest(bytes).slice(7) !== file.sha256
    )
      throw new Error('v2-boot-skill-frozen-bytes-mismatch')
  }
  const rebuilt = freezeFiles(
    tree.source,
    tree.reference,
    tree.present,
    tree.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.base64, 'base64') })),
  )
  if (rebuilt.contentHash !== tree.contentHash)
    throw new Error('v2-boot-skill-frozen-hash-mismatch')
}
