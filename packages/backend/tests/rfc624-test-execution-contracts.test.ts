// RFC-624: reduce repeated preparation without changing discovery, isolation or retry budgets.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import frontendConfig from '../../frontend/vitest.config'
import playwrightConfig from '../../../playwright.config'
import { runTestCommand } from './helpers/testCommand'

const root = resolve(import.meta.dir, '../../..')
const require = createRequire(import.meta.url)
const independentSpecs = [
  ['e2e/rfc294-human-gate-restart.spec.ts', 3],
  ['e2e/crash-recovery.spec.ts', 3],
  ['e2e/task-lifecycle-states.spec.ts', 7],
] as const
const nodeGuards = [
  'tests/canvas-corner-theming-source.test.ts',
  'tests/canvas-wrapper-styles.test.ts',
  'tests/btn-variants-styles.test.ts',
  'tests/tabs-modifier-styles.test.ts',
].sort()

function retryModesAndCases(path: string) {
  const source = ts.createSourceFile(
    path,
    readFileSync(join(root, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const modes: string[] = []
  const hooks: string[] = []
  let cases = 0
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      if (callee === 'test') cases++
      if (/^test\.(beforeAll|beforeEach|afterAll|afterEach)$/.test(callee)) hooks.push(callee)
      if (callee === 'test.describe.configure') {
        const options = node.arguments[0]
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === 'mode' &&
              ts.isStringLiteral(property.initializer)
            )
              modes.push(property.initializer.text)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { modes, hooks, cases }
}

test('independent restart suites retain all 13 cases and ordered per-case retry units', () => {
  for (const [file, cases] of independentSpecs) {
    expect(retryModesAndCases(file)).toEqual({ modes: ['default'], hooks: [], cases })
  }
  expect(playwrightConfig.fullyParallel ?? false).toBe(false)
  expect(playwrightConfig.workers).toBe(4)
  expect(playwrightConfig.retries).toBe(process.env.CI ? 1 : 0)
})

interface ExecutionRecord {
  title: string
  retry: number
}

async function retryProbe(mode: 'default' | 'serial'): Promise<ExecutionRecord[]> {
  const directory = mkdtempSync(join(tmpdir(), 'aw-rfc624-retry-'))
  try {
    const events = join(directory, 'events.jsonl')
    const playwright = JSON.stringify(require.resolve('@playwright/test'))
    writeFileSync(
      join(directory, 'playwright.config.cjs'),
      `module.exports = { testDir: ${JSON.stringify(directory)}, testMatch: '**/retry.spec.js', fullyParallel: false, workers: 1, retries: 1, timeout: 5000, reporter: 'list', outputDir: ${JSON.stringify(join(directory, 'results'))} };\n`,
    )
    writeFileSync(
      join(directory, 'retry.spec.js'),
      `const { test, expect } = require(${playwright});
const { appendFileSync } = require('node:fs');
test.describe.configure({ mode: ${JSON.stringify(mode)} });
for (const title of ['first', 'second', 'flaky']) {
  test(title, async ({}, info) => {
    appendFileSync(${JSON.stringify(events)}, JSON.stringify({ title, retry: info.retry }) + '\\n');
    if (title === 'flaky') expect(info.retry).toBe(1);
  });
}
`,
    )
    await runTestCommand(
      [
        'node',
        require.resolve('@playwright/test/cli'),
        'test',
        '--config',
        join(directory, 'playwright.config.cjs'),
      ],
      {
        cwd: directory,
        timeoutMs: 30_000,
        // The probe owns its output and has no browser fixture or repository global setup.
        env: { ...process.env, FORCE_COLOR: '0', PLAYWRIGHT_JSON_OUTPUT_NAME: undefined },
        label: `Playwright ${mode} retry contract`,
      },
    )
    return readFileSync(events, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ExecutionRecord)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('native Playwright keeps order and retries only the failing independent case', async () => {
  const initial = ['first', 'second', 'flaky'].map((title) => ({ title, retry: 0 }))
  expect(await retryProbe('default')).toEqual([...initial, { title: 'flaky', retry: 1 }])
  // Positive control: the same injected failure in serial mode repeats passed neighbors.
  expect(await retryProbe('serial')).toEqual([
    ...initial,
    ...['first', 'second', 'flaky'].map((title) => ({ title, retry: 1 })),
  ])
}, 70_000)

describe('frontend source guards retain their original discovery and budgets', () => {
  test('only the four audited source files leave the DOM project, whose setup remains intact', () => {
    const config = frontendConfig as {
      resolve?: unknown
      test?: {
        css?: boolean
        globals?: boolean
        testTimeout?: number
        hookTimeout?: number
        setupFiles?: unknown
        environment?: unknown
        projects?: { extends?: boolean; test: Record<string, unknown> }[]
      }
    }
    expect(config.resolve).toBeDefined()
    expect(config.test?.testTimeout).toBe(30_000)
    expect(config.test?.hookTimeout).toBe(30_000)
    expect(config.test?.css).toBe(false)
    expect(config.test?.globals).toBe(false)
    expect(config.test?.setupFiles).toBeUndefined()
    expect(config.test?.environment).toBeUndefined()
    const projects = config.test?.projects ?? []
    expect(projects).toHaveLength(2)
    expect(projects.every((project) => project.extends === true)).toBe(true)
    const node = projects.find((project) => project.test.name === 'source-guards')?.test
    const dom = projects.find((project) => project.test.name === 'dom')?.test
    expect(node?.environment).toBe('node')
    expect([...(node?.include as string[])].sort()).toEqual(nodeGuards)
    expect(node?.setupFiles ?? []).toEqual([])
    expect(dom?.environment).toBe('happy-dom')
    expect(dom?.setupFiles).toEqual(['./tests/setup.ts'])
    expect(dom?.environmentOptions).toEqual({ happyDOM: { url: 'http://localhost/' } })
    for (const file of nodeGuards) expect(dom?.exclude).toContain(file)
    expect(dom?.include).toBeUndefined()
  })
})
