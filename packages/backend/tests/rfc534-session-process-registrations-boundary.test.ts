// RFC-534 — 终态工作区回收策略与记忆蒸馏策略由会话交入（RFC-294 S12 第十五步）。
//
// 锁两件事（design §3 的清单即退出门）：
// ① `task-execution/infrastructure/terminalWorkspacePrune.ts` 与 `memory/application/distill/schedule.ts` 顶层没有 `let`，没有导出的
//    `register*` / `set*` / `reset*` / `bind*`；生产代码不再引用删去的名字；启动程序没有 `process-registrations` 步，运行期会话的输入没有
//    `beforeResume`；daemon 只组合一次回收策略，把这一份交给 task-execution 与 integration 的装配、把蒸馏策略交给 memory 的装配；维护
//    Worker 交具名的从不回收（语料下限 3,000）。
// ② 行为：判定只在 done / canceled 问策略、策略抛错给不回收；持久化聚合带的是它装配时拿到的那一份；入队按交入的蒸馏策略准入。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { DEFAULT_DISTILL_POLICY, type DistillPolicy } from '@agent-workflow/shared'
import { enqueueDistillJob } from '@/modules/memory/application/distill/schedule'
import type { MemoryDistillWorkStore } from '@/modules/memory/application/ports/distillWorkStore'
import { composeHumanGateOpenParticipantFactory } from '@/modules/collaboration/composition'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition/workspacePresence'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  neverPruneTerminalWorkspaces,
  resolveTerminalWorkspacePruneDecision,
  type TerminalWorkspacePrunePolicy,
} from '@/modules/task-execution/infrastructure/terminalWorkspacePrune'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { describeEachProvider } from './helpers/eachProvider'
import { prunePolicyOf } from './helpers/terminalWorkspacePrune'
import type { TerminalWorkspacePruneCandidate } from '@/modules/task-execution/domain/terminalWorkspacePrune'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const PRUNE = SRC + 'modules/task-execution/infrastructure/terminalWorkspacePrune.ts'
const SCHEDULE = SRC + 'modules/memory/application/distill/schedule.ts'
const APPLICATION = SRC + 'bootstrap/daemonApplication.ts'
const PROGRAM = SRC + 'bootstrap/daemonLifecycleProgram.ts'
const SESSION = SRC + 'bootstrap/daemonProviderRuntimeSession.ts'
const WORKER = SRC + 'bootstrap/maintenanceWorkerGraph.ts'
const CORPUS_TIMEOUT = 30_000
/** The process registrations RFC-534 removed; production must not name them again. */
const REMOVED = [
  'registerTerminalWorkspacePrunePolicy',
  'setMemoryDistillPolicyProvider',
  'resetMemoryDistillPolicyProviderForTest',
]
const MUTATOR = /^(set|register|reset|bind)[A-Z]/
const NEVER = 'neverPruneTerminalWorkspaces'

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
const short = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function calls(unit: SourceUnit, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  walk(unit.source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      found.push(node)
  })
  return found
}
/** The text of `prop` in the first object-literal argument of the call (a shorthand reads as its name). */
function propertyOf(call: ts.CallExpression, prop: string, unit: SourceUnit): string | undefined {
  const arg = call.arguments.find(ts.isObjectLiteralExpression)
  for (const property of arg?.properties ?? []) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === prop)
      return property.name.text
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === prop
    )
      return property.initializer.getText(unit.source)
  }
  return undefined
}

export function registrationViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const unitOf = (path: string) => {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) errors.add('missing source: ' + path)
    return unit
  }
  for (const path of [PRUNE, SCHEDULE]) {
    const unit = unitOf(path)
    if (unit === undefined) continue
    for (const statement of unit.source.statements) {
      if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
      )
        for (const declaration of statement.declarationList.declarations)
          errors.add(`module-level let:${short(path)}:${declaration.name.getText(unit.source)}`)
      if (
        ts.isFunctionDeclaration(statement) &&
        exported(statement) &&
        statement.name !== undefined &&
        MUTATOR.test(statement.name.text)
      )
        errors.add(`exported mutator:${short(path)}:${statement.name.text}`)
    }
  }
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`removed name:${unit.path}:${node.text}`)
    })
  }
  const program = unitOf(PROGRAM)
  if (program !== undefined)
    walk(program.source, (node) => {
      if (ts.isStringLiteral(node) && node.text === 'process-registrations')
        errors.add('boot step:process-registrations')
    })
  const session = unitOf(SESSION)
  if (session !== undefined)
    walk(session.source, (node) => {
      if (ts.isIdentifier(node) && node.text === 'beforeResume')
        errors.add('resume hook:beforeResume')
    })
  const application = unitOf(APPLICATION)
  if (application !== undefined) {
    const composed = calls(application, 'composeWebhookTerminalWorkspacePrunePolicy')
    const declared = composed.filter(
      (call) =>
        ts.isVariableDeclaration(call.parent) &&
        call.parent.name.getText(application.source) === 'terminalWorkspacePrune',
    )
    if (composed.length !== 1 || declared.length !== 1)
      errors.add(`daemon wiring:prune policy composed ${String(composed.length)}x`)
    for (const [bundle, prop, value] of [
      ['composeDaemonTaskExecutionModules', 'terminalWorkspacePrune', 'terminalWorkspacePrune'],
      ['composeDaemonIntegrationModules', 'terminalWorkspacePrune', 'terminalWorkspacePrune'],
      ['composeDaemonMemoryModules', 'distillPolicy', 'distillPolicy'],
    ] as const) {
      const sites = calls(application, bundle)
      if (sites.length !== 1 || propertyOf(sites[0]!, prop, application) !== value)
        errors.add(`daemon wiring:${bundle}.${prop}`)
    }
  }
  const worker = unitOf(WORKER)
  if (worker !== undefined) {
    const persistence = calls(worker, 'createTaskExecutionPersistence')
    if (
      persistence.length !== 1 ||
      propertyOf(persistence[0]!, 'terminalWorkspacePrune', worker) !== NEVER
    )
      errors.add('worker:persistence policy')
    const closure = calls(worker, 'composeCrossContextClosure')
    if (closure.length !== 1 || closure[0]!.arguments[3]?.getText(worker.source) !== NEVER)
      errors.add('worker:closure policy')
  }
  return [...errors].sort()
}

describe('RFC-534 ① 两条策略没有进程级登记；daemon 把它们交进会话的装配', () => {
  test(
    '真实语料：两个文件没有顶层 let 与导出的登记函数，删去的名字与启动步都不在，daemon 与维护 Worker 交对了策略',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(registrationViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-534 ② 会话策略的行为', () => {
  const row: TerminalWorkspacePruneCandidate = {
    taskId: 'rfc534-task',
    spaceKind: 'remote',
    workspacePruningAt: null,
    workspacePruneCause: null,
    workspacePrunedAt: null,
  }

  test('判定只在 done / canceled 问交入的策略；策略抛错给不回收；具名的从不回收', async () => {
    const policy = mock(async () => ({ prune: true, cause: 'webhook-terminal' }) as const)
    for (const to of ['failed', 'interrupted', 'running'] as const)
      expect(await resolveTerminalWorkspacePruneDecision(prunePolicyOf(policy), row, to)).toEqual({
        prune: false,
      })
    expect(policy).not.toHaveBeenCalled()
    expect(
      await resolveTerminalWorkspacePruneDecision(prunePolicyOf(policy), row, 'canceled'),
    ).toEqual({
      prune: true,
      cause: 'webhook-terminal',
    })
    const throwing: TerminalWorkspacePrunePolicy = prunePolicyOf(async () => {
      throw new Error('rfc534 corrupt config')
    })
    expect(await resolveTerminalWorkspacePruneDecision(throwing, row, 'done')).toEqual({
      prune: false,
    })
    expect(await neverPruneTerminalWorkspaces.decide(row, 'done')).toEqual({ prune: false })
  })

  test('入队按交入的蒸馏策略准入：同一份 store，两份策略各判各的', async () => {
    const enqueued: unknown[] = []
    const store = {
      findTaskScope: async () => null,
      enqueue: async (job: unknown) => {
        enqueued.push(job)
      },
      events: { distillJob: () => {} },
    } as unknown as MemoryDistillWorkStore
    const deny: DistillPolicy = {
      ...DEFAULT_DISTILL_POLICY,
      sources: { ...DEFAULT_DISTILL_POLICY.sources, feedback: false },
    }
    const input = { sourceKind: 'feedback', sourceEventId: 'rfc534-evt', taskId: null } as const
    expect(await enqueueDistillJob(store, () => deny, input)).toBeNull()
    expect(enqueued).toHaveLength(0)
    expect(await enqueueDistillJob(store, () => DEFAULT_DISTILL_POLICY, input)).not.toBeNull()
    expect(enqueued).toHaveLength(1)
  })
})

describeEachProvider('RFC-534 ② 持久化聚合带的是装配时交入的那一份策略', (harness) => {
  test('两份持久化各带各的', () => {
    const build = (policy: TerminalWorkspacePrunePolicy) =>
      createTaskExecutionPersistence(harness.db, {
        workspacePresence: createFileWorkspacePresenceQueries(),
        terminalWorkspacePrune: policy,
        humanGateOpen: composeHumanGateOpenParticipantFactory(),
        historyRestrictions: epoch2RuntimeTestPorts(harness.db).historyRestrictions,
      })
    const a: TerminalWorkspacePrunePolicy = prunePolicyOf(async () => ({ prune: false }))
    const b: TerminalWorkspacePrunePolicy = prunePolicyOf(async () => ({ prune: false }))
    expect(build(a).terminalWorkspacePrune).toBe(a)
    expect(build(b).terminalWorkspacePrune).toBe(b)
  })
})

describe('RFC-534 负对照', () => {
  const clean = [
    sourceUnit(PRUNE, 'export const neverPruneTerminalWorkspaces = async () => ({ prune: false })'),
    sourceUnit(SCHEDULE, 'export type MemoryDistillPolicySource = () => unknown'),
    sourceUnit(PROGRAM, "export const DAEMON_BOOT_STEPS = [{ id: 'runtime-declarations' }]"),
    sourceUnit(SESSION, 'export interface Input { readonly readyOnResume?: boolean }'),
    sourceUnit(
      APPLICATION,
      [
        'const terminalWorkspacePrune = composeWebhookTerminalWorkspacePrunePolicy({ db })',
        'const distillPolicy = async () => policy',
        'composeDaemonMemoryModules({ db, distillPolicy })',
        'composeDaemonTaskExecutionModules({ db, terminalWorkspacePrune })',
        'composeDaemonIntegrationModules({ db, terminalWorkspacePrune })',
      ].join('\n'),
    ),
    sourceUnit(
      WORKER,
      [
        'createTaskExecutionPersistence(client, { terminalWorkspacePrune: neverPruneTerminalWorkspaces })',
        'composeCrossContextClosure(client, permits, presence, neverPruneTerminalWorkspaces)',
      ].join('\n'),
    ),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(registrationViolations(clean)).toEqual([])
  })

  test('顶层 let、导出的登记函数、删去的名字、启动步、恢复钩子与漏交的策略都会被认出', () => {
    expect(
      registrationViolations(
        replace(
          PRUNE,
          'let terminalWorkspacePrunePolicy = null\nexport function registerTerminalWorkspacePrunePolicy(p) {}',
        ),
      ),
    ).toEqual([
      'exported mutator:terminalWorkspacePrune.ts:registerTerminalWorkspacePrunePolicy',
      'module-level let:terminalWorkspacePrune.ts:terminalWorkspacePrunePolicy',
      `removed name:${PRUNE}:registerTerminalWorkspacePrunePolicy`,
    ])
    expect(
      registrationViolations(
        replace(SCHEDULE, 'export function setMemoryDistillPolicyProvider(fn) {}'),
      ),
    ).toEqual([
      'exported mutator:schedule.ts:setMemoryDistillPolicyProvider',
      `removed name:${SCHEDULE}:setMemoryDistillPolicyProvider`,
    ])
    expect(
      registrationViolations([
        ...replace(
          PROGRAM,
          "export const DAEMON_BOOT_STEPS = [{ id: 'process-registrations' }]",
        ).filter((unit) => unit.path !== SESSION),
        sourceUnit(SESSION, 'export interface Input { readonly beforeResume?: () => void }'),
      ]),
    ).toEqual(['boot step:process-registrations', 'resume hook:beforeResume'])
    expect(
      registrationViolations(
        replace(
          APPLICATION,
          [
            'const terminalWorkspacePrune = composeWebhookTerminalWorkspacePrunePolicy({ db })',
            'composeDaemonMemoryModules({ db })',
            'composeDaemonTaskExecutionModules({ db, terminalWorkspacePrune })',
            'composeDaemonIntegrationModules({ db, terminalWorkspacePrune: composeWebhookTerminalWorkspacePrunePolicy({ db }) })',
          ].join('\n'),
        ),
      ),
    ).toEqual([
      'daemon wiring:composeDaemonIntegrationModules.terminalWorkspacePrune',
      'daemon wiring:composeDaemonMemoryModules.distillPolicy',
      'daemon wiring:prune policy composed 2x',
    ])
    expect(
      registrationViolations(
        replace(
          WORKER,
          'createTaskExecutionPersistence(client, { workspacePresence })\ncomposeCrossContextClosure(client, permits, presence)',
        ),
      ),
    ).toEqual(['worker:closure policy', 'worker:persistence policy'])
  })
})
