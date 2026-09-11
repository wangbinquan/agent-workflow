// Repository-wide regression guard for silent test-suite weakening.
//
// A committed `.only`, `.todo`, focused alias, or a new `.skip` can make CI
// green while coverage quietly disappears. Parse test sources with the
// TypeScript AST (rather than grep, which confuses comments/strings and calls
// such as actionLabel.skip()) and keep every intentional environment-gated
// skip in one reviewed inventory.

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
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
  // RFC-359 W6-T26 —— PostgreSQL 执行计划审计（EXPLAIN ANALYZE + buffers/loops 账本）
  // **必须有真库**才有意义：它读的是 PG 自己给出的计划节点与 buffers 计数，SQLite 上没有对应物。
  // 本地 `AW_TEST_PROVIDERS=sqlite` 时留一条**可见的** skip，而不是静默让整份账本变绿——
  // 静默通过会让「计划退化」这类回归在只跑 SQLite 的通道上永远发现不了。
  // 缺 `AW_TEST_POSTGRESQL_URL`（而不是显式只选 sqlite）时仍然**判红不 skip**，
  // 与 `describeEachProvider` 同一条硬判据。
  'packages/backend/tests/rfc359-w6-t26-postgresql-plan-audit.test.ts#skip': 1,
  // RFC-359 W8 —— schema 准备锁的**作用域**（按库隔离 / 同库互斥）同样是 PostgreSQL 专属机制：
  // SQLite 的迁移器根本没有锁，它的隔离天然是「一个文件一个库」。与上一条同一套门控——
  // 显式 `AW_TEST_PROVIDERS=sqlite` 时留一条**可见的** skip（macOS / Windows 原生 lane 就是这一档，
  // 它们没有 PG 服务容器）；选了 postgresql 却缺 URL 时仍然**判红不 skip**。
  // 这条性质有人依赖：audit-backlog 里「每文件一库」那条隔离路线整个建立在它上面。
  'packages/backend/tests/rfc359-w8-migration-lock-scope.test.ts#skip': 1,
  'packages/backend/tests/architecture/rfc319-endpoint-coverage.test.ts#skipIf': 1,
  'packages/backend/tests/architecture/rfc319-route-coverage.test.ts#skipIf': 1,
  'packages/backend/tests/rfc238-mcp-runtime-test-real-e2e.test.ts#skipIf': 1,
  // RFC-356 —— 三条都是**平台能力**门控，不是「这条测不通就跳过」：
  //   · workspace-reclaim / iso-key-generations 用 `chmod 0500` 造「删不掉」的屏障来证
  //     `blocked` 与换代，而 Windows 上 chmod 是 no-op（RFC-254 实测），屏障立不起来；
  //     那一侧的等价覆盖由 windows-platform 腿上的注入式断言承担（design §11 证明力声明）。
  //   · process-tree-quiesce 是**双向**门控：POSIX 侧证进程组语义，win32 侧证「没有 job
  //     时立刻回 unknown、绝不空等预算」——两条各自只在对应平台有意义。
  'packages/backend/tests/rfc356-workspace-reclaim.test.ts#skipIf': 3,
  'packages/backend/tests/rfc356-iso-key-generations.test.ts#skipIf': 2,
  'packages/backend/tests/rfc356-process-tree-quiesce.test.ts#skipIf': 2,
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
  // 写矩阵要一台一次性外置 PostgreSQL（postgresql-evidence 提供），普通跑批跳过。
  'packages/backend/tests/rfc349-postgresql-write-matrix.integration.test.ts#skip': 1,
  // RFC-357：CI 的 `test-backend-postgresql` lane 起一台 postgres 服务容器后**必跑**这条
  // （lane 里有一道 grep，一旦它 skip 就 `::error::` 退出——skip 也算通过，绿着骗人是
  // 这类环境门控最容易掉进去的坑）。普通 backend 跑批没有 URL，因此在这里记一次。
  'packages/backend/tests/rfc357-postgresql-page.integration.test.ts#skip': 1,
  // RFC-359 W2-T11b：能力矩阵的真 PostgreSQL 半边按环境门控 skip（过渡形态，design §11.1 自认反面
  // 教材）；真库 lane 的 `(skip).*real PostgreSQL` grep 保证有库时必跑。T19e harness 落地后删除。
  'packages/backend/tests/rfc359-engine-capabilities.test.ts#skip': 1,
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
  'packages/backend/tests/git-repo-cache-submodule.test.ts#skipIf': 2,
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

  // 为什么存在：测试在**模块顶层**用 `readFileSync(resolve(<literal-rooted>, 'x.ts'))` 读源文件时，
  // 那条路径既不是 import（typecheck 看不见），也不长成一个完整的字面量（上面那条只认带引号的
  // 整条路径，捞不到 `resolve(base, 'x.ts')` 这种分段拼法）。2026-09-11 实撞：删
  // `sqliteNodeRunMintParticipant.ts` 后 `rfc359-w47-node-run-mint-program.test.ts` 在文件顶层读它，
  // 本机全量扫只在汇总行多一个 `1 error`（bun 印成 `# Unhandled error between tests`，既无
  // `(fail)` 也无 `error:` 前缀），推上去两个分片才红。
  //
  // 这里把 `resolve(...)` / `join(...)` 的**字面量拼接**静态求值（`import.meta.dir` 取文件所在目录，
  // 模块作用域里由字面量拼出来的 const 参与求值），再看 `readFileSync` 的第一参数落到哪个文件。
  // 只判**带扩展名、且在仓库内**的路径；运行时才生成的路径拼不出来（根不是字面量），自然不进判据。
  test('every source path a test reads at module scope still exists', () => {
    const missing: string[] = []
    for (const file of TEST_ROOTS.filter((root) => existsSync(root)).flatMap(listTestFiles)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('readFileSync(')) continue
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const bindings = new Map<string, string>()

      const literalPath = (node: ts.Node): string | null => {
        if (ts.isStringLiteralLike(node)) return node.text
        if (ts.isIdentifier(node)) return bindings.get(node.text) ?? null
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === 'dir' &&
          ts.isMetaProperty(node.expression)
        ) {
          return dirname(file)
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          (node.expression.text === 'resolve' || node.expression.text === 'join')
        ) {
          const parts: string[] = []
          for (const argument of node.arguments) {
            const part = literalPath(argument)
            if (part === null) return null
            parts.push(part)
          }
          // `resolve('a','b')` 会落到 **cwd**——那是测试自己在临时目录里造的文件，不是源码路径。
          // 只认第一段就是绝对路径的拼接（`import.meta.dir` 或绝对字面量起头）。
          if (parts.length === 0 || !isAbsolute(parts[0]!)) return null
          return resolve(...parts)
        }
        return null
      }

      const visit = (node: ts.Node, insideExpect = false): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const value = literalPath(node.initializer)
          if (value !== null) bindings.set(node.name.text, value)
        }
        // `expect(() => readFileSync(old)).toThrow()` 是**故意读一个不该存在的路径**（迁位判据的
        // 标准写法：旧位置必须真的没了）。那不是过期路径，不能报。
        const expectScope =
          insideExpect ||
          (ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'expect')
        if (
          !insideExpect &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'readFileSync' &&
          node.arguments[0] !== undefined
        ) {
          const target = literalPath(node.arguments[0])
          if (
            target !== null &&
            target.startsWith(REPO_ROOT) &&
            /\.[a-z0-9]{1,5}$/i.test(target) &&
            !existsSync(target)
          ) {
            missing.push(`${relative(REPO_ROOT, file)} reads ${relative(REPO_ROOT, target)}`)
          }
        }
        ts.forEachChild(node, (child) => {
          visit(child, expectScope)
        })
      }
      visit(source)
    }
    expect(missing.sort()).toEqual([])
  })

  // 为什么存在：workflow 的 `paths:` 触发器与 `scripts/**` 里硬写的源文件清单都是**纯字符串**，
  // 源文件被删或被搬走时没有任何编译期或本地测试会红。两种都实撞过——
  //   · `scripts/rfc359-p0-mutations.ts` 的指纹清单指着已删的
  //     `platform/persistence/sqliteCommittedEventStore.ts`，只在真 PostgreSQL 那条 lane 里以
  //     ENOENT 冒出来，main 已经红了才被发现（c16ff9f4e）；
  //   · `maintenance-soak-nightly.yml` 的 `paths:` 还指着合一前的
  //     `platform/persistence/sqlite/maintenanceRunStore.ts`，于是改了真正那份文件，夜跑
  //     **静默不触发**——没有红，只有覆盖面凭空消失。
  // 只看不含 glob 的字面路径；带 `*` 的通配段照旧由各自的 workflow 负责。
  test('every literal repository path in workflows and scripts still exists', () => {
    const sources: string[] = []
    for (const root of ['.github/workflows', 'scripts']) {
      const dir = resolve(REPO_ROOT, root)
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (!/\.(ya?ml|ts)$/.test(entry.name)) continue
        sources.push(readFileSync(resolve(dir, entry.name), 'utf8'))
      }
    }
    // 只认**带引号的字面量**（YAML 的 `- 'path'` 与 TS 的字符串）；注释散文里出现的同形路径
    // 不算（`scripts/depcheck.ts` 就在注释里写过一个「会去找但并不存在」的 tsconfig 路径）。
    const referenced = new Set<string>()
    for (const source of sources) {
      for (const match of source.matchAll(
        /(['"])((?:packages\/(?:backend|frontend|shared|system-mocks)|e2e|scripts)\/[A-Za-z0-9_./-]+\.(?:tsx?|sql|json|ya?ml))\1/g,
      )) {
        referenced.add(match[2]!)
      }
    }
    expect([...referenced].filter((path) => !existsSync(resolve(REPO_ROOT, path))).sort()).toEqual(
      [],
    )
  })

  // RFC-359 AC-6 —— 双引擎用例里不得残留 bun:sqlite 专有的同步终结符。
  //
  // 为什么这条测试存在：`.run()` / `.get()` / `.all()` 是 bun:sqlite 的**同步**终结符。同一条
  // 语句在 provider 中立面上返回的是一个 promise，写成 `db.insert(...).values(...).run()` 就是
  // 一次没人 await 的写——SQLite 上同步落库、看不出问题，PostgreSQL 上行还没落，后面的 HTTP
  // 请求先到，于是 409 / 外键 23503。它**不会稳定复现**：本机赢了这个竞态就是绿的，CI 上输了
  // 才红（commit 93b5c6409 的 `routes-memory-distill-jobs` 与 `rfc310-pr1b-config-routes-errors`
  // 就是这么把 main 推红的）。所以判据放在源代码层。
  //
  // 范围限定在**走共用 HTTP 作用域**（`describeEachProviderHttpApplication`）的用例上：那是
  // AC-6 正在批量迁入的那批，今天是干净的零，于是可以零容忍。更早那批直接用
  // `describeEachProvider` 的文件里仍有存量同步终结符（多数是 await 过的、不致命），它们
  // 归 `rfc359-w5-t19f` 那条只降不升的账本管，不在这里一次性摊开。
  test('provider HTTP tests carry no bun:sqlite-only sync terminals', () => {
    const offenders: string[] = []
    for (const file of TEST_ROOTS.filter((root) => existsSync(root)).flatMap(listTestFiles)) {
      // 守卫自身写着这些终结符的字面量（正则与提示文案里），不能把自己扫进去。
      if (file === import.meta.path) continue
      const source = readFileSync(file, 'utf8')
      if (!source.includes('describeEachProviderHttpApplication')) continue
      const hits = source.match(/\.(?:run|get|all)\(\)/g) ?? []
      if (hits.length > 0) {
        offenders.push(`${toPortableRelativePath(relative(REPO_ROOT, file))}: ${hits.length}`)
      }
    }
    expect(
      offenders.sort(),
      '共用 HTTP 作用域的用例里出现了 bun:sqlite 专有的同步终结符（`.run()` / `.get()` / `.all()`）。' +
        '它们在中立面上返回 promise：不 await 就是一次悬空的写（PostgreSQL 上行还没落，' +
        '下一步就读不到），await 了也只是把 SQLite 的写法带进了中立面。改成 await 的语句：' +
        '写用 `await db.insert(...).values(...)`，读用 `const [row] = await db.select()...`。',
    ).toEqual([])
  })
})
