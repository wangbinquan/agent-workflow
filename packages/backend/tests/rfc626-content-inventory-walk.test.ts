// RFC-626 §4.4 / §4.7 (design §7 "耗时与编排"): the content walk lists directories from typed
// directory reads and stats each file once, and it serializes the manifest once for both the
// digest and the written file. None of that may change what an inventory records: for the same
// tree the manifest file and its digest must be byte-identical to the walk before RFC-626.
// `referenceManifest` below restates that earlier walk (existsSync then statSync per entry,
// `readdirSync().sort()`, the digest over one canonical string of the filtered payload); every
// tree here, including empty directories, nesting, symbolic links and unreadable entries, must
// come out the same from both.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  captureContentManifest,
  verifyContentManifest,
  type InventoryFileSystem,
} from '@/platform/content/inventory/manifest'
import {
  inventoryHomePath,
  inventoryManifestPath,
  inventoryRelativePath,
} from '@/platform/content/inventory/resolvers'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schema/canonical'
import type {
  ContentRootSpec,
  FreezeContentManifest,
  FrozenSourceHandle,
} from '@/platform/persistence/migration/run/types'
import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'

const onWindows = process.platform === 'win32'
const privileged = typeof process.getuid === 'function' && process.getuid() === 0

let directory: string
let root: ContentRootSpec
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rfc626-walk-'))
  root = { kind: 'app-home', root: join(directory, 'home'), runsSupplied: true, objects: 'none' }
  mkdirSync(root.root)
}, 5_000)
afterEach(() => rmSync(directory, { recursive: true, force: true }), 5_000)

function emptySource(): FrozenSourceHandle {
  const preflight: SourcePreflight = {
    version: 1,
    kind: 'sqlite-file',
    sourceVersion: 'fixture',
    contract: null,
    sourceGenerationId: 'dbg_fixture',
    watermark: 'fixture',
    fingerprint: {
      version: 1,
      provider: 'sqlite',
      evidence: 'physical-catalog-and-journal',
      catalog: [],
      catalogDigest: 'fixture',
      journal: [],
      journalEntryCount: 0,
      tableRows: {},
      digest: 'fixture',
    },
    identityHighWater: [],
    identityEvidence: 'physical',
    requiresOfflineUpgrade: false,
    tables: [],
    expectedAbsent: [],
    content: [],
  }
  return {
    preflight,
    preUpgrade: null,
    watermark: preflight.watermark,
    evidenceRoot: null,
    async close() {},
    reader: {
      kind: preflight.kind,
      async preflight() {
        return preflight
      },
      async assertUnchanged() {},
      async readChunk() {
        throw new Error('no fixture tables')
      },
      async readRawChunk() {
        throw new Error('no fixture tables')
      },
      async close() {},
    },
  }
}

/** The inventory walk and manifest assembly as they were before RFC-626. */
function referenceManifest(spec: ContentRootSpec): FreezeContentManifest {
  const home = resolve(spec.root)
  const directories = new Set<string>([home])
  const files = new Map<string, FreezeContentManifest['files'][number]>()
  const visit = (path: string) => {
    if (!existsSync(path)) return
    const relative = inventoryManifestPath(spec, path)
    if (
      spec.kind === 'backup' &&
      !spec.runsSupplied &&
      /^(runs|logs|evidence)(\/|$)/.test(relative)
    )
      return
    const info = statSync(path)
    if (info.isDirectory()) {
      if (directories.has(path) && path !== home) return
      directories.add(path)
      for (const name of readdirSync(path).sort()) visit(join(path, name))
    } else if (info.isFile())
      files.set(relative, { path: relative, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) })
  }
  for (const name of ['skills', 'runs', 'logs', 'evidence', 'config.json'])
    visit(inventoryHomePath(spec, name))
  const payload = {
    version: 1 as const,
    roots: [
      home,
      ...[...directories]
        .filter((path) => path !== home)
        .map((path) => join(home, inventoryManifestPath(spec, path)))
        .sort(),
    ],
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    objects: [] as FreezeContentManifest['objects'][number][],
    databaseTrees: [] as FreezeContentManifest['databaseTrees'][number][],
  }
  const digest = digestSchemaContract({
    ...payload,
    roots: payload.roots
      .map((path) => inventoryRelativePath(home, path))
      .filter((path) => path !== 'logs' && !path.startsWith('logs/')),
    files: payload.files.filter((file) => file.path !== 'logs' && !file.path.startsWith('logs/')),
  })
  return { ...payload, digest }
}

async function capture(fileSystem?: InventoryFileSystem) {
  const destination = join(directory, 'operation', 'content-listing.json')
  const manifest = await captureContentManifest({
    root,
    source: emptySource(),
    destination,
    ...(fileSystem ? { fileSystem } : {}),
  })
  return { manifest, text: readFileSync(destination, 'utf8') }
}

async function expectReferenceOutput(): Promise<FreezeContentManifest> {
  const expected = referenceManifest(root)
  const { manifest, text } = await capture()
  expect(text).toBe(canonicalSchemaJson(expected))
  expect(manifest).toEqual(expected)
  expect(manifest.digest).toBe(expected.digest)
  expect(() => verifyContentManifest(JSON.parse(text) as FreezeContentManifest)).not.toThrow()
  return manifest
}

function file(path: string, bytes: string | Uint8Array, home = root.root): string {
  const absolute = join(home, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, bytes)
  return absolute
}

function populate(home = root.root) {
  file('config.json', '{}', home)
  utimesSync(file('skills/a/files/SKILL.md', '# a\n', home), 1_700_000_000.123, 1_700_000_000.987)
  file('skills/a/files/nested/deep/data.bin', new Uint8Array([0, 255, 128]), home)
  file('skills/a/files/技能.md', '技能', home)
  file('skills/a/files/𝄞 clef.md', 'astral', home)
  file('skills/a/files/Zeta', 'Z', home)
  file('skills/a/files/alpha', 'a', home)
  file('skills/a/files/10.txt', '10', home)
  file('skills/a/files/9.txt', '9', home)
  file('skills/a/files/empty', '', home)
  if (!onWindows) {
    file('skills/a/files/quote"name', 'q', home)
    file('skills/a/files/back\\slash', 'b', home)
  }
  mkdirSync(join(home, 'skills/empty/files'), { recursive: true })
  file('runs/task/prompts/run.md', 'prompt', home)
  file('runs/task/a/b/c/d.txt', 'deep', home)
  mkdirSync(join(home, 'runs/empty'), { recursive: true })
  file('logs/daemon.log', 'log', home)
  file('logs/rotated/daemon.1', 'rotated', home)
  file('evidence/e.json', '[]', home)
  file('stray.txt', 'outside the inventoried names', home)
}

function link() {
  symlinkSync(join(root.root, 'skills/a/files/SKILL.md'), join(root.root, 'skills/a/link.md'))
  symlinkSync(join(root.root, 'runs/task'), join(root.root, 'runs/alias'))
  symlinkSync(join(root.root, 'nowhere'), join(root.root, 'runs/dangling'))
}

test('nested, empty, unicode and log entries produce the pre-RFC-626 manifest bytes and digest', async () => {
  populate()
  const manifest = await expectReferenceOutput()
  const paths = manifest.files.map((entry) => entry.path)
  expect(paths).toContain('skills/a/files/nested/deep/data.bin')
  expect(paths).toContain('skills/a/files/𝄞 clef.md')
  expect(paths).toContain('logs/rotated/daemon.1')
  expect(paths).toContain('config.json')
  expect(paths).not.toContain('stray.txt')
  expect(manifest.roots).toContain(join(root.root, 'skills/empty/files'))
  expect(manifest.roots).toContain(join(root.root, 'runs/empty'))
  // Fractional modification times are truncated to whole milliseconds, as before.
  const skill = manifest.files.find((entry) => entry.path === 'skills/a/files/SKILL.md')!
  expect(skill.mtimeMs).toBe(Math.trunc(statSync(join(root.root, skill.path)).mtimeMs))
  expect(Number.isInteger(skill.mtimeMs)).toBe(true)
})

test('an empty home produces the pre-RFC-626 manifest', async () => {
  const manifest = await expectReferenceOutput()
  expect(manifest.files).toEqual([])
  expect(manifest.roots).toEqual([resolve(root.root)])
})

test.skipIf(onWindows)(
  'symbolic links are followed to files and directories and dangling ones skipped, as before',
  async () => {
    populate()
    link()
    const manifest = await expectReferenceOutput()
    const paths = manifest.files.map((entry) => entry.path)
    expect(paths).toContain('skills/a/link.md')
    expect(paths).toContain('runs/alias/prompts/run.md')
    expect(paths.some((path) => path.startsWith('runs/dangling'))).toBe(false)
    expect(manifest.roots).toContain(join(root.root, 'runs/alias'))
  },
)

test.skipIf(onWindows || privileged)(
  'unreadable entries keep their earlier handling: listed, silently skipped, or failing the capture',
  async () => {
    populate()
    const locked = file('runs/locked.txt', 'no read permission')
    const opaque = join(root.root, 'runs/opaque')
    file('runs/opaque/child.txt', 'behind a directory without search permission')
    file('runs/opaque/inner/grandchild.txt', 'deeper')
    const sealed = join(root.root, 'skills/sealed')
    file('skills/sealed/SKILL.md', 'behind a directory that cannot be listed')
    try {
      chmodSync(locked, 0o000)
      chmodSync(opaque, 0o444)
      const manifest = await expectReferenceOutput()
      const paths = manifest.files.map((entry) => entry.path)
      // stat needs no read permission on the file itself.
      expect(paths).toContain('runs/locked.txt')
      // A listable directory without search permission: listed itself, its children unseen.
      expect(manifest.roots).toContain(opaque)
      expect(paths.some((path) => path.startsWith('runs/opaque/'))).toBe(false)

      chmodSync(sealed, 0o000)
      let expected: unknown
      try {
        referenceManifest(root)
      } catch (error) {
        expected = error
      }
      expect(expected).toMatchObject({ code: 'EACCES' })
      await expect(capture()).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      for (const path of [locked, opaque, sealed]) chmodSync(path, 0o755)
    }
  },
)

test('a backup without supplied runs leaves run content out exactly as before', async () => {
  populate()
  root = { ...root, kind: 'backup', runsSupplied: false }
  const manifest = await expectReferenceOutput()
  expect(manifest.files.some((entry) => /^(runs|logs|evidence)(\/|$)/.test(entry.path))).toBe(false)
  expect(manifest.files.map((entry) => entry.path)).toContain('skills/a/files/SKILL.md')
})

test('a restore with an external run-content root lists the same entries as before', async () => {
  populate()
  const external = join(directory, 'external')
  file('runs/task/prompt', 'supplied run', external)
  file('runs/other/nested/file', 'nested', external)
  file('skills/x/files/SKILL.md', 'not the backup skill', external)
  root = { ...root, kind: 'backup', runContentRoot: external, runsSupplied: true }
  const manifest = await expectReferenceOutput()
  const paths = manifest.files.map((entry) => entry.path)
  expect(paths).toContain('runs/task/prompt')
  expect(paths).not.toContain('runs/task/prompts/run.md')
  expect(paths.some((path) => path.includes('..'))).toBe(false)
})

test.skipIf(onWindows)(
  'each file is stat’ed once, directories are listed without a stat, and nothing asks existsSync',
  async () => {
    populate()
    link()
    const calls = { readDirectory: [] as string[], stat: [] as string[], exists: [] as string[] }
    const counting: InventoryFileSystem = {
      readDirectory(path) {
        calls.readDirectory.push(path)
        return readdirSync(path, { withFileTypes: true })
      },
      stat(path) {
        calls.stat.push(path)
        return statSync(path)
      },
      exists(path) {
        calls.exists.push(path)
        return existsSync(path)
      },
    }
    const expected = referenceManifest(root)
    const { manifest, text } = await capture(counting)
    expect(text).toBe(canonicalSchemaJson(expected))
    const home = resolve(root.root)
    const statted = new Set([
      // The five inventoried names, whose type no directory read reports.
      ...['skills', 'runs', 'logs', 'evidence', 'config.json'].map((name) => join(home, name)),
      // Every listed file once (including the file reached through a link).
      ...manifest.files.map((entry) => join(home, entry.path)),
      // Links are followed with one stat: to a directory, and to nothing.
      join(home, 'runs/alias'),
      join(home, 'runs/dangling'),
    ])
    expect(calls.stat).toHaveLength(new Set(calls.stat).size)
    expect(new Set(calls.stat)).toEqual(statted)
    expect(calls.exists).toEqual([])
    expect(calls.readDirectory).toHaveLength(manifest.roots.length - 1)
    expect(new Set(calls.readDirectory)).toEqual(new Set(manifest.roots.slice(1)))
  },
)
