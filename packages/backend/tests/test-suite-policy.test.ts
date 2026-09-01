// Repository-wide regression guard for silent test-suite weakening.
//
// A committed `.only`, `.todo`, focused alias, or a new `.skip` can make CI
// green while coverage quietly disappears. Parse test sources with the
// TypeScript AST (rather than grep, which confuses comments/strings and calls
// such as actionLabel.skip()) and keep every intentional environment-gated
// skip in one reviewed inventory.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { toPortableRelativePath } from '@/util/platformExec'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const TEST_ROOTS = [
  resolve(REPO_ROOT, 'packages', 'backend', 'tests'),
  resolve(REPO_ROOT, 'packages', 'shared', 'tests'),
  resolve(REPO_ROOT, 'packages', 'frontend', 'tests'),
  // Frontend keeps focused component regressions beside the feature source.
  // They need the same no-only/no-silent-skip policy as tests/ and e2e/.
  resolve(REPO_ROOT, 'packages', 'frontend', 'src'),
  resolve(REPO_ROOT, 'e2e'),
]
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const TEST_APIS = new Set(['test', 'it', 'describe'])
const TRACKED_MODIFIERS = new Set([
  'only',
  'skip',
  'skipIf',
  'runIf',
  'if',
  'todo',
  'fixme',
  'fail',
])
const FORBIDDEN_MODIFIERS = new Set(['only', 'todo', 'fixme', 'fail'])
const CONDITIONAL_SKIP_MODIFIERS = new Set(['skip', 'skipIf', 'runIf', 'if'])
const FORBIDDEN_ALIASES = new Set(['fit', 'fdescribe', 'ftest', 'xit', 'xdescribe', 'xtest'])

// These suites require an explicit external fixture, live runtime, network,
// or opt-in visual/chaos environment. Any addition/removal changes this exact
// inventory and therefore requires an intentional review of this policy.
const ALLOWED_SKIP_COUNTS: Record<string, number> = {
  // RFC-319 R1/R2 —— 覆盖账本的**逐条对账**只在跑过全量 e2e、且拿得到 route journal
  // 时才有意义（`AW_E2E_ROUTE_JOURNAL` 由 e2e-full-nightly 提供）。PR 腿只跑 PR 档，
  // 它的命中集合天然小于全量，拿它比账本会把账本「修」成一个更宽松的值。
  // 同文件的结构检查（幽灵条目 / 排序去重 / 语料上下界）不带门，始终跑。
  'packages/backend/tests/architecture/rfc319-endpoint-coverage.test.ts#skipIf': 1,
  'packages/backend/tests/architecture/rfc319-route-coverage.test.ts#skipIf': 1,
  'packages/backend/tests/rfc238-mcp-runtime-test-real-e2e.test.ts#skipIf': 1,
  // POSIX process-group semantics; the same file exercises Job Objects on Windows.
  'packages/backend/tests/rfc254-process-tree-ownership.test.ts#skipIf': 2,
  // Bun's detached `.cmd` pipe behaviour requires a real Windows kernel.
  'packages/backend/tests/rfc254-version-probe-cmd-wrapper.test.ts#skipIf': 1,
  // The activation-frame and compiled Bun target/output relay regressions require
  // a real Windows kernel; the latter also requires a compiled artifact.
  'packages/backend/tests/rfc328-process-preactivation.test.ts#skipIf': 2,
  'packages/backend/tests/rfc135-runtimes-status.test.ts#skipIf': 2,
  // The live icacls/whoami round-trip requires a Windows kernel.
  'packages/backend/tests/rfc254-win32-acl-integration.test.ts#skipIf': 1,
  'packages/backend/tests/rfc208-unbounded-git-and-permits.test.ts#skipIf': 1,
  'packages/backend/tests/rfc193-force-include.test.ts#skipIf': 1,
  'packages/backend/tests/rfc253-script-snippets.test.ts#skipIf': 5,
  'packages/backend/tests/rfc234-system-agent-run.test.ts#skipIf': 1,
  'packages/backend/tests/runtime-routes-registry.test.ts#skipIf': 1,
  'packages/backend/tests/rfc205-mirror-origin-sanitize.test.ts#skipIf': 1,
  'packages/backend/tests/claude-skill-injection-2026-08-09.test.ts#skipIf': 1,
  'packages/backend/tests/claude-dependency-injection-2026-08-09.test.ts#skipIf': 5,
  // RFC-349 real PostgreSQL integration requires an explicitly supplied,
  // disposable PG17 target and is otherwise covered by provider fakes.
  'packages/backend/tests/rfc349-database-migration-coordinator.integration.test.ts#skip': 1,
  'packages/backend/tests/rfc349-postgresql-logical-migration.integration.test.ts#skip': 1,
  'packages/backend/tests/rfc349-postgresql-target-faults.integration.test.ts#skip': 1,
  'e2e/clarify.spec.ts#skip': 1,
  'e2e/focus-ring-clip.spec.ts#skip': 1,
  // RFC-319 REPO-42（2026-08-26）：这里曾是 2 —— 一条是 gitea 夹具未配置时的条件跳过
  // （合法，保留），另一条是文件底部一个**只有注释、没有断言**的 SSH 空壳
  // `describe.skip`。它记的理由（「要等 daemon 支持自定义 GIT_SSH_COMMAND」）本身
  // 就是错的：util/git.ts:38-44 早就把环境里的 GIT_SSH_COMMAND 层叠保留了。空壳已删，
  // 覆盖改由 packages/backend/tests/rfc319-ssh-repo-access.test.ts 用桩 ssh 真跑。
  'e2e/git-protocols.spec.ts#skip': 1,
  // Explicitly billed/provider-backed and activated only by the local
  // pre-release package script; ordinary CI must keep both drivers skipped.
  'e2e/release-runtime.spec.ts#skip': 2,
  'e2e/rfc250-visual-states.spec.ts#skip': 1,
  // RFC-319 B80（5e7e08f0f）WF-22：xyflow 的 Shift+click 多选在 Playwright webkit 上不稳，
  // 与 workflow-editor.spec.ts#skip 同一条上游问题；那笔的 CI run 被后续 push 取消，
  // 这条登记在下一笔的 run 上才补（2026-08-25）。
  'e2e/rfc319-canvas-editing-ops.spec.ts#skip': 1,
  'e2e/visual-regression.spec.ts#skip': 1,
  'e2e/workflow-editor.spec.ts#skip': 1,
  'packages/backend/tests/git-repo-cache-submodule.test.ts#skipIf': 1,
  'packages/backend/tests/integration-chaos/chaos-scenarios.integration.test.ts#skipIf': 1,
  'packages/backend/tests/integration-opencode/opencode-live.integration.test.ts#skipIf': 1,
  // RFC-281 T1 part3: LIVE workspace-boundary cases against the real opencode
  // binary. Same env gate as the sibling live suite (RUN_OPENCODE_INTEGRATION
  // + an opencode auth context); the always-on gate/assembly assertions in that
  // file are NOT skipped.
  'packages/backend/tests/integration-opencode/rfc281-boundary.integration.test.ts#skipIf': 1,
  'packages/backend/tests/mcp-probe-http-integration.test.ts#skipIf': 2,
  'packages/backend/tests/mcp-probe-stdio-integration.test.ts#skipIf': 1,
  'packages/backend/tests/opencode-models.test.ts#skipIf': 1,
  'packages/backend/tests/worktree-submodule-init.test.ts#skipIf': 1,
  // RFC-310 PR-0：symlink/mkfifo 攻击夹具依赖 POSIX 语义（Windows 造 symlink 需
  // 特权、无 mkfifo）；其余 sink/预算/traversal 拒绝用例三平台全跑。
  'packages/backend/tests/rfc310-pr0-evidence-sink-probe.test.ts#skipIf': 1,
  // RFC-310 T71：GB 级 soak 默认关（成本），由 evidence-soak-nightly 那格打开。
  // 它的 RUN_EVIDENCE_SOAK 已登记在 REQUIRED_GATE_ACTIVATIONS 里，不是无人执行的 skip。
  'packages/backend/tests/rfc310-evidence-soak.test.ts#skipIf': 1,
}

interface TestModifierUse {
  file: string
  line: number
  modifier: string
}

interface OptInGateUse {
  file: string
  line: number
  gate: string
}

interface GateActivationCheck {
  file: string
  marker: string
}

// Every RUN_* switch referenced by a test must have a concrete automated
// activation path. This prevents a locally green, permanently skipped suite:
// adding a new switch makes the exact-name assertion fail until CI owns it.
const REQUIRED_GATE_ACTIVATIONS: Record<string, GateActivationCheck[]> = {
  RUN_CHAOS: [{ file: '.github/workflows/ci.yml', marker: "RUN_CHAOS: '1'" }],
  RUN_GIT_NETWORK: [{ file: '.github/workflows/ci.yml', marker: "RUN_GIT_NETWORK: '1'" }],
  // RFC-310 T71：GB 级证据落盘 soak。默认关是成本决定（2GB 下载 + 2GB 临时磁盘），
  // 不是可靠性存疑——所以它必须有一条真在跑的自动化路径，否则就是个永远不执行的
  // 断言。nightly 那格就是它的执行者。
  RUN_EVIDENCE_SOAK: [
    {
      file: '.github/workflows/evidence-soak-nightly.yml',
      marker: "RUN_EVIDENCE_SOAK: '1'",
    },
  ],
  RUN_GIT_PROTOCOLS: [
    { file: '.github/workflows/git-protocols-e2e.yml', marker: "RUN_GIT_PROTOCOLS: '1'" },
  ],
  RUN_LIVE_RUNTIME_E2E: [
    {
      file: 'package.json',
      marker:
        '"e2e:release-runtimes": "RUN_LIVE_RUNTIME_E2E=1 PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/release-runtime-report.json playwright test e2e/release-runtime.spec.ts --project=chromium --workers=1 --reporter=list,json",',
    },
  ],
  RUN_OPENCODE_INTEGRATION: [
    {
      file: '.github/workflows/integration-opencode.yml',
      marker: "RUN_OPENCODE_INTEGRATION: '1'",
    },
  ],
  RUN_VISUAL_REGRESSION: [
    {
      file: 'package.json',
      marker:
        '"test:visual": "RUN_VISUAL_REGRESSION=1 playwright test e2e/visual-regression.spec.ts e2e/rfc250-visual-states.spec.ts --project=chromium",',
    },
    {
      file: '.github/workflows/visual-regression-nightly.yml',
      marker: 'run: bun run test:visual -- --retries=0',
    },
  ],
}

function optInGateName(node: ts.Node): string | null {
  let gate: string | null = null
  let receiver: ts.Expression | null = null

  if (ts.isPropertyAccessExpression(node)) {
    gate = node.name.text
    receiver = node.expression
  } else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    gate = node.argumentExpression.text
    receiver = node.expression
  }

  if (
    !gate?.startsWith('RUN_') ||
    !receiver ||
    !ts.isPropertyAccessExpression(receiver) ||
    !ts.isIdentifier(receiver.expression) ||
    receiver.expression.text !== 'process' ||
    receiver.name.text !== 'env'
  ) {
    return null
  }
  return gate
}

function listTestFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) files.push(...listTestFiles(path))
    else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) files.push(path)
  }
  return files
}

function rootTestApi(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return TEST_APIS.has(expr.text) ? expr.text : null
  if (ts.isPropertyAccessExpression(expr)) return rootTestApi(expr.expression)
  if (ts.isElementAccessExpression(expr)) return rootTestApi(expr.expression)
  if (ts.isCallExpression(expr)) return rootTestApi(expr.expression)
  if (ts.isParenthesizedExpression(expr)) return rootTestApi(expr.expression)
  return null
}

function parseTestModifiers(
  file: string,
  sourceText: string,
): { modifiers: TestModifierUse[]; aliases: TestModifierUse[]; gates: OptInGateUse[] } {
  const modifiers: TestModifierUse[] = []
  const aliases: TestModifierUse[] = []
  const gates: OptInGateUse[] = []
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const visit = (node: ts.Node): void => {
    const gate = optInGateName(node)
    if (gate) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      gates.push({ file, line, gate })
    }

    if (ts.isPropertyAccessExpression(node)) {
      const modifier = node.name.text
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      if (TRACKED_MODIFIERS.has(modifier) && rootTestApi(node.expression)) {
        modifiers.push({ file, line, modifier })
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      TRACKED_MODIFIERS.has(node.argumentExpression.text) &&
      rootTestApi(node.expression)
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      modifiers.push({ file, line, modifier: node.argumentExpression.text })
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      FORBIDDEN_ALIASES.has(node.expression.text)
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      aliases.push({ file, line, modifier: node.expression.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  return { modifiers, aliases, gates }
}

function collectTestModifiers(): {
  modifiers: TestModifierUse[]
  aliases: TestModifierUse[]
  gates: OptInGateUse[]
} {
  const modifiers: TestModifierUse[] = []
  const aliases: TestModifierUse[] = []
  const gates: OptInGateUse[] = []

  for (const absolute of TEST_ROOTS.flatMap(listTestFiles)) {
    // RFC-254 T32: the repo-relative path is this inventory's KEY, and the
    // inventory is checked in with `/`. `relative` returns the HOST spelling,
    // so on Windows every key came back as `packages\backend\tests\...` and not
    // one of them matched — the policy reported the entire reviewed inventory
    // as both missing and unexpected, which reads like a mass regression rather
    // than a separator. The counts were right all along; only the spelling was
    // not, so the path is normalized once, here, where it becomes a key.
    const file = toPortableRelativePath(relative(REPO_ROOT, absolute))
    const parsed = parseTestModifiers(file, readFileSync(absolute, 'utf8'))
    modifiers.push(...parsed.modifiers)
    aliases.push(...parsed.aliases)
    gates.push(...parsed.gates)
  }

  return { modifiers, aliases, gates }
}

describe('repository test-suite policy', () => {
  const inventory = collectTestModifiers()

  test('AST scanner catches test modifiers without grep false positives', () => {
    const probe = parseTestModifiers(
      'policy-probe.test.ts',
      `
        // test.skip('comment only', () => {})
        const text = "describe.only('string only')"
        actionLabel.skip()
        test.only.each([1])('focused parameterized', () => {})
        test.each([1]).skip('parameterized skip', () => {})
        test.runIf(false)('conditional run', () => {})
        test.describe
          .fixme('playwright fixme', () => {})
        describe['todo']('unfinished')
        test.fail('expected failure', () => {})
        fit('focused alias', () => {})
        const directGate = process.env.RUN_DIRECT_PROBE
        const bracketGate = process.env['RUN_BRACKET_PROBE']
      `,
    )

    expect(probe.modifiers.map(({ modifier }) => modifier).sort()).toEqual(
      ['only', 'skip', 'runIf', 'fixme', 'todo', 'fail'].sort(),
    )
    expect(probe.aliases.map(({ modifier }) => modifier)).toEqual(['fit'])
    expect(probe.gates.map(({ gate }) => gate)).toEqual(['RUN_DIRECT_PROBE', 'RUN_BRACKET_PROBE'])
  })

  test('focused and unresolved test declarations are forbidden', () => {
    const forbidden = inventory.modifiers.filter(({ modifier }) =>
      FORBIDDEN_MODIFIERS.has(modifier),
    )
    expect([...forbidden, ...inventory.aliases]).toEqual([])
  })

  // RFC-254 T32 regression guard. The reviewed inventory above is keyed by a
  // repo-relative path spelled with `/`, but the keys are DISCOVERED with
  // `path.relative`, which answers in the host spelling. On Windows that made
  // every single key miss, so the policy declared the whole reviewed inventory
  // simultaneously missing and unexpected — a diff that looks like a mass
  // regression and is really one separator.
  //
  // This guard is only capable of going red on a host whose separator is `\`,
  // which is exactly the host that had the bug; on POSIX it passes trivially
  // and simply costs nothing.
  test('discovered inventory keys are spelled portably, not host-natively', () => {
    const hostSpelled = [...inventory.modifiers, ...inventory.aliases, ...inventory.gates]
      .map(({ file }) => file)
      .filter((file) => file.includes('\\'))
    expect(hostSpelled).toEqual([])
  })

  test('every skip is an explicitly reviewed environment-gated exception', () => {
    const actual: Record<string, number> = {}
    for (const use of inventory.modifiers.filter(({ modifier }) =>
      CONDITIONAL_SKIP_MODIFIERS.has(modifier),
    )) {
      const key = `${use.file}#${use.modifier}`
      actual[key] = (actual[key] ?? 0) + 1
    }
    expect(actual).toEqual(ALLOWED_SKIP_COUNTS)
  })

  test('every opt-in RUN_* test gate is activated by automation', () => {
    const discovered = [...new Set(inventory.gates.map(({ gate }) => gate))].sort()
    expect(discovered).toEqual(Object.keys(REQUIRED_GATE_ACTIVATIONS).sort())

    const checks: Record<string, boolean> = {}
    for (const [gate, activations] of Object.entries(REQUIRED_GATE_ACTIVATIONS)) {
      for (const activation of activations) {
        const key = `${gate}#${activation.file}`
        const source = readFileSync(resolve(REPO_ROOT, activation.file), 'utf8')
        checks[key] = source.split(/\r?\n/).some((line) => line.trim() === activation.marker)
      }
    }
    expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map((key) => [key, true])))
  })

  test('git-protocol workflow re-runs when its shared daemon harness changes', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, '.github/workflows/git-protocols-e2e.yml'),
      'utf8',
    )
    expect(source.match(/^\s+- 'e2e\/harness\.ts'$/gm)).toHaveLength(2)
  })
})
