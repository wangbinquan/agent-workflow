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
  'e2e/git-protocols.spec.ts#skip': 2,
  'e2e/visual-regression.spec.ts#skip': 1,
  'e2e/workflow-editor.spec.ts#skip': 1,
  'packages/backend/tests/git-repo-cache-submodule.test.ts#skipIf': 1,
  'packages/backend/tests/integration-chaos/chaos-scenarios.integration.test.ts#skipIf': 1,
  'packages/backend/tests/integration-opencode/opencode-live.integration.test.ts#skipIf': 1,
  'packages/backend/tests/mcp-probe-http-integration.test.ts#skipIf': 1,
  'packages/backend/tests/mcp-probe-stdio-integration.test.ts#skipIf': 1,
  'packages/backend/tests/worktree-submodule-init.test.ts#skipIf': 1,
}

interface TestModifierUse {
  file: string
  line: number
  modifier: string
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
): { modifiers: TestModifierUse[]; aliases: TestModifierUse[] } {
  const modifiers: TestModifierUse[] = []
  const aliases: TestModifierUse[] = []
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const visit = (node: ts.Node): void => {
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

  return { modifiers, aliases }
}

function collectTestModifiers(): { modifiers: TestModifierUse[]; aliases: TestModifierUse[] } {
  const modifiers: TestModifierUse[] = []
  const aliases: TestModifierUse[] = []

  for (const absolute of TEST_ROOTS.flatMap(listTestFiles)) {
    const file = relative(REPO_ROOT, absolute)
    const parsed = parseTestModifiers(file, readFileSync(absolute, 'utf8'))
    modifiers.push(...parsed.modifiers)
    aliases.push(...parsed.aliases)
  }

  return { modifiers, aliases }
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
      `,
    )

    expect(probe.modifiers.map(({ modifier }) => modifier).sort()).toEqual(
      ['only', 'skip', 'runIf', 'fixme', 'todo', 'fail'].sort(),
    )
    expect(probe.aliases.map(({ modifier }) => modifier)).toEqual(['fit'])
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
})
