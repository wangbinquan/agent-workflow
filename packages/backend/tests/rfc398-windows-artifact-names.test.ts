// RFC-398 regression lock: epoch-switch artifacts are named after digests
// (`plans/sha256:<hex>.json`, `acknowledgements/sha256:<hex>.json`). On Windows a colon in a file
// name addresses an NTFS alternate data stream, so the write-once temporary opened as a stream of a
// file called `sha256` and the publishing `link` failed with EINVAL. Every SQLite upgrade from an
// epoch-1 release (v0.18.10, v0.18.18, v0.18.19, v0.19.2) stopped at its first plan on the Windows
// release-upgrade gate (nightly 41303628365); v0.19.3 passed only because it is already epoch 2.
// Windows file names now map NTFS-reserved characters to `-`; POSIX names stay byte-identical so
// operation directories written by earlier releases keep resolving.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  encodeMigrationKey,
  canonicalValue,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { epochArtifactPath, epochArtifactPathFor } from '@/platform/persistence/migration/run/paths'
import { epochArtifactFileName } from '@/platform/persistence/migration/artifactFileName'
import { createFileEpochSwitchJournal } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import { fixtureDigest, makeSwitchFixture } from './helpers/rfc395V3SwitchFixture'

const RESERVED = /[<>:"|?*]/
const HEX = 'ab'.repeat(32)

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) =>
    relative(root, join(entry.parentPath, entry.name)),
  )
}

test('Windows file names map NTFS-reserved characters; POSIX names and the root are unchanged', () => {
  expect(epochArtifactPathFor('win32', '/r', `plans/sha256:${HEX}.json`)).toBe(
    join('/r', `plans/sha256-${HEX}.json`),
  )
  expect(epochArtifactPathFor('win32', '/r', 'a<b>c:d"e|f?g*h.json')).toBe(
    join('/r', 'a-b-c-d-e-f-g-h.json'),
  )
  // Only the references are file names: a drive colon in the root is never rewritten.
  expect(epochArtifactPathFor('win32', 'C:/home', 'x:y')).toBe(join('C:/home', 'x-y'))
  // Mapping is idempotent, so relocating an already-local path cannot change it again.
  const once = epochArtifactPathFor('win32', '/r', `acknowledgements/sha256:${HEX}.json`)
  expect(epochArtifactPathFor('win32', '/r', relative('/r', once))).toBe(once)
  for (const platform of ['linux', 'darwin'] as const)
    expect(epochArtifactPathFor(platform, '/r', `plans/sha256:${HEX}.json`)).toBe(
      join('/r', `plans/sha256:${HEX}.json`),
    )
  expect(epochArtifactPath('/r', `plans/sha256:${HEX}.json`)).toBe(
    epochArtifactPathFor(process.platform, '/r', `plans/sha256:${HEX}.json`),
  )
  // The runtime journal and the offline runner share this one rule.
  expect(epochArtifactFileName('win32', `plans/sha256:${HEX}.md`)).toBe(`plans/sha256-${HEX}.md`)
  expect(epochArtifactFileName('linux', `plans/sha256:${HEX}.md`)).toBe(`plans/sha256:${HEX}.md`)
})

test('the Windows journal writes, rereads and conflict-checks digest-named artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc398-win-names-'))
  try {
    const journal = createFileEpochSwitchJournal({ root, platform: 'win32' })
    const op = 'dbm_e2_windows_names'
    const name = `plans/sha256:${HEX}.json`
    const written = await journal.writeOnce(op, name, Buffer.from('{"plan":1}'))
    expect(written.path).toBe(join(root, op, `plans/sha256-${HEX}.json`))
    expect(Buffer.from((await journal.readArtifact(op, name))!).toString()).toBe('{"plan":1}')
    // Write-once keeps its contract under the mapped name.
    await journal.writeOnce(op, name, Buffer.from('{"plan":1}'))
    await expect(journal.writeOnce(op, name, Buffer.from('{"plan":2}'))).rejects.toThrow(
      'v3-write-once-conflict',
    )
    const artifacts = journal.artifacts!(op)
    const digest = await artifacts.put(`evidence/sha256:${HEX}.json`, Buffer.from('evidence'))
    const copy = await artifacts.get(`evidence/sha256:${HEX}.json`, digest)
    expect(copy).toBe(join(root, op, `evidence/sha256-${HEX}.json`))
    expect(filesUnder(root).filter((path) => RESERVED.test(path))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the host journal keeps existing names, so earlier operation directories still resolve', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc398-host-names-'))
  try {
    const journal = createFileEpochSwitchJournal({ root })
    const op = 'dbm_e2_host_names'
    const name = `plans/sha256:${HEX}.json`
    const written = await journal.writeOnce(op, name, Buffer.from('{}'))
    expect(written.path).toBe(epochArtifactPath(join(root, op), name))
    if (process.platform !== 'win32')
      expect(existsSync(join(root, op, `plans/sha256:${HEX}.json`))).toBe(true)
    expect(Buffer.from((await journal.readArtifact(op, name))!).toString()).toBe('{}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a whole acknowledged epoch switch runs with Windows file names', async () => {
  const f = makeSwitchFixture()
  const migrations = join(f.root, 'database-migrations')
  f.deps.journal = createFileEpochSwitchJournal({ root: migrations, platform: 'win32' })
  try {
    f.control.planBlocks = [
      {
        code: 'v2-code-history-unfinished',
        scope: 'row',
        sourceTable: 'code_work_items',
        sourceKey: encodeMigrationKey('code_work_items', [canonicalValue('retired')]),
        sourcePhase: 'current',
        taskId: null,
        runId: null,
        missingFields: [],
        detail: { rowDigest: fixtureDigest },
        acknowledgeable: true,
      },
    ]
    const planned = await f.app.plan({})
    const acknowledged = await f.app.acknowledge({
      operationId: f.operationId,
      items: planned.plan.payload.blocks
        .filter((item) => item.remediation.action === 'acknowledge')
        .map((item) => item.id),
      reason: 'Archive retired work',
      by: 'operator',
    })
    expect(acknowledged.plan.payload.operatorDecisions).toHaveLength(1)
    const result = await f.app.run({
      operationId: f.operationId,
      approve: acknowledged.plan.approvalDigest,
    })
    expect(result.phase).toBe('activated')
    const files = filesUnder(join(migrations, f.operationId))
    expect(files.filter((path) => RESERVED.test(path))).toEqual([])
    const plan = result.journal.payload.plan!.digest
    expect(files).toContain(join('plans', `${plan.replace(':', '-')}.json`))
    expect(files).toContain(join('plans', `${plan.replace(':', '-')}.md`))
    expect(files.some((path) => path.startsWith(join('acknowledgements', 'sha256-')))).toBe(true)
    const receipt = await f.app.receipt({ operationId: f.operationId, kind: 'plan' })
    expect(JSON.parse(receipt.json).digest).toBe(plan)
  } finally {
    f.close()
  }
})
