import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ExecutionIdentityFailure } from '@/services/runtime/opencode/failure'
import {
  assertSourceFingerprintUnchanged,
  readFrozenInstruction,
  scanOpencodeProjectSurface,
} from '@/services/runtime/opencode/sourceGuard'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const CI_WORKFLOW = resolve(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const INTEGRATION_WORKFLOW = resolve(REPO_ROOT, '.github', 'workflows', 'integration-opencode.yml')
const VISUAL_WORKFLOW = resolve(REPO_ROOT, '.github', 'workflows', 'visual-regression-nightly.yml')
const WEBKIT_WORKFLOW = resolve(REPO_ROOT, '.github', 'workflows', 'e2e-webkit-nightly.yml')
const E2E_FIXTURE_ROOT = resolve(REPO_ROOT, 'e2e', 'fixtures')
const REVIEWED_OPENCODE_VERSION = '1.18.3'

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

function opencodeInstallTargets(source: string): string[] {
  return [...source.matchAll(/^\s*bun install -g opencode-ai@(.+?)\s*$/gm)].map((match) =>
    match[1]!.trim(),
  )
}

function opencodeVersionDeclarations(source: string): string[] {
  return [...source.matchAll(/^\s*OPENCODE_VERSION:\s*(.+?)\s*$/gm)].map(
    (match) => `OPENCODE_VERSION: ${match[1]!.trim()}`,
  )
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

describe('RFC-224 release platform source guard', () => {
  const ciWorkflow = readFileSync(CI_WORKFLOW, 'utf8')
  const integrationWorkflow = readFileSync(INTEGRATION_WORKFLOW, 'utf8')
  const visualWorkflow = readFileSync(VISUAL_WORKFLOW, 'utf8')
  const webkitWorkflow = readFileSync(WEBKIT_WORKFLOW, 'utf8')

  test('pins the Linux FFF gate to the reviewed runner', () => {
    expect(integrationWorkflow.match(/^ {4}runs-on: ubuntu-22\.04$/gm)).toHaveLength(1)
    expect(integrationWorkflow).not.toMatch(/^ {4}runs-on: ubuntu-latest$/gm)
  })

  test('pins all four release workflows to the one reviewed official OpenCode build', () => {
    const envPinnedWorkflows = [
      {
        name: 'ci.yml',
        source: ciWorkflow,
        expectedInstallTargets: ['${{ env.OPENCODE_VERSION }}', '${{ env.OPENCODE_VERSION }}'],
      },
      {
        name: 'visual-regression-nightly.yml',
        source: visualWorkflow,
        expectedInstallTargets: ['${{ env.OPENCODE_VERSION }}'],
      },
    ]

    for (const workflow of envPinnedWorkflows) {
      expect(opencodeVersionDeclarations(workflow.source), workflow.name).toEqual([
        `OPENCODE_VERSION: '${REVIEWED_OPENCODE_VERSION}'`,
      ])
      expect(opencodeInstallTargets(workflow.source), workflow.name).toEqual(
        workflow.expectedInstallTargets,
      )
    }

    const integrationMatrixBlocks = [
      ...integrationWorkflow.matchAll(/^ {8}opencode:\n((?:^ {10}.*\n)+)/gm),
    ]
    expect(integrationMatrixBlocks).toHaveLength(1)
    expect(
      integrationMatrixBlocks[0]![1]!
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('-')),
    ).toEqual([`- '${REVIEWED_OPENCODE_VERSION}'`])
    expect(opencodeVersionDeclarations(integrationWorkflow)).toEqual([])
    expect(opencodeInstallTargets(integrationWorkflow)).toEqual(['${{ matrix.opencode }}'])

    expect(opencodeVersionDeclarations(webkitWorkflow)).toEqual([])
    expect(opencodeInstallTargets(webkitWorkflow)).toEqual([REVIEWED_OPENCODE_VERSION])

    for (const [name, source] of [
      ['ci.yml', ciWorkflow],
      ['visual-regression-nightly.yml', visualWorkflow],
      ['integration-opencode.yml', integrationWorkflow],
      ['e2e-webkit-nightly.yml', webkitWorkflow],
    ] as const) {
      expect(source, name).not.toMatch(/^\s*bun install -g opencode-ai(?:\s|$)/gm)
      expect(source, name).not.toMatch(/^\s*bun install -g opencode-ai@latest(?:\s|$)/gm)
    }
  })

  test('proves the unprivileged bwrap capability with the exact FFF namespace surface', () => {
    const expectedSmoke = [
      '"$bwrap_path" \\',
      '--die-with-parent \\',
      '--new-session \\',
      '--unshare-net \\',
      '--unshare-pid \\',
      '--unshare-ipc \\',
      '--unshare-uts \\',
      '--ro-bind / / \\',
      '--proc /proc \\',
      '--dev /dev \\',
      '--clearenv \\',
      '-- /bin/true',
    ]
    const workflowLines = integrationWorkflow.split('\n')
    const starts = workflowLines
      .map((line, index) => (line.trim() === expectedSmoke[0] ? index : -1))
      .filter((index) => index >= 0)

    expect(starts).toHaveLength(1)
    const start = starts[0]!
    expect(
      workflowLines.slice(start, start + expectedSmoke.length).map((line) => line.trim()),
    ).toEqual(expectedSmoke)
    expect(integrationWorkflow).toContain('test "$((8#$bwrap_mode & 8#6000))" -eq 0')
  })

  test('forbids privilege and host-policy workarounds in the Linux gate', () => {
    expect(integrationWorkflow).not.toMatch(/\bsudo\b[^\n]*(?:\bbwrap\b|\$bwrap_path)/)
    expect(integrationWorkflow).not.toMatch(
      /\bsysctl\b|kernel\.(?:apparmor_restrict_unprivileged_userns|unprivileged_userns_clone)/,
    )
    expect(integrationWorkflow).not.toMatch(
      /\bsetuid\b|\b(?:chmod|install)\b[^\n]*(?:[ugoa]*\+s|\b[2467][0-7]{3}\b)/i,
    )
  })

  test('keeps every production e2e OpenCode stub on the reviewed build identity', () => {
    const stubs = readdirSync(E2E_FIXTURE_ROOT)
      .filter((name) => /^stub-opencode.*\.sh$/.test(name))
      .sort()
    expect(stubs).toEqual([
      'stub-opencode-clarify-inline.sh',
      'stub-opencode-clarify.sh',
      'stub-opencode-commit.sh',
      'stub-opencode-cross-clarify.sh',
      'stub-opencode-slow.sh',
      'stub-opencode.sh',
    ])

    for (const stub of stubs) {
      const source = readFileSync(resolve(E2E_FIXTURE_ROOT, stub), 'utf8')
      const versionArms = [
        ...source.matchAll(
          /^[ \t]*--version\s*\|\s*-v\s*\|\s*version\)\s*\n([\s\S]*?)^[ \t]*;;\s*$/gm,
        ),
      ]
      expect(versionArms, stub).toHaveLength(1)
      expect(
        versionArms[0]![1]!
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        stub,
      ).toEqual([`echo "stub-opencode ${REVIEWED_OPENCODE_VERSION}"`, 'exit 0'])

      const advertisedVersions = [...source.matchAll(/\bstub-opencode ([^\s"'`]+)/g)].map(
        (match) => match[1]!,
      )
      expect(advertisedVersions, stub).toEqual([REVIEWED_OPENCODE_VERSION])
    }
  })
})
