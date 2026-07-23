import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionIdentityFailure } from '@/services/runtime/opencode/failure'
import {
  removeSealedTree,
  snapshotManagedSkillTree,
} from '@/services/runtime/opencode/sealedInputs'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc224-skill-seal-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await removeSealedTree(root)
})

async function fixture() {
  const root = tempRoot()
  const source = join(root, 'source')
  const destination = join(root, 'seal', 'skill')
  await mkdir(join(source, 'scripts'), { recursive: true })
  await writeFile(join(source, 'SKILL.md'), '# Safe skill\n')
  await writeFile(join(source, 'scripts', 'run.sh'), '#!/bin/sh\nprintf ok\n', { mode: 0o755 })
  await writeFile(join(source, 'data.json'), '{"b":2,"a":1}\n')
  return { root, source, destination }
}

function expectFailure(
  error: unknown,
  code: ExecutionIdentityFailure['code'] = 'execution-identity-source-changed',
) {
  expect(error).toBeInstanceOf(ExecutionIdentityFailure)
  expect((error as ExecutionIdentityFailure).code).toBe(code)
}

describe('RFC-224 managed skill whole-tree seal', () => {
  test('copies the entire tree, preserves executable intent read-only, and returns a stable digest', async () => {
    const f = await fixture()
    let version = 7
    const first = await snapshotManagedSkillTree({
      sourcePath: f.source,
      snapshotPath: f.destination,
      expectedContentVersion: 7,
      readContentVersion: async () => version,
    })
    expect(first.contentVersion).toBe(7)
    expect(first.treeDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.skillMarkdown).toBe('# Safe skill\n')
    expect(await readFile(join(f.destination, 'scripts', 'run.sh'), 'utf8')).toContain('printf ok')
    expect((await lstat(join(f.destination, 'SKILL.md'))).mode & 0o777).toBe(0o400)
    expect((await lstat(join(f.destination, 'scripts', 'run.sh'))).mode & 0o777).toBe(0o500)
    expect((await lstat(f.destination)).mode & 0o777).toBe(0o500)
    version = 8
  })

  test('tree digest covers auxiliary file content and executable mode', async () => {
    const a = await fixture()
    const b = await fixture()
    await writeFile(join(b.source, 'scripts', 'run.sh'), '#!/bin/sh\nprintf changed\n', {
      mode: 0o644,
    })
    const first = await snapshotManagedSkillTree({
      sourcePath: a.source,
      snapshotPath: a.destination,
      expectedContentVersion: 1,
      readContentVersion: async () => 1,
    })
    const second = await snapshotManagedSkillTree({
      sourcePath: b.source,
      snapshotPath: b.destination,
      expectedContentVersion: 1,
      readContentVersion: async () => 1,
    })
    expect(first.treeDigest).not.toBe(second.treeDigest)
  })

  test('rejects a stale frozen contentVersion before reading the tree', async () => {
    const f = await fixture()
    try {
      await snapshotManagedSkillTree({
        sourcePath: f.source,
        snapshotPath: f.destination,
        expectedContentVersion: 3,
        readContentVersion: async () => 4,
      })
      throw new Error('expected failure')
    } catch (error) {
      expectFailure(error)
    }
  })

  test('rejects contentVersion change after materialization and cleans the seal', async () => {
    const f = await fixture()
    let reads = 0
    try {
      await snapshotManagedSkillTree({
        sourcePath: f.source,
        snapshotPath: f.destination,
        expectedContentVersion: 1,
        readContentVersion: async () => (++reads === 1 ? 1 : 2),
      })
      throw new Error('expected failure')
    } catch (error) {
      expectFailure(error)
    }
    expect(await Bun.file(f.destination).exists()).toBe(false)
  })

  test('rejects symlinks at the root and at any auxiliary entry', async () => {
    const rootCase = await fixture()
    const rootLink = join(rootCase.root, 'source-link')
    await symlink(rootCase.source, rootLink)
    try {
      await snapshotManagedSkillTree({
        sourcePath: rootLink,
        snapshotPath: rootCase.destination,
        expectedContentVersion: 1,
        readContentVersion: async () => 1,
      })
      throw new Error('expected failure')
    } catch (error) {
      expectFailure(error)
    }

    const auxCase = await fixture()
    await symlink('/etc/passwd', join(auxCase.source, 'scripts', 'escape'))
    try {
      await snapshotManagedSkillTree({
        sourcePath: auxCase.source,
        snapshotPath: auxCase.destination,
        expectedContentVersion: 1,
        readContentVersion: async () => 1,
      })
      throw new Error('expected failure')
    } catch (error) {
      expectFailure(error)
    }
  })

  test('requires SKILL.md and rejects special filesystem entries', async () => {
    const root = tempRoot()
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'README.md'), 'not a skill')
    try {
      await snapshotManagedSkillTree({
        sourcePath: source,
        snapshotPath: join(root, 'seal'),
        expectedContentVersion: 1,
        readContentVersion: async () => 1,
      })
      throw new Error('expected failure')
    } catch (error) {
      expectFailure(error)
    }
  })

  test('enforces file, per-file, tree-byte and depth budgets', async () => {
    const cases = [
      { limits: { maxFiles: 1 }, mutate: async (_source: string) => {} },
      {
        limits: { maxFileBytes: 4 },
        mutate: async (_source: string) => {},
      },
      {
        limits: { maxTreeBytes: 8 },
        mutate: async (_source: string) => {},
      },
      {
        limits: { maxDepth: 0 },
        mutate: async (_source: string) => {},
      },
    ]
    for (const [index, entry] of cases.entries()) {
      const f = await fixture()
      await entry.mutate(f.source)
      try {
        await snapshotManagedSkillTree({
          sourcePath: f.source,
          snapshotPath: `${f.destination}-${index}`,
          expectedContentVersion: 1,
          readContentVersion: async () => 1,
          ...entry.limits,
        })
        throw new Error('expected failure')
      } catch (error) {
        expectFailure(error)
      }
    }
  })

  test('does not overwrite an existing seal path', async () => {
    const f = await fixture()
    await mkdir(f.destination, { recursive: true })
    await writeFile(join(f.destination, 'sentinel'), 'keep')
    try {
      await snapshotManagedSkillTree({
        sourcePath: f.source,
        snapshotPath: f.destination,
        expectedContentVersion: 1,
        readContentVersion: async () => 1,
      })
      throw new Error('expected failure')
    } catch (error) {
      // Existing destination is a store-integrity failure, not a source oracle.
      expect(error).toBeInstanceOf(Error)
    }
    expect(await readFile(join(f.destination, 'sentinel'), 'utf8')).toBe('keep')
  })

  test('rejects a second source scan mutation even when the row version is unchanged', async () => {
    const f = await fixture()
    let versionReads = 0
    try {
      await snapshotManagedSkillTree({
        sourcePath: f.source,
        snapshotPath: f.destination,
        expectedContentVersion: 1,
        readContentVersion: async () => {
          versionReads += 1
          if (versionReads === 2) {
            await chmod(join(f.source, 'scripts', 'run.sh'), 0o644)
          }
          return 1
        },
      })
      throw new Error('expected failure')
    } catch (error) {
      expectFailure(error)
    }
  })
})
