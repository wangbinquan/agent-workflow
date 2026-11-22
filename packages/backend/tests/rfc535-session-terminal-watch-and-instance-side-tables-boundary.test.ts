// RFC-535 — 终态看门由会话构造；按对象挂的侧表归各自实例（RFC-294 S12 第十六步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① 五个文件（终态看门、执行参与者、迁移对照范围、工作区读取、材料引用）顶层没有 `let` 与 `new Map / Set / WeakMap / WeakSet`，架构报告的
//    模块级可变单例判据在这五个文件里为空；生产代码不再引用删去的名字；daemon 的 task-execution 装配只建一份看门、交给运行期参与者、
//    `hostTasks` 与模块集合，会话的已提交事件消费者调模块集合上那一份的 `notify`；材料定义只建一张引用表、自己查它并交给它建的编译器
//    （语料下限 3,000）。
// ② 行为：两份看门互不唤醒；参与者只认签发它的本机实现；对照范围盖在数组上、不可枚举，没盖范围的数组按完整任务；关闭后或别的工作区读取
//    能力被拒；两张材料引用表、两份材料定义互不相通，同一张表里编译记下的引用就是查到的引用。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { TaskStatusProjectionReadModel } from '@/modules/task-execution/public/types'
import { createTaskTerminalWatch } from '@/modules/task-execution/infrastructure/executionWatch'
import {
  bindLocalAgentExecutionParticipants,
  resolveLocalAgentExecutionParticipants,
} from '@/modules/task-execution/infrastructure/local/agentExecutionEffect'
import {
  bindOracleRow,
  requireSupersessionScope,
  requireTaskLabelScope,
  scopeOracleSnapshotRows,
} from '@/modules/task-execution/infrastructure/migration/oracle/scope'
import { bindTaskWorkspaceReadScope } from '@/modules/task-execution/infrastructure/workspaceRead'
import { createNativeAgentMaterialReferences } from '@/modules/runtime-management/infrastructure/local/agentMaterialCompiler'
import { selectLocalAgentMaterialDefinition } from '@/modules/runtime-management/composition/localAgentMaterial'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const WATCH = SRC + 'modules/task-execution/infrastructure/executionWatch.ts'
const PARTICIPANTS = SRC + 'modules/task-execution/infrastructure/local/agentExecutionEffect.ts'
const SCOPE = SRC + 'modules/task-execution/infrastructure/migration/oracle/scope.ts'
const WORKSPACE_READ = SRC + 'modules/task-execution/infrastructure/workspaceRead.ts'
const MATERIAL = SRC + 'modules/runtime-management/infrastructure/local/agentMaterialCompiler.ts'
const DEFINITION =
  SRC + 'modules/runtime-management/infrastructure/local/localAgentMaterialDefinition.ts'
const DAEMON_TE = SRC + 'bootstrap/daemonModules/taskExecution.ts'
const SESSION = SRC + 'bootstrap/daemonSession.ts'
const FILES = [WATCH, PARTICIPANTS, SCOPE, WORKSPACE_READ, MATERIAL]
const CORPUS_TIMEOUT = 30_000
/** The process-level registries RFC-535 removed; production must not name them again. */
const REMOVED = [
  'notifyTaskTerminal',
  'watchTaskTerminal',
  'resetTaskTerminalWatchersForTests',
  'bindOracleSnapshotScope',
  'bindNativeAgentMaterialReference',
  'getNativeAgentMaterialReference',
]
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])
/** The three places the daemon hands the session's watch to: run participants, host tasks and the module set. */
const WATCH_HANDOFFS = 3

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
const short = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function calls(unit: SourceUnit, callee: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  walk(unit.source, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(unit.source) === callee)
      found.push(node)
  })
  return found
}
/** Shorthand `name` properties and `name: name` assignments in the unit's object literals. */
function handoffs(unit: SourceUnit, name: string): number {
  let count = 0
  walk(unit.source, (node) => {
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === name) count++
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer.getText(unit.source) === name
    )
      count++
  })
  return count
}
/** The callees whose result initializes `const <name>`. */
function initializers(unit: SourceUnit, name: string): string[] {
  const found: string[] = []
  walk(unit.source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer)
    )
      found.push(node.initializer.expression.getText(unit.source))
  })
  return found
}

export function sideTableViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const unitOf = (path: string) => {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) errors.add('missing source: ' + path)
    return unit
  }
  for (const path of FILES) {
    const unit = unitOf(path)
    if (unit === undefined) continue
    for (const statement of unit.source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(unit.source)
        if ((statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
          errors.add(`module-level let:${short(path)}:${name}`)
        const init = declaration.initializer
        if (
          init !== undefined &&
          ts.isNewExpression(init) &&
          COLLECTIONS.has(init.expression.getText(unit.source))
        )
          errors.add(`module-level collection:${short(path)}:${name}`)
      }
    }
  }
  for (const entry of mutableSingletons(units.filter((unit) => FILES.includes(unit.path))))
    errors.add(`mutable singleton:${short(entry.file)}:${entry.symbol}`)
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`removed name:${unit.path}:${node.text}`)
    })
  }
  const daemon = unitOf(DAEMON_TE)
  if (daemon !== undefined) {
    const built = initializers(daemon, 'terminalWatch')
    if (built.length !== 1 || built[0] !== 'createTaskTerminalWatch')
      errors.add(`daemon wiring:terminal watch built ${String(built.length)}x`)
    if (calls(daemon, 'createTaskTerminalWatch').length !== 1)
      errors.add('daemon wiring:createTaskTerminalWatch calls')
    if (handoffs(daemon, 'terminalWatch') !== WATCH_HANDOFFS)
      errors.add(
        `daemon wiring:terminal watch handed ${String(handoffs(daemon, 'terminalWatch'))}x`,
      )
  }
  const session = unitOf(SESSION)
  if (
    session !== undefined &&
    calls(session, 'runtime.taskExecutionModules.terminalWatch.notify').length !== 1
  )
    errors.add('session:terminal watch notify')
  const definition = unitOf(DEFINITION)
  if (definition !== undefined) {
    const tables = initializers(definition, 'references')
    if (tables.length !== 1 || tables[0] !== 'createNativeAgentMaterialReferences')
      errors.add(`definition:reference tables ${String(tables.length)}`)
    if (calls(definition, 'references.reference').length !== 1)
      errors.add('definition:materialReference reads its table')
    const compiler = calls(definition, 'createLocalAgentMaterialCompiler')
    if (
      compiler.length !== 1 ||
      !compiler[0]!.arguments.some(
        (argument) =>
          ts.isObjectLiteralExpression(argument) &&
          argument.properties.some(
            (property) =>
              ts.isShorthandPropertyAssignment(property) && property.name.text === 'references',
          ),
      )
    )
      errors.add('definition:compiler gets its table')
  }
  return [...errors].sort()
}

describe('RFC-535 ① 终态看门与四张侧表没有进程级状态；daemon 把会话的那一份交给全部读者', () => {
  test(
    '真实语料：五个文件没有模块级状态，删去的名字不在，看门只建一份、交给三处、由会话消费者唤醒，材料定义自带引用表',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(sideTableViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

/** A status reader whose reads the test settles one by one: the second read is issued only after registration. */
function controlledStatusReader() {
  const reads: Array<(row: { status: string } | null) => void> = []
  let onRead = () => {}
  const reader = {
    find: () =>
      new Promise<{ status: string } | null>((settle) => {
        reads.push(settle)
        onRead()
      }),
  } as unknown as TaskStatusProjectionReadModel
  const issued = (count: number) =>
    new Promise<void>((done) => {
      const check = () => {
        if (reads.length >= count) done()
        else onRead = check
      }
      check()
    })
  return { reader, reads, issued }
}

describe('RFC-535 ② 实例持有的行为', () => {
  test('两份终态看门互不唤醒：只有登记所在的那一份的 notify 结算等待者', async () => {
    const own = createTaskTerminalWatch()
    const other = createTaskTerminalWatch()
    const { reader, reads, issued } = controlledStatusReader()
    const waiting = own.watch(reader, 'rfc535-task', { pollMs: 3_600_000 })
    await issued(1)
    reads[0]!({ status: 'running' })
    // The read after registration is issued only once the waiter is in `own`'s table.
    await issued(2)
    other.notify('rfc535-task', 'failed')
    own.notify('rfc535-task', 'done')
    expect(await waiting).toEqual({ kind: 'terminal', status: 'done' })
  })

  test('参与者只由签发它的本机实现解读：副本、伪造与缺省都不行', () => {
    const native = {
      persistence: {} as never,
      nodeExecution: () => ({}) as never,
      readOnlyWorkspace: () => false,
    }
    const participants = bindLocalAgentExecutionParticipants(native)
    expect(Object.isFrozen(participants.taskEffect)).toBe(true)
    expect(resolveLocalAgentExecutionParticipants(participants)).toBe(native)
    expect(resolveLocalAgentExecutionParticipants({})).toBeUndefined()
    for (const forged of [Object.freeze({}), { ...participants.taskEffect }])
      expect(() => resolveLocalAgentExecutionParticipants({ taskEffect: forged as never })).toThrow(
        'agent-execution-task-participant-unavailable',
      )
  })

  test('对照范围盖在快照的数组上：不可枚举、副本按完整任务、节点范围逐行校验', () => {
    const row = (id: string, nodeId: string, parentNodeRunId: string | null) =>
      bindOracleRow(
        { id, taskId: 'rfc535-task', nodeId, seq: 1, status: 'done', parentNodeRunId },
        false,
      )
    const scoped = [row('r1', 'n1', null), row('r2', 'n1', 'r1')]
    scopeOracleSnapshotRows(scoped, { kind: 'node', taskId: 'rfc535-task', nodeId: 'n1' })
    expect(Object.keys(scoped)).toEqual(['0', '1'])
    expect(() => requireTaskLabelScope(scoped, 'slot')).toThrow('oracle-snapshot-incomplete-slot')
    expect(() => requireSupersessionScope(scoped[0]!, scoped)).not.toThrow()
    expect(() => requireSupersessionScope(scoped[1]!, scoped)).toThrow(
      'oracle-snapshot-incomplete-supersession:r2',
    )
    const copy = [...scoped]
    expect(() => requireTaskLabelScope(copy, 'slot')).not.toThrow()
    expect(() => requireSupersessionScope(copy[1]!, copy)).not.toThrow()
    const task = [row('r3', 'n2', 'r1')]
    scopeOracleSnapshotRows(task, { kind: 'task' })
    expect(() => requireTaskLabelScope(task, 'role')).not.toThrow()
    expect(() =>
      scopeOracleSnapshotRows([row('r4', 'n2', null)], {
        kind: 'node',
        taskId: 'rfc535-task',
        nodeId: 'n1',
      }),
    ).toThrow('oracle-snapshot-scope-mismatch')
  })

  test('工作区读取：只认本作用域发的能力，关闭后一律拒绝', async () => {
    let closed = 0
    const scope = await bindTaskWorkspaceReadScope(
      {
        load: async () => ({ worktreePath: '/rfc535/worktree' }),
        contentScope: () => ({
          snapshot: {} as never,
          participant: { list: async () => 'listed', read: async () => 'read' } as never,
          close() {
            closed++
          },
        }),
      },
      'rfc535-task',
    )
    expect(await scope.port.list(scope.capability, {} as never)).toBe('listed' as never)
    await expect(scope.port.read(Object.freeze({}) as never, {} as never)).rejects.toThrow(
      'task-workspace-read-scope-ended-or-mismatched',
    )
    scope.close()
    expect(closed).toBe(1)
    await expect(scope.port.list(scope.capability, {} as never)).rejects.toThrow(
      'task-workspace-read-scope-ended-or-mismatched',
    )
  })

  test('材料引用：一张表里记下的就是查到的（含源计划），两张表、两份定义互不相通', () => {
    const references = createNativeAgentMaterialReferences()
    const compiled = {}
    references.record(compiled, 'aw-agent-material:rfc535')
    expect(references.reference(compiled)).toBe('aw-agent-material:rfc535')
    expect(references.reference({}, compiled)).toBe('aw-agent-material:rfc535')
    const other = createNativeAgentMaterialReferences()
    expect(other.reference(compiled)).not.toBe('aw-agent-material:rfc535')
    expect(other.reference(compiled)).toBe(other.reference(compiled))
    for (const kind of ['opencode', 'claude-code'] as const) {
      const a = selectLocalAgentMaterialDefinition(kind)
      const b = selectLocalAgentMaterialDefinition(kind)
      const plan = {}
      expect(a.materialReference(plan)).toBe(a.materialReference(plan))
      expect(b.materialReference(plan)).not.toBe(a.materialReference(plan))
    }
  })
})

describe('RFC-535 负对照', () => {
  const clean = [
    sourceUnit(WATCH, 'export function createTaskTerminalWatch() { const watchers = new Map() }'),
    sourceUnit(PARTICIPANTS, 'class Participant { readonly #native = null }'),
    sourceUnit(SCOPE, "const ORACLE_SNAPSHOT_SCOPE = Symbol('oracle-snapshot-scope')"),
    sourceUnit(WORKSPACE_READ, 'export async function bindTaskWorkspaceReadScope() {}'),
    sourceUnit(
      MATERIAL,
      'export function createNativeAgentMaterialReferences() { const t = new WeakMap() }',
    ),
    sourceUnit(
      DEFINITION,
      [
        'const references = createNativeAgentMaterialReferences()',
        'const materialReference = (plan) => references.reference(plan)',
        'createLocalAgentMaterialCompiler({ protocol, references })',
      ].join('\n'),
    ),
    sourceUnit(
      DAEMON_TE,
      [
        'const terminalWatch = createTaskTerminalWatch()',
        'compose({ runtime: { childTaskBudget, terminalWatch } })',
        'const hostTasks = Object.freeze({ db, terminalWatch })',
        'return Object.freeze({ childTaskBudget, terminalWatch })',
      ].join('\n'),
    ),
    sourceUnit(
      SESSION,
      'const consumer = { async notifyExecutionWatch(taskId, status) { runtime.taskExecutionModules.terminalWatch.notify(taskId, status) } }',
    ),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(sideTableViolations(clean)).toEqual([])
  })

  test('模块级集合与 let、写模块状态的导出函数与删去的名字都会被认出', () => {
    expect(
      sideTableViolations(
        replace(
          WATCH,
          'const watchers = new Map()\nexport function resetTaskTerminalWatchersForTests() { watchers.clear() }',
        ),
      ),
    ).toEqual([
      'module-level collection:executionWatch.ts:watchers',
      'mutable singleton:executionWatch.ts:resetTaskTerminalWatchersForTests',
      `removed name:${WATCH}:resetTaskTerminalWatchersForTests`,
    ])
    expect(
      sideTableViolations(
        replace(
          PARTICIPANTS,
          'const table = new WeakMap()\nexport function bindLocalAgentExecutionParticipants(i) { table.set(i, i) }',
        ),
      ),
    ).toEqual([
      'module-level collection:agentExecutionEffect.ts:table',
      'mutable singleton:agentExecutionEffect.ts:bindLocalAgentExecutionParticipants',
    ])
    expect(sideTableViolations(replace(SCOPE, 'let scopes = new WeakMap()'))).toEqual([
      'module-level collection:scope.ts:scopes',
      'module-level let:scope.ts:scopes',
      'mutable singleton:scope.ts:scopes',
    ])
  })

  test('看门建了两份、交漏一处、会话消费者不调模块集合上那一份，材料定义不自带引用表，都会被认出', () => {
    expect(
      sideTableViolations(
        replace(
          DAEMON_TE,
          [
            'const terminalWatch = createTaskTerminalWatch()',
            'compose({ runtime: { childTaskBudget, terminalWatch: createTaskTerminalWatch() } })',
            'return Object.freeze({ childTaskBudget, terminalWatch })',
          ].join('\n'),
        ),
      ),
    ).toEqual([
      'daemon wiring:createTaskTerminalWatch calls',
      'daemon wiring:terminal watch handed 1x',
    ])
    expect(
      sideTableViolations(
        replace(SESSION, 'const consumer = { async notifyExecutionWatch(taskId, status) {} }'),
      ),
    ).toEqual(['session:terminal watch notify'])
    expect(
      sideTableViolations(
        replace(
          DEFINITION,
          [
            'const materialReference = (plan) => createNativeAgentMaterialReferences().reference(plan)',
            'createLocalAgentMaterialCompiler({ protocol })',
          ].join('\n'),
        ),
      ),
    ).toEqual([
      'definition:compiler gets its table',
      'definition:materialReference reads its table',
      'definition:reference tables 0',
    ])
  })
})
