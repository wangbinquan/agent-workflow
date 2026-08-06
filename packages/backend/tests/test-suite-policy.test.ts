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
  // RFC-254 T4: two assertions describe the POSIX process-GROUP model, which
  // Windows has no equivalent of — the group signal, and the fact that a
  // non-leader pid leads no tree. The Windows behaviour they mirror is covered
  // in the same file by the branch that runs ONLY on win32 (Job Object
  // adoption, live count, atomic terminate), so no platform loses coverage.
  'packages/backend/tests/rfc254-process-tree-ownership.test.ts#skipIf': 2,
  // RFC-254 T32: two RFC-135 status-probe cases whose assertions ARE the POSIX
  // process-group reap (fork-without-exec grandchild via `#!/bin/sh`, PGID
  // signal, `pgrep -f`). The win32 descendant-lifetime boundary is the Job
  // Object, covered by rfc254-process-tree-ownership's win32 branch — so no
  // platform loses the "runaway child is reaped" guarantee. The rest of the
  // file now runs on Windows (T39/T40a made the version-probe snapshot work).
  'packages/backend/tests/rfc135-runtimes-status.test.ts#skipIf': 2,
  // RFC-254 T40b: the REAL icacls/whoami DACL round-trip proves the win32
  // file-privacy primitive on a Windows machine (verified on ARM64). Its six
  // cases depend on the actual Windows ACL subsystem, so they run ONLY on win32;
  // the SDDL parsing + whitelist verdict they exercise are covered platform-
  // agnostically by the pure suite rfc254-win32-acl.test.ts.
  'packages/backend/tests/rfc254-win32-acl-integration.test.ts#skipIf': 1,
  // RFC-254 T40b: one system-plan case builds the plan under bwrap-ENFORCE
  // containment (a Linux mechanism); on win32 the core fails at bootstrap before
  // the manifest (D1: no isolation provider on Windows v1). Its manifest-privacy
  // proof is covered on win32 by the business launcher path. The sibling bwrap-
  // rejection cases in the same file DO run on win32.
  'packages/backend/tests/rfc224-verified-system-plan.test.ts#skipIf': 1,
  // RFC-254: the process-GROUP kill proof uses a POSIX `sleep` grandchild + a
  // `pgrep -f` survivor scan (ENOENT on Windows). The Windows descendant-lifetime
  // guarantee is the Job Object (rfc254-process-tree-ownership win32 branch).
  'packages/backend/tests/rfc208-unbounded-git-and-permits.test.ts#skipIf': 1,
  // RFC-254: one case creates a file literally named `:tricky.md` to prove
  // leading-colon names are treated literally (not pathspec magic). `:` is an
  // illegal filename char on Windows (drive/ADS separator), so the case's premise
  // can't exist there; the guard it locks is platform-agnostic production code.
  'packages/backend/tests/rfc193-force-include.test.ts#skipIf': 1,
  // RFC-254: two script-node describes render the Linux bwrap args / macOS SBPL
  // profile (network fence + readonly boundary) — POSIX sandbox specs never
  // produced on win32 (D1), whose renderers use host path helpers. Exercised on
  // the POSIX CI legs. The env-assembly, traversal-defense, and contained-spawn
  // mechanics in the same file DO run on win32 (portable `bun -e` commands).
  'packages/backend/tests/rfc253-script-execution.test.ts#skipIf': 2,
  // RFC-254: one case needs a runtime whose DIRECT child exits while a detached
  // grandchild keeps the inherited stdout pipe open (post-exit-flush-timeout →
  // 'incomplete'). Windows closes the pipe on parent exit regardless of an unref'd
  // grandchild, so the condition is unreproducible there ('complete'); the flush
  // cap it exercises is a platform-agnostic timer on the stdout drain. The rest of
  // the file now runs on win32 (command-array runtime head via opencodeCmd +
  // platform-aware killProcessTree reap, which fixed the timeout/abort cases).
  'packages/backend/tests/rfc234-system-agent-run.test.ts#skipIf': 1,
  // RFC-254: one registry test drives the REAL streaming deep-smoke end-to-end
  // through the HTTP /probe route with a real binaryPath — the route takes a single
  // path, so runtime-smoke's command-array streaming seam is unreachable and a
  // `.sh`/`.cmd` can't stream (cmd.exe buffers). The streaming mechanism is covered
  // on win32 by runtime-smoke.test.ts; a real streaming single-binary needs a
  // compiled `.exe` (deferred). The other 20 registry tests run on win32.
  'packages/backend/tests/runtime-routes-registry.test.ts#skipIf': 1,
  // RFC-254: the three policy-render describes assert computeSandboxPolicy →
  // bwrap/SBPL output — POSIX sandbox specs never produced on win32 (D1),
  // rendered with host path helpers. The fourth (runner source-text lock) is
  // platform-agnostic and still runs on win32. Render describes → POSIX CI legs.
  'packages/backend/tests/sandbox-allowback-audit-2026-08-04.test.ts#skipIf': 3,
  'e2e/clarify.spec.ts#skip': 1,
  // RFC-206: the focus-ring geometry audit measures a forced :focus-visible
  // state, which only Chrome DevTools Protocol (CSS.forcePseudoState) can
  // produce — programmatic focus does not reliably match :focus-visible. The
  // spec therefore skips on non-chromium projects (webkit is the opt-in
  // nightly run; chromium is the PR-gating default, so no gating coverage is
  // lost).
  'e2e/focus-ring-clip.spec.ts#skip': 1,
  'e2e/git-protocols.spec.ts#skip': 2,
  // RFC-250: populated interaction-state screenshots are intentionally opt-in
  // beside the canonical visual suite and are activated by `test:visual` in
  // both local and hosted gates.
  'e2e/rfc250-visual-states.spec.ts#skip': 1,
  'e2e/visual-regression.spec.ts#skip': 1,
  'e2e/workflow-editor.spec.ts#skip': 1,
  'packages/backend/tests/git-repo-cache-submodule.test.ts#skipIf': 1,
  'packages/backend/tests/integration-chaos/chaos-scenarios.integration.test.ts#skipIf': 1,
  // RFC-224: official-binary execution-identity preflight. It is opt-in only
  // because the repository unit suite must not download/use an external
  // OpenCode executable; integration-opencode.yml activates the gate on every
  // relevant push/PR and performs no LLM/provider call.
  'packages/backend/tests/integration-opencode/opencode-identity-preflight.integration.test.ts#skipIf': 1,
  'packages/backend/tests/integration-opencode/opencode-live.integration.test.ts#skipIf': 1,
  'packages/backend/tests/mcp-probe-http-integration.test.ts#skipIf': 1,
  'packages/backend/tests/mcp-probe-stdio-integration.test.ts#skipIf': 1,
  // RFC-254 T32: the three entries below all carry `NO_POSIX_CONTAINMENT`, and
  // the full reasoning — including why this is scoping rather than a Windows
  // bug to fix, and what asserts the absence positively — lives in
  // `fixtures/platformScope.ts`, next to the predicate itself.
  //
  // Twenty assertions whose SUBJECT is a POSIX containment provider: the
  // root-owned bwrap namespace trial, the supervisor's process-GROUP ownership
  // and its PGID signal ladder, the bwrap bind/mask projection, and the macOS
  // Seatbelt profile text. The other six tests in the file run everywhere,
  // including the env rebuild, which asserts BOTH platforms' answers rather
  // than skipping one.
  'packages/backend/tests/rfc224-sealed-subprocess.test.ts#skipIf': 20,
  // `requireRootOwnedBwrap` is the Linux bwrap qualifier, so each diagnostic
  // names a POSIX condition (root ownership, parent-directory safety, setuid
  // bits). On Windows the fixtures' POSIX paths fail the CANONICAL check first,
  // so the suite reported `provider-path-not-canonical` where it expected
  // `provider-parent-unsafe` — a diagnostic regression on its face, and really
  // `/usr/bin/bwrap` resolving to `D:\usr\bin\bwrap`.
  'packages/backend/tests/bwrap-qualification-diagnostics.test.ts#skipIf': 1,
  // POSIX process-group REAPING: a wrapper exits, its detached descendant keeps
  // running, and the group kill must still reach it. Windows has no process
  // groups; the equivalent is a Job Object, which RFC-254 v1 deliberately did
  // not wire — the primitive exists and is tested, but nothing spawns into a job
  // yet, so there is no mechanism there for this to be about. The rest of the
  // file runs on Windows now that its fake binaries are platform-appropriate.
  'packages/backend/tests/opencode-models.test.ts#skipIf': 1,
  // The POSIX process GROUP and its TERM/KILL ladder: whether the group leader
  // is spared during the grace period is a statement about `kill(-pgid)`, which
  // Windows has no equivalent of. Guarded at the describe, so the count is 1.
  'packages/backend/tests/kill-grace-sandbox-monitor-2026-08-04.test.ts#skipIf': 1,
  // Three describes rendering provider input: the sandbox policy, the macOS
  // Seatbelt profile text, and the Linux bwrap argv. Guarded whole rather than
  // per-failing-assertion — a Seatbelt profile rendered from Windows paths is
  // not evidence about anything, so a test of it passing there is incidental.
  'packages/backend/tests/rfc205-sandbox-policy.test.ts#skipIf': 3,
  // One describe only — the `sandbox-exec` / `bwrap` argv head. The other two
  // describes in that file stay ungated deliberately, because one of them holds
  // the win32-injected 'unsupported platform → null mechanism, unavailable'
  // assertion that every entry above cites as its positive evidence. Guarding
  // the file wholesale would have silently removed the proof while leaving the
  // citations pointing at it.
  'packages/backend/tests/rfc205-sandbox-probe-wrap.test.ts#skipIf': 1,
  // RFC-227: the REAL macOS Seatbelt provider test shares the reviewed
  // RUN_SANDBOX_ITEST gate and is activated on every macOS backend shard.
  'packages/backend/tests/rfc227-seatbelt-integration.test.ts#skip': 1,
  // RFC-205: the REAL-mechanism sandbox smoke is RUN_SANDBOX_ITEST-gated
  // (activated on the macOS CI shards; the test re-probes and no-ops where
  // the mechanism is unusable).
  'packages/backend/tests/rfc205-sandbox-integration.test.ts#skip': 1,
  // 2026-08-04 沙箱审计：脚本节点 `network:'deny'` 的真围栏证据（被围栏进程出网被拒
  // **且** 工作树仍可写，外加一条不加围栏的对照组）。同一条已审阅的 RUN_SANDBOX_ITEST
  // 门，macOS 每个后端分片都激活；此前该承诺只有 argv / 渲染层断言。
  'packages/backend/tests/script-netless-real-fence-2026-08-04.test.ts#skip': 1,
  // RFC-242 T5: the REAL no-network evidence for claude's local-MCP children
  // (curl denied / worktree IO preserved) shares the same reviewed
  // RUN_SANDBOX_ITEST gate and is activated on every macOS backend shard. The
  // rest of that file — demand matrix, wrapper materialization, the runner
  // pre-spawn fence and the stdio round-trip — runs ungated everywhere.
  'packages/backend/tests/rfc242-claude-netless-mcp.test.ts#skip': 1,
  'packages/backend/tests/worktree-submodule-init.test.ts#skipIf': 1,
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
  RUN_GIT_PROTOCOLS: [
    { file: '.github/workflows/git-protocols-e2e.yml', marker: "RUN_GIT_PROTOCOLS: '1'" },
  ],
  // RFC-205: real-mechanism sandbox smoke — macOS backend shards have
  // sandbox-exec; the test itself re-probes and no-ops where unusable.
  RUN_SANDBOX_ITEST: [{ file: '.github/workflows/ci.yml', marker: "RUN_SANDBOX_ITEST: '1'" }],
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
})
