// RFC-395 T19: keep current/pending/approved manifests, clone immutable file artifacts.
import { expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { pruneEpochPlanContent } from '@/modules/system-operations/infrastructure/epochSwitch/planContent'
import {
  createFileEpochSwitchJournal,
  createLocalEpochArtifacts,
} from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import {
  createMetaEpochSwitchJournal,
  type HostedEpochArtifacts,
} from '@/modules/system-operations/infrastructure/epochSwitch/metaJournal'
import { persistSourceDirectory } from '@/platform/persistence/migration/freeze/artifacts'
import { describeV3Providers } from './helpers/rfc395V3Harness'
import { makeSwitchFixture } from './helpers/rfc395V3SwitchFixture'

function retainedManifests(root: string) {
  const files = ['current', 'pending', 'approved', 'obsolete', 'duplicate']
  for (const file of files) {
    const path = join(root, `runs/run/plan-content/${file}.json`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ digest: file === 'duplicate' ? 'current' : file }))
  }
  return [
    { path: 'runs/run/plan-content/current.json', digest: 'current' },
    { path: 'runs/run/plan-content/pending.json', digest: 'pending' },
    // A retained plan written by the previous binary has only a digest.
    { digest: 'approved' },
  ]
}

test('T19 cleanup preserves pending paths, legacy approved digests and non-manifest files', () => {
  const root = mkdtempSync(join(tmpdir(), 't19p-manifests-'))
  try {
    const references = retainedManifests(root)
    writeFileSync(join(root, 'runs/run/plan-content/keep.tmp'), 'pending write')
    pruneEpochPlanContent(root, references)
    expect(readdirSync(join(root, 'runs/run/plan-content')).sort()).toEqual([
      'approved.json',
      'current.json',
      'keep.tmp',
      'pending.json',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T19 cleanup keeps an unreadable manifest instead of failing the already saved plan', () => {
  const root = mkdtempSync(join(tmpdir(), 't19p-manifests-'))
  try {
    const references = retainedManifests(root)
    // A crash during a previous plan can leave a truncated manifest behind.
    writeFileSync(join(root, 'runs/run/plan-content/truncated.json'), '{"digest":"obso')
    expect(() => pruneEpochPlanContent(root, references)).not.toThrow()
    expect(readdirSync(join(root, 'runs/run/plan-content')).sort()).toEqual([
      'approved.json',
      'current.json',
      'pending.json',
      'truncated.json',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('T19 replans delete superseded manifests but retain the exact approved plan across interruption', async () => {
  const f = makeSwitchFixture()
  f.deps.journal = createFileEpochSwitchJournal({
    root: join(f.root, 'database-migrations'),
    async prunePlanContent(root, references) {
      pruneEpochPlanContent(root, references)
    },
  })
  const capture = f.deps.content.capture
  f.deps.content.capture = async (input) => {
    const manifest = await capture(input)
    mkdirSync(dirname(input.destination), { recursive: true })
    writeFileSync(input.destination, JSON.stringify(manifest))
    return manifest
  }
  try {
    const first = await f.app.plan({})
    const path = (plan: typeof first) =>
      join(f.deps.journal.operationRoot(f.operationId), plan.plan.payload.contentManifestPath!)
    expect(existsSync(path(first))).toBe(true)
    f.control.inject = (point) => {
      if (point === 'after-backup-file') throw new Error('T19 interrupted backup')
    }
    await expect(
      f.app.run({ operationId: f.operationId, approve: first.plan.approvalDigest }),
    ).rejects.toThrow('T19 interrupted backup')
    f.control.inject = undefined
    f.control.clock++
    const second = await f.app.plan({ operationId: f.operationId })
    f.control.clock++
    const third = await f.app.plan({ operationId: f.operationId })
    expect(existsSync(path(first))).toBe(true)
    expect(existsSync(path(second))).toBe(false)
    expect(existsSync(path(third))).toBe(true)
    expect((await f.deps.journal.read(f.operationId))!.payload.approvals).toHaveLength(1)
  } finally {
    f.close()
  }
})

test('T19 local clone-or-copy preserves bytes, digests and snapshot independence; streams still work', async () => {
  const root = mkdtempSync(join(tmpdir(), 't19p-clone-'))
  try {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 123)
    const source = join(root, 'source.sqlite')
    writeFileSync(source, bytes)
    const port = createLocalEpochArtifacts(join(root, 'operation'))
    const digest = await port.putFile!('backup/db.sqlite', source)
    expect(digest).toBe(bytesDigest(bytes))
    writeFileSync(source, 'changed after snapshot')
    const materialized = await port.get('backup/db.sqlite', digest)
    expect(readFileSync(materialized)).toEqual(bytes)
    writeFileSync(materialized, 'changed materialization')
    expect(readFileSync(await port.get('backup/db.sqlite', digest))).toEqual(bytes)
    const directory = join(root, 'input')
    mkdirSync(directory)
    writeFileSync(join(directory, 'db.sqlite'), bytes)
    let fileCalls = 0
    await persistSourceDirectory(
      {
        ...port,
        async putFile(name, path) {
          fileCalls++
          return port.putFile!(name, path)
        },
      },
      'directory',
      directory,
    )
    expect(fileCalls).toBe(1)
    const streamed = await port.put(
      'stream',
      (async function* () {
        yield bytes.subarray(0, 100)
        yield bytes.subarray(100)
      })(),
    )
    expect(streamed).toBe(digest)
    expect(readFileSync(await port.get('stream', streamed))).toEqual(bytes)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describeV3Providers('T19 durable journal hygiene and hosted file artifacts', (h) => {
  test('both journal providers prune local manifests and rematerialize unchanged hosted chunks', async () => {
    await h.installHead()
    const stored = new Map<string, Uint8Array>()
    const artifacts: HostedEpochArtifacts = {
      async writeOnce(_operation, name, bytes) {
        stored.set(name, bytes.slice())
        return { path: null, digest: bytesDigest(bytes) }
      },
      async read(_operation, name) {
        return stored.get(name) ?? null
      },
    }
    const makeJournal = () =>
      createMetaEpochSwitchJournal({
        connection: h.target,
        artifacts,
        scratchRoot: join(h.appHome, 't19-local'),
        async acquireOperationLock() {
          return { release() {} }
        },
      })
    const journal = makeJournal()
    const root = journal.operationRoot(h.operationId)
    await journal.prunePlanContent!(h.operationId, retainedManifests(root))
    expect(existsSync(join(root, 'runs/run/plan-content/obsolete.json'))).toBe(false)
    expect(existsSync(join(root, 'runs/run/plan-content/approved.json'))).toBe(true)
    const bytes = Buffer.alloc(1024 * 1024, 42)
    const source = join(h.appHome, 't19-source.sqlite')
    writeFileSync(source, bytes)
    const digest = await journal.artifacts!(h.operationId).putFile!(
      'backup/database.sqlite',
      source,
    )
    expect(digest).toBe(bytesDigest(bytes))
    rmSync(root, { recursive: true, force: true })
    expect(
      readFileSync(
        await makeJournal().artifacts!(h.operationId).get('backup/database.sqlite', digest),
      ),
    ).toEqual(bytes)
    expect([...stored.keys()].some((key) => key.endsWith('/manifest.json'))).toBe(true)
  })
})
