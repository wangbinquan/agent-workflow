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

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const TEST_ROOTS = [
  resolve(REPO_ROOT, 'packages', 'backend', 'tests'),
  resolve(REPO_ROOT, 'packages', 'shared', 'tests'),
  resolve(REPO_ROOT, 'packages', 'frontend', 'tests'),
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
  'e2e/clarify.spec.ts#skip': 1,
  // RFC-206: the focus-ring geometry audit measures a forced :focus-visible
  // state, which only Chrome DevTools Protocol (CSS.forcePseudoState) can
  // produce — programmatic focus does not reliably match :focus-visible. The
  // spec therefore skips on non-chromium projects (webkit is the opt-in
  // nightly run; chromium is the PR-gating default, so no gating coverage is
  // lost).
  'e2e/focus-ring-clip.spec.ts#skip': 1,
  'e2e/git-protocols.spec.ts#skip': 2,
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
  // RFC-205: the REAL-mechanism sandbox smoke is RUN_SANDBOX_ITEST-gated
  // (activated on the macOS CI shards; the test re-probes and no-ops where
  // the mechanism is unusable).
  'packages/backend/tests/rfc205-sandbox-integration.test.ts#skip': 1,
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
        '"test:visual": "RUN_VISUAL_REGRESSION=1 playwright test e2e/visual-regression.spec.ts --project=chromium",',
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
    const file = relative(REPO_ROOT, absolute)
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
