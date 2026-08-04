import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
const E2E_STUB_MODE_ROOT = resolve(E2E_FIXTURE_ROOT, 'stub')
// RFC-254 T28b: the nine shell stubs became modes of one compiled program, so
// the matrix is keyed by mode file. Each still reports a DISTINCT string, and
// several are deliberately not semver — that variety is the point: RFC-224
// treats the reported version as telemetry, never as a trust boundary, and a
// fixture set that all looked like `1.2.3` would stop exercising it.
const E2E_STUB_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'mode-basic.ts': 'custom-build',
  'mode-business-workflows.ts': 'business-workflows',
  'mode-business-workgroups.ts': 'business-workgroups',
  'mode-clarify-inline.ts': '1.18.3',
  'mode-clarify.ts': '1.17.9',
  'mode-commit.ts': '999.0.0',
  'mode-cross-clarify.ts': '1.18.4',
  // RFC-234: intent-builder e2e stub — telemetry stays deliberately non-semver.
  'mode-intent.ts': 'intent-build',
  'mode-slow.ts': '0.9.0',
  'mode-workflow-matrix.ts': 'workflow-matrix',
  'mode-workgroup-matrix.ts': 'workgroup-matrix',
})

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

  // 2026-08-04 审计订正：这条原本断言「祖先目录里的 opencode.json 也要拒」，标题还写着
  // 「matching upstream search scope」——去 opencode v1.18.x 源码逐条核对后**不成立**：
  //   config/paths.ts:28-32   up({targets:['.opencode'], start: directory, stop: worktree})
  //   skill/index.ts:196-197  up({targets: externalDirs, start: directory, stop: worktree})
  //   util/filesystem.ts:213-226  `if (stop === current) break`（只有 stop 永不命中时才爬到 /）
  // 两条向上遍历都**以工作树封顶**；唯一无界的读是 `join(global.home, dir)`，而它跟随
  // `HOME`，受控配置把 HOME 指向私有 hermetic home，所以 daemon 用户的真实家目录根本不在
  // opencode 的搜索域里。
  //
  // 而这条多余的严格性有真实代价：工作树在 `~/.agent-workflow/` 下 ⇒ `$HOME` 必被扫，
  // daemon 用户只要有 `~/.opencode` 或 `~/.claude/skills`，**所有** verified 节点永久失败。
  test('工作树内的禁用面照拒（真实搜索域）', async () => {
    const worktree = root()
    await writeFile(join(worktree, 'opencode.json'), '{}')
    try {
      await scanOpencodeProjectSurface(worktree)
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-project-config-unsupported')
    }
  })

  test('祖先目录里的同名面不再拒——它不在 opencode 的搜索域内', async () => {
    const parent = root()
    const worktree = join(parent, 'nested', 'worktree')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(parent, 'opencode.json'), '{}')
    // 不抛即通过；祖先链仍被指纹化（下面 source-changed 那组用例锁的就是它）。
    const fingerprint = await scanOpencodeProjectSurface(worktree)
    expect(fingerprint).toBeDefined()
  })

  test('拒绝时给出命中的绝对路径，而不是裸的相对名', async () => {
    const worktree = root()
    const hit = join(worktree, '.opencode')
    await mkdir(hit, { recursive: true })
    try {
      await scanOpencodeProjectSurface(worktree)
      throw new Error('expected failure')
    } catch (error) {
      expectCode(error, 'execution-identity-project-config-unsupported')
      // guard 对工作树做 realpath（Seatbelt 匹配的是内核路径），所以指针也是规范路径：
      // macOS 上 /var → /private/var。断言规范化后的形态，而不是 tmpdir 的原样字符串。
      expect(String((error as { pointer?: unknown }).pointer ?? '')).toBe(
        join(realpathSync(worktree), '.opencode'),
      )
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

  test('tests stable and current channels without turning either into an admission pin', () => {
    // The source-test job and the compiled-binary doctor job each exercise the
    // current channel. Two independent consumers are intentional; neither is a
    // runtime admission/version pin.
    expect(opencodeInstallTargets(ciWorkflow)).toEqual(['latest', 'latest'])
    expect(opencodeInstallTargets(visualWorkflow)).toEqual([])
    expect(opencodeInstallTargets(webkitWorkflow)).toEqual([])
    const integrationMatrixBlocks = [
      ...integrationWorkflow.matchAll(/^ {8}opencode:\n((?:^ {10}.*\n)+)/gm),
    ]
    expect(integrationMatrixBlocks).toHaveLength(1)
    expect(
      integrationMatrixBlocks[0]![1]!
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('-')),
    ).toEqual(["- '1.18.3'", "- 'latest'"])
    expect(opencodeInstallTargets(integrationWorkflow)).toEqual(['${{ matrix.opencode }}'])

    for (const [name, source] of [
      ['ci.yml', ciWorkflow],
      ['visual-regression-nightly.yml', visualWorkflow],
      ['integration-opencode.yml', integrationWorkflow],
      ['e2e-webkit-nightly.yml', webkitWorkflow],
    ] as const) {
      expect(source, name).not.toContain('OPENCODE_VERSION')
      expect(source, name).not.toContain('MIN_OPENCODE_VERSION')
      expect(source, name).not.toContain('PINNED_OPENCODE_VERSION')
      expect(source, name).not.toMatch(/^\s*bun install -g opencode-ai(?:\s|$)/gm)
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

  test('keeps the e2e stubs on an explicit version-neutral telemetry matrix', () => {
    const modes = readdirSync(E2E_STUB_MODE_ROOT)
      .filter((name) => name.startsWith('mode-'))
      .sort()
    // Enumerated, not derived: a NEW mode has to be added here deliberately,
    // which is when someone decides what it should report.
    expect(modes).toEqual(Object.keys(E2E_STUB_VERSIONS).sort())

    for (const mode of modes) {
      const expectedVersion = E2E_STUB_VERSIONS[mode]!
      const source = readFileSync(resolve(E2E_STUB_MODE_ROOT, mode), 'utf8')
      // Exactly one place writes it, and it writes exactly that.
      const advertised = [...source.matchAll(/'stub-opencode ([^\n']+)\\n'/g)].map(
        (match) => match[1]!,
      )
      expect(advertised, mode).toEqual([expectedVersion])
    }
    expect(new Set(Object.values(E2E_STUB_VERSIONS)).size).toBe(modes.length)
  })
})
