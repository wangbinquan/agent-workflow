// RFC-400 — no module that another production module imports may evaluate a top-level `await`.
//
// A module-level `await` makes its module an async ES module, and so every module that
// value-imports it, transitively. Bun 1.4.3's bundler then emits `await __promiseAll([...])`
// for a hoisted module that waits on two such inits and, in some build shapes, never defines
// the helper. Removing the `services/humanGateComposition.ts` bridge (RFC-400) re-shaped the
// maintenance Worker's graph that way: the compiled Worker failed to load with
// `ReferenceError: __promiseAll is not defined` (rfc370-maintenance-worker-real-effects,
// "a compiled standalone entry ..."). The only async root was the managed-process launcher's
// `if (import.meta.main) { process.exit(await ...) }` entry block, imported through task
// execution into collaboration. Script entries that nothing imports may still use it.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, packageSrcUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const BACKEND = backendUnits(ROOT)
const SHARED = packageSrcUnits(ROOT, 'shared')

/** Lines of `await` / `for await` evaluated with the module itself (outside every function). */
function topLevelAwaitLines(unit: SourceUnit): number[] {
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (
      ts.isAwaitExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
    ) {
      lines.push(unit.source.getLineAndCharacterOfPosition(node.getStart(unit.source)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(unit.source, visit)
  return lines
}

/** `importer -> module:lines` for every static value edge into a module with a top-level await. */
function importedAsyncModules(units: readonly SourceUnit[]): string[] {
  const roots = new Map<string, readonly number[]>()
  for (const unit of units) {
    const lines = topLevelAwaitLines(unit)
    if (lines.length > 0) roots.set(unit.path, lines)
  }
  const edges = createGateCorpus(units).edges.filter(
    (edge) => edge.kind === 'value' && edge.syntax !== 'dynamic-import' && roots.has(edge.target),
  )
  return [
    ...new Set(
      edges.map(
        (edge) => `${edge.from.path} -> ${edge.target}:${roots.get(edge.target)!.join(',')}`,
      ),
    ),
  ].sort()
}

const fixture = (path: string, text: string) => sourceUnit(PREFIX + path, text)

test('no imported production module evaluates a top-level await', () => {
  expect(BACKEND.length).toBeGreaterThanOrEqual(2000)
  expect(SHARED.length).toBeGreaterThanOrEqual(50)
  expect(importedAsyncModules([...BACKEND, ...SHARED])).toEqual([])
})

test('an entry block awaiting at module level turns its importers red', () => {
  const launcher = fixture(
    'platform/launcher.ts',
    [
      'export const NAME = "launcher"',
      'export async function run(): Promise<number> { return 0 }',
      'if (import.meta.main) {',
      '  process.exit(await run())',
      '}',
    ].join('\n'),
  )
  const stream = fixture(
    'platform/stream.ts',
    'export const lines: string[] = []\nfor await (const line of console) lines.push(line)\n',
  )
  const importer = fixture(
    'modules/task-execution/infrastructure/user.ts',
    "import { NAME } from '@/platform/launcher'\nexport { lines } from '../../../platform/stream'\nexport const name = NAME\n",
  )
  expect(importedAsyncModules([launcher, stream, importer])).toEqual([
    `${PREFIX}modules/task-execution/infrastructure/user.ts -> ${PREFIX}platform/launcher.ts:4`,
    `${PREFIX}modules/task-execution/infrastructure/user.ts -> ${PREFIX}platform/stream.ts:2`,
  ])
})

test('awaits inside functions, type-only and dynamic imports, and unimported scripts stay green', () => {
  const launcher = fixture(
    'platform/launcher.ts',
    [
      'export type Code = number',
      'export async function run(): Promise<Code> { return await Promise.resolve(0) }',
      'export const later = async () => { for await (const chunk of []) void chunk }',
      'export class Runner { async go() { await run() } }',
      'if (import.meta.main) {',
      '  void run().then((code) => process.exit(code))',
      '}',
    ].join('\n'),
  )
  const script = fixture('scripts/once.ts', 'await Promise.resolve()\n')
  const consumer = fixture(
    'modules/task-execution/infrastructure/user.ts',
    [
      "import { run } from '@/platform/launcher'",
      "import type { Code } from '@/platform/launcher'",
      "export const load = () => import('@/scripts/once')",
      'export const go = (): Promise<Code> => run()',
    ].join('\n'),
  )
  expect(importedAsyncModules([launcher, script, consumer])).toEqual([])
})
