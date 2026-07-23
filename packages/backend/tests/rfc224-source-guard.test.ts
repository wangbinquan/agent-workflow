import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ExecutionIdentityFailure } from '@/services/runtime/opencode/failure'
import {
  assertSourceFingerprintUnchanged,
  readFrozenInstruction,
  scanOpencodeProjectSurface,
} from '@/services/runtime/opencode/sourceGuard'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'rfc224-source-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function expectCode(error: unknown, code: ExecutionIdentityFailure['code']) {
  expect(error).toBeInstanceOf(ExecutionIdentityFailure)
  expect((error as ExecutionIdentityFailure).code).toBe(code)
}

describe('RFC-224 project source guard', () => {
  test('produces a stable fingerprint without reading ordinary repo files', async () => {
    const worktree = root()
    writeFileSync(join(worktree, 'secret.txt'), 'must-not-enter-proof')
    const first = await scanOpencodeProjectSurface(worktree)
    const second = await scanOpencodeProjectSurface(worktree)
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).not.toContain('must-not-enter-proof')
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  const forbidden = [
    'opencode.json',
    'opencode.jsonc',
    '.opencode',
    'reference',
    'references',
    join('.agents', 'skills'),
    join('.claude', 'skills'),
  ]

  test.each(forbidden)(
    'rejects forbidden discovery surface %s without parsing it',
    async (name) => {
      const worktree = root()
      const path = join(worktree, name)
      await mkdir(dirname(path), { recursive: true })
      if (name.includes('.') && !name.endsWith('skills') && name !== '.opencode') {
        await writeFile(path, '{ invalid and executable-looking')
      } else {
        await mkdir(path, { recursive: true })
      }
      try {
        await scanOpencodeProjectSurface(worktree)
        throw new Error('expected failure')
      } catch (error) {
        expectCode(error, 'execution-identity-project-config-unsupported')
      }
    },
  )

  test('rejects a forbidden surface at an ancestor, matching upstream search scope', async () => {
    const parent = root()
    const worktree = join(parent, 'nested', 'worktree')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(parent, 'opencode.json'), '{}')
    try {
      await scanOpencodeProjectSurface(worktree)
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-project-config-unsupported')
    }
  })

  test('rejects symlinked worktree and symlinked discovery entry', async () => {
    const actual = root()
    const linkRoot = root()
    const worktreeLink = join(linkRoot, 'worktree')
    await symlink(actual, worktreeLink)
    try {
      await scanOpencodeProjectSurface(worktreeLink)
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-project-config-unsupported')
    }

    const second = root()
    await symlink('/etc/passwd', join(second, 'opencode.json'))
    try {
      await scanOpencodeProjectSurface(second)
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-project-config-unsupported')
    }
  })

  test('A/B fingerprint ignores unrelated sibling writes but rejects a newly created surface', async () => {
    const worktree = root()
    const first = await scanOpencodeProjectSurface(worktree)
    await writeFile(join(worktree, 'ordinary.txt'), 'not an OpenCode identity surface')
    const second = await scanOpencodeProjectSurface(worktree)
    expect(() => assertSourceFingerprintUnchanged(first, second)).not.toThrow()

    await writeFile(join(worktree, 'opencode.json'), '{}')
    try {
      await scanOpencodeProjectSurface(worktree)
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-project-config-unsupported')
    }
  })
})

describe('RFC-224 frozen instruction read', () => {
  test('reads one regular UTF-8 file and returns immutable bytes/digest', async () => {
    const worktree = root()
    await writeFile(join(worktree, 'AGENTS.md'), '# Rules\nDo the thing.\n')
    const frozen = await readFrozenInstruction(worktree, 'AGENTS.md')
    expect(frozen.text).toBe('# Rules\nDo the thing.\n')
    expect(frozen.digest).toMatch(/^[a-f0-9]{64}$/)
    await writeFile(join(worktree, 'AGENTS.md'), 'changed')
    expect(new TextDecoder().decode(frozen.bytes)).toBe('# Rules\nDo the thing.\n')
  })

  test('rejects traversal, symlink, non-UTF8, and oversize inputs', async () => {
    const worktree = root()
    const outside = join(dirname(worktree), `${worktree.split('/').at(-1)}-outside`)
    roots.push(outside)
    await writeFile(outside, 'outside')
    await symlink(outside, join(worktree, 'AGENTS.md'))

    for (const path of ['../outside', 'AGENTS.md']) {
      try {
        await readFrozenInstruction(worktree, path)
        throw new Error('expected failure')
      } catch (error) {
        expectCode(error, 'execution-identity-source-changed')
      }
    }

    await Bun.write(join(worktree, 'binary'), new Uint8Array([0xff, 0xfe]))
    await writeFile(join(worktree, 'large'), '12345')
    for (const [path, max] of [
      ['binary', 100],
      ['large', 4],
    ] as const) {
      try {
        await readFrozenInstruction(worktree, path, max)
        throw new Error('expected failure')
      } catch (error) {
        expectCode(error, 'execution-identity-source-changed')
      }
    }
  })
})
