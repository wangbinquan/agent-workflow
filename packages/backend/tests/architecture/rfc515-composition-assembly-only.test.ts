// RFC-515 — 组合层只装配的全模块门（RFC-294 S10 第二十二步）。
//
// RFC-294 plan §3 S10：把 RFC-414 / RFC-423 的收口锁改写为一条覆盖全部模块的门——组合层（每个模块的 `composition/` 目录与模块根的
// `composition.ts`）没有循环与 switch、没有 `try` / `throw`，不做 DB / FS / 进程 / git 工作（禁用 import 与调用逐字取自 RFC-414）。例外清单逐文件
// 登记、写明后继；实测有违反的文件集合必须与清单逐文件相等：清单外的违反与清单里已不违反的文件（陈旧例外）都报红，清单只减不增。例外文件内部的
// 增长由按模块的 F13 计数（`composition-control-flow-<module>`）与 `composition-forbidden-import-files` 挡住。
//
// 另钉 RFC-515 唯一的归位（design D2）：`loadSkillOperationState` 只在 resource-catalog 的 `infrastructure/skillOperationStateQuery.ts` 声明，
// `composition/intentApply.ts` 引用它、不再取 `@/platform/persistence/queryHelpers`。
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const MODULES = 'packages/backend/src/modules/'
/** RFC-414's list, verbatim: modules a composition file may not import (type-only imports included). */
const FORBIDDEN_IMPORTS = [
  /^drizzle-orm(?:\/|$)/,
  /^bun:sqlite$/,
  /^@\/platform\/persistence\/sessionTables$/,
  /^@\/platform\/persistence\/queryHelpers$/,
  /^(?:node:)?fs(?:\/promises)?$/,
  /^(?:node:)?child_process$/,
  /^@\/util\/git$/,
]
/** RFC-414's list, verbatim: calls a composition file may not make. */
const FORBIDDEN_CALLS = ['tablesOf(', 'Bun.spawn(']
const RFC370 = 'RFC-370 余项：crewstation / taskImage 的托管实现归 infrastructure'
const ROOTS = 'S10 后继：模块根 composition.ts 的运行期逻辑迁出'
/** design §2 D1: every composition file that may still break a rule, and the successor that clears it. */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  [MODULES + 'development-automation/composition/crewstationEvidence.ts']: RFC370,
  [MODULES + 'development-automation/composition/crewstationEvidenceStaging.ts']: RFC370,
  [MODULES + 'development-automation/composition/crewstationVerification.ts']: RFC370,
  [MODULES + 'development-automation/composition/crewstationWorkspace.ts']: RFC370,
  [MODULES + 'development-automation/composition/taskImageEvidence.ts']: RFC370,
  [MODULES + 'development-automation/composition/taskImageVerification.ts']: RFC370,
  [MODULES + 'development-automation/composition/taskImageWorkspace.ts']: RFC370,
  [MODULES + 'digital-employee/composition.ts']: ROOTS,
  [MODULES + 'digital-employee/composition/crewstationContent.ts']: RFC370,
  [MODULES + 'event-center/composition/taskImageObserver.ts']: RFC370,
  [MODULES + 'integration/composition/crewstationDevelopmentAdapters.ts']: RFC370,
  [MODULES + 'integration/composition/taskImageDevelopmentAdapter.ts']: RFC370,
  [MODULES + 'intent/composition/crewstationArtifacts.ts']: RFC370,
  [MODULES + 'intent/composition/crewstationScratch.ts']: RFC370,
  [MODULES + 'resource-catalog/composition/crewstationArtifacts.ts']: RFC370,
  [MODULES + 'resource-catalog/composition/crewstationMcpDiagnostics.ts']: RFC370,
  [MODULES + 'resource-catalog/composition/crewstationNativePlugin.ts']: RFC370,
  [MODULES + 'resource-catalog/composition/taskImagePlugin.ts']: RFC370,
  [MODULES + 'runtime-management/composition/crewstationRuntimeManagement.ts']: RFC370,
  [MODULES + 'runtime-management/composition/crewstationSystemAgentMaterial.ts']: RFC370,
  [MODULES + 'runtime-management/composition/taskImageMaterial.ts']: RFC370,
  [MODULES + 'source-control/composition/crewstationWorkspace.ts']: RFC370,
  [MODULES + 'source-control/composition/taskImageIsolation.ts']: RFC370,
  [MODULES + 'source-control/composition/taskImageRepositoryEffects.ts']: RFC370,
  [MODULES + 'source-control/composition/taskImageUploads.ts']: RFC370,
  [MODULES + 'source-control/composition/taskImageWorkspace.ts']: RFC370,
  [MODULES + 'system-operations/composition.ts']: ROOTS,
  [MODULES + 'system-operations/composition/crewstationDatabaseRestore.ts']: RFC370,
  [MODULES + 'system-operations/composition/crewstationDeployment.ts']: RFC370,
  [MODULES + 'task-execution/composition.ts']: ROOTS,
}
const UNITS = backendUnits(ROOT)

/** A `composition/` file or a module root `composition.ts`. */
function isComposition(path: string): boolean {
  if (!path.startsWith(MODULES) || !path.endsWith('.ts')) return false
  const parts = path.slice(MODULES.length).split('/')
  return parts.length === 2 ? parts[1] === 'composition.ts' : parts[1] === 'composition'
}

const forbiddenImport = (specifier: string) =>
  FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier))

/** Every rule the unit breaks, in source order (calls last). */
function findings(unit: SourceUnit): string[] {
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    )
      found.push('loop')
    if (ts.isSwitchStatement(node)) found.push('switch')
    if (ts.isTryStatement(node)) found.push('try')
    if (ts.isThrowStatement(node)) found.push('throw')
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      forbiddenImport(node.moduleSpecifier.text)
    )
      found.push('import:' + node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      forbiddenImport(node.arguments[0].text)
    )
      found.push('import:' + node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  for (const call of FORBIDDEN_CALLS) if (unit.text.includes(call)) found.push('call:' + call)
  return found
}

/** Composition files breaking a rule outside the list, and listed files that no longer break one. */
function gate(units: readonly SourceUnit[]): { unregistered: string[]; stale: string[] } {
  const unregistered: string[] = []
  const stale: string[] = []
  for (const unit of units) {
    if (!isComposition(unit.path)) continue
    const found = findings(unit)
    if (EXCEPTIONS[unit.path] === undefined) {
      if (found.length > 0) unregistered.push(`${unit.path}: ${[...new Set(found)].join(', ')}`)
    } else if (found.length === 0) stale.push(unit.path)
  }
  return { unregistered: unregistered.sort(), stale: stale.sort() }
}

test('live corpus: every module composition only assembles, outside the listed exceptions', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  const composition = UNITS.filter((unit) => isComposition(unit.path))
  expect(composition.length).toBeGreaterThanOrEqual(350)
  expect(
    composition.filter((unit) => unit.path.endsWith('/composition.ts')).length,
  ).toBeGreaterThanOrEqual(15)
  const result = gate(UNITS)
  expect(result.unregistered).toEqual([])
  expect(result.stale).toEqual([])
  const listed = Object.keys(EXCEPTIONS)
  expect(listed.filter((path) => !existsSync(resolve(ROOT, path)))).toEqual([])
  expect(listed.filter((path) => !isComposition(path))).toEqual([])
  expect([...listed].sort()).toEqual(listed)
  // RFC-516 cleared the event-center, identity-access and source-control module roots.
  expect(listed).toHaveLength(30)
})

test('negative fixtures: each rule is caught in composition files and module roots only; listed files are judged against the list', () => {
  const file = MODULES + 'probe/composition/fabricated.ts'
  for (const [body, rule] of [
    ['export function f(xs: number[]) { for (const x of xs) void x }', 'loop'],
    ['export function f() { while (Math.random() > 2) break }', 'loop'],
    ['export function f(k: string) { switch (k) { default: return k } }', 'switch'],
    ['export const f = () => { try { return 1 } finally { void 0 } }', 'try'],
    ['export function f() { throw new Error("logic") }', 'throw'],
    ["import { eq } from 'drizzle-orm'", 'import:drizzle-orm'],
    ["import type { Database } from 'bun:sqlite'", 'import:bun:sqlite'],
    [
      "export { first } from '@/platform/persistence/queryHelpers'",
      'import:@/platform/persistence/queryHelpers',
    ],
    ["export const f = () => import('node:fs/promises')", 'import:node:fs/promises'],
    ["import { spawn } from 'child_process'", 'import:child_process'],
    ["import { runGit } from '@/util/git'", 'import:@/util/git'],
    ['export const f = (db: never) => tablesOf(db)', 'call:tablesOf('],
    ["export const f = () => Bun.spawn(['true'])", 'call:Bun.spawn('],
  ] as const)
    expect(gate([sourceUnit(file, body)]).unregistered, body).toEqual([`${file}: ${rule}`])
  const root = MODULES + 'probe/composition.ts'
  expect(gate([sourceUnit(root, 'export function f() { throw 1 }')]).unregistered).toEqual([
    `${root}: throw`,
  ])
  for (const outside of [
    MODULES + 'probe/application/x.ts',
    MODULES + 'probe/infrastructure/composition.ts',
    'packages/backend/src/bootstrap/x.ts',
  ])
    expect(
      gate([sourceUnit(outside, 'export function f() { try { throw 1 } finally {} }')])
        .unregistered,
      outside,
    ).toEqual([])
  const listed = Object.keys(EXCEPTIONS)[0]!
  expect(gate([sourceUnit(listed, 'export function f() { throw 1 }')])).toEqual({
    unregistered: [],
    stale: [],
  })
  expect(gate([sourceUnit(listed, 'export const f = 1')]).stale).toEqual([listed])
})

test('RFC-515 D2: the operation state read lives in infrastructure; the composition only references it', () => {
  const declaring = UNITS.filter((unit) => {
    let found = false
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'loadSkillOperationState')
        found = true
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
    return found
  }).map((unit) => unit.path)
  expect(declaring).toEqual([
    MODULES + 'resource-catalog/infrastructure/skillOperationStateQuery.ts',
  ])
  const intentApply = UNITS.find(
    (unit) => unit.path === MODULES + 'resource-catalog/composition/intentApply.ts',
  )!
  expect(intentApply.text).toContain(
    "import { loadSkillOperationState } from '../infrastructure/skillOperationStateQuery'",
  )
  expect(intentApply.text).not.toContain('@/platform/persistence/queryHelpers')
  expect(findings(intentApply)).toEqual([])
})
