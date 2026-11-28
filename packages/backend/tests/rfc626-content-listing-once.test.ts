// RFC-626 design §4.4 / §4.7 / §9.10: the content listing is neither serialized nor parsed a
// second time on the way from the plan step to the backup.
//
// Why this file exists: on the reference installation the listing holds 828 thousand files —
// 170 MB as text. The final measurement of the automatic upgrade showed the resident memory
// of the process jump by 1.5 GB within a few seconds around the backup. Two things did it: the
// execution step parsed the listing its own process had written a moment before (a second copy
// of the largest object of the upgrade), and the backup wrote its `content-manifest.json`
// through `canonicalSchemaJson` (a sorted copy of every entry, then the whole text as one
// string) although the platform already had a writer that produces the same bytes piece by
// piece.
//
// Locks: the backup's listing is byte for byte `canonicalSchemaJson(manifest)`; the backup
// still copies skills and the configuration only and still refuses a copied file the listing
// does not name or a listed one that is gone; the inventory adapter hands its last listing over
// exactly once, for the file it wrote, and only when its assembly asked for that.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeV1Providers } from './helpers/rfc395V1Harness'
import {
  openFrozenSource,
  type SourceAccessInput,
} from '@/platform/persistence/migration/freeze/sourceAccess'
import { createSwitchBackup } from '@/platform/persistence/migration/freeze/backup'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { captureContentManifest } from '@/platform/content/inventory/manifest'
import { createContentInventoryAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/contentInventoryAdapter'

// Freezing the frozen head and writing a backup takes a few seconds on CI; allow 60 s.
setDefaultTimeout(60_000)

describeV1Providers('RFC-626 content listing, written and read once', (h) => {
  if (h.provider !== 'sqlite') return
  const input = async (): Promise<SourceAccessInput> => ({
    manifest: await h.manifest(),
    emptyTables: [],
    operationRoot: join(h.operationRoot, 'access'),
    location: {
      kind: 'sqlite-file',
      path: h.sqlitePath,
      pointerPath: join(h.operationRoot, 'pointer.json'),
    },
  })
  const home = () => ({
    kind: 'app-home' as const,
    root: join(h.operationRoot, 'home'),
    runsSupplied: true,
    objects: 'none' as const,
  })
  /** A home with one skill, a configuration and run files — the bulk of a real listing. */
  const populate = (root: string) => {
    mkdirSync(join(root, 'skills/id/files'), { recursive: true })
    writeFileSync(join(root, 'skills/id/files/SKILL.md'), 'body')
    writeFileSync(join(root, 'config.json'), '{}')
    for (const task of ['task-a', 'task-b', 'task-c']) {
      mkdirSync(join(root, 'runs', task), { recursive: true })
      for (const name of ['prompt.md', 'stdout.log', 'events.jsonl'])
        writeFileSync(join(root, 'runs', task, name), `${task}/${name}`)
    }
  }

  test("the backup's listing is the canonical text of the manifest, byte for byte", async () => {
    await h.install()
    const source = await openFrozenSource(await input())
    const root = home()
    populate(root.root)
    try {
      const manifest = await captureContentManifest({
        source,
        root,
        destination: join(h.operationRoot, 'content.json'),
      })
      expect(manifest.files.map((file) => file.path)).toContain('runs/task-b/stdout.log')
      const receipt = await createSwitchBackup({
        sourcePath: h.sqlitePath,
        frozen: source,
        destination: join(h.operationRoot, 'backup'),
        contentManifest: manifest,
      })
      expect(readFileSync(join(receipt.path!, 'content-manifest.json'), 'utf8')).toBe(
        canonicalSchemaJson(manifest),
      )
      expect(receipt.contentManifestDigest).toBe(manifest.digest)
      // Skills and the configuration are copied; run files are listed, not copied.
      expect(readFileSync(join(receipt.path!, 'skills/id/files/SKILL.md'), 'utf8')).toBe('body')
      expect(existsSync(join(receipt.path!, 'config.json'))).toBe(true)
      expect(existsSync(join(receipt.path!, 'runs'))).toBe(false)
    } finally {
      await source.close()
    }
  })

  test('a listing without files is written the same way', async () => {
    await h.install()
    const source = await openFrozenSource(await input())
    const root = home()
    mkdirSync(root.root, { recursive: true })
    try {
      const manifest = await captureContentManifest({
        source,
        root,
        destination: join(h.operationRoot, 'content.json'),
      })
      expect(manifest.files).toEqual([])
      const receipt = await createSwitchBackup({
        sourcePath: h.sqlitePath,
        frozen: source,
        destination: join(h.operationRoot, 'backup'),
        contentManifest: manifest,
      })
      expect(readFileSync(join(receipt.path!, 'content-manifest.json'), 'utf8')).toBe(
        canonicalSchemaJson(manifest),
      )
    } finally {
      await source.close()
    }
  })

  test('a copied file the listing does not name, or a listed one that is gone, still refuses the backup', async () => {
    await h.install()
    const source = await openFrozenSource(await input())
    const root = home()
    populate(root.root)
    try {
      const manifest = await captureContentManifest({
        source,
        root,
        destination: join(h.operationRoot, 'content.json'),
      })
      const skill = 'skills/id/files/SKILL.md'
      // The skill file is on disk and copied, but the listing has run files only.
      await expect(
        createSwitchBackup({
          sourcePath: h.sqlitePath,
          frozen: source,
          destination: join(h.operationRoot, 'unlisted'),
          contentManifest: {
            ...manifest,
            files: manifest.files.filter((file) => file.path !== skill),
          },
        }),
      ).rejects.toThrow('switch-backup-content-unlisted')
      // The listing names a skill file that is not on disk.
      await expect(
        createSwitchBackup({
          sourcePath: h.sqlitePath,
          frozen: source,
          destination: join(h.operationRoot, 'missing'),
          contentManifest: {
            ...manifest,
            files: [
              ...manifest.files,
              { path: 'skills/id/files/GONE.md', size: 4, mtimeMs: 1_000 },
            ],
          },
        }),
      ).rejects.toThrow('switch-backup-content-missing')
      // A run file that is listed but gone is not the backup's business: it copies none.
      const receipt = await createSwitchBackup({
        sourcePath: h.sqlitePath,
        frozen: source,
        destination: join(h.operationRoot, 'runs-gone'),
        contentManifest: {
          ...manifest,
          files: [...manifest.files, { path: 'runs/task-z/gone.log', size: 4, mtimeMs: 1_000 }],
        },
      })
      expect(existsSync(join(receipt.path!, 'skills/id/files/SKILL.md'))).toBe(true)
    } finally {
      await source.close()
    }
  })

  test('the inventory adapter hands its last listing over once, for the file it wrote', async () => {
    await h.install()
    const source = await openFrozenSource(await input())
    const root = home()
    populate(root.root)
    try {
      const adapter = createContentInventoryAdapter({ handOver: true })
      const first = join(h.operationRoot, 'plan-content/1.json')
      const manifest = await adapter.capture({ source, root, destination: first })
      // Another file: nothing, and the listing stays for the file it belongs to.
      expect(adapter.takeCaptured!(join(h.operationRoot, 'plan-content/2.json'))).toBeNull()
      // The same file however its path is spelled: the very object, not a copy.
      expect(adapter.takeCaptured!(join(h.operationRoot, 'plan-content/./1.json'))).toBe(manifest)
      // Once: whoever took it owns it now.
      expect(adapter.takeCaptured!(first)).toBeNull()

      // A later listing replaces an earlier one that nobody took.
      const second = join(h.operationRoot, 'plan-content/2.json')
      await adapter.capture({ source, root, destination: first })
      const later = await adapter.capture({ source, root, destination: second })
      expect(adapter.takeCaptured!(first)).toBeNull()
      expect(adapter.takeCaptured!(second)).toBe(later)
    } finally {
      await source.close()
    }
  })

  test('an adapter that was not asked to hand over keeps nothing', async () => {
    await h.install()
    const source = await openFrozenSource(await input())
    const root = home()
    populate(root.root)
    try {
      const adapter = createContentInventoryAdapter()
      const destination = join(h.operationRoot, 'plan-content/1.json')
      await adapter.capture({ source, root, destination })
      expect(adapter.takeCaptured!(destination)).toBeNull()
    } finally {
      await source.close()
    }
  })
})
