// RFC-452 — 任务恢复与诊断家族归 task-execution（RFC-294 W4 B / D 第十七步）。
//
// 锁四件事：
// ① 17 个 `services/` 文件已删除，`src/` 下零引用（census AST，别名与相对路径都认，带负对照）；`tasks` 路由不再 import
//    诊断 / 恢复的 7 个模块。
// ② `composeTaskDiagnostics` 只接必填参数：缺依赖在类型层不可表达（RFC-359 W1-T1），装配不做运行期「未装配」检查。
// ③ 诊断合同沿用原路由的编排：恢复审计与熔断态并发读取；诊断把实时扫描的通知转给接收者，再补上扫描没产出的未关闭行
//    （`resolvedAt: null`，实时行在前）；告警详情解析与坏 JSON 回落沿用原语义。
// ④ shared 的三个响应 schema 认得出合同的真实输出，也拒绝未知规则。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  TaskAlertsResponseSchema,
  TaskDiagnoseResponseSchema,
  TaskRecoveryEventsResponseSchema,
} from '@agent-workflow/shared'
import { composeTaskDiagnostics } from '@/modules/task-execution/composition'
import type {
  TaskExecutionReadModels,
  TaskLifecycleAlertNotices,
  TaskRuntimeInventoryContent,
} from '@/modules/task-execution/public/types'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { importEdges, sourceUnit } from './architecture/census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const SRC = resolve(import.meta.dir, '..', 'src')
const MOVED = [
  'services/recovery',
  'services/recoveryBreaker',
  'services/taskAlerts',
  'services/lifecycleInvariants',
  'services/autoKill',
  'services/autoRepair',
  'services/autoResume',
  'services/orphanReconcile',
  'services/orphans',
  'services/shutdown',
  'services/taskWorkspacePhase',
  'services/runLiveness',
  'services/stuckTaskDetector',
  'services/runtimeSessionLease',
  'services/sessionView',
  'services/execution/inventoryRead',
  'services/execution/startupVerificationRead',
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/** 说明符解析到 `src/` 下的路径（不带扩展名）；包名等非本地说明符返回 null。 */
function targetOf(from: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('@/')) target = specifier.slice(2)
  else if (specifier.startsWith('.')) {
    target = relative(SRC, resolve(from, '..', specifier))
      .split('\\')
      .join('/')
  } else return null
  return target.replace(/\.[cm]?tsx?$/, '')
}

function importsMatching(files: readonly string[], matches: (target: string) => boolean): string[] {
  return files.flatMap((path) => {
    const rel = relative(REPO_ROOT, path).split('\\').join('/')
    const unit = sourceUnit(rel, readFileSync(path, 'utf8'))
    return [...new Set(importEdges(unit).map((edge) => edge.specifier))]
      .filter((specifier) => matches(targetOf(path, specifier) ?? ''))
      .map((specifier) => `${relative(SRC, path)} -> ${specifier}`)
  })
}

const isMovedFile = (target: string) => MOVED.includes(target)

describe('RFC-452 —— 引用', () => {
  test('17 个旧文件已删除，src/ 下零引用', () => {
    for (const file of MOVED) expect(existsSync(join(SRC, `${file}.ts`)), file).toBe(false)
    expect(importsMatching(walk(SRC), isMovedFile)).toEqual([])
  }, 60_000)

  test('tasks 路由不再 import 诊断 / 恢复的 7 个模块', () => {
    expect(importsMatching([join(SRC, 'routes/tasks.ts')], isMovedFile)).toEqual([])
  })

  test('负对照：判据认得出别名与相对路径，也不误伤同前缀的文件', () => {
    const probe = join(SRC, 'routes', 'probe.ts')
    expect(isMovedFile(targetOf(probe, '@/services/recovery') ?? '')).toBe(true)
    expect(isMovedFile(targetOf(probe, '../services/execution/inventoryRead.ts') ?? '')).toBe(true)
    expect(isMovedFile(targetOf(probe, '@/services/recoveryBreakerExtra') ?? '')).toBe(false)
    expect(isMovedFile(targetOf(probe, '@/services/execution/inventoryReadModel') ?? '')).toBe(
      false,
    )
  })
})

interface Fixture {
  readonly calls: string[]
  readonly recovery: TaskRecoveryOperations
}

const INVARIANT_ROW = {
  id: 'alert-r1',
  taskId: 't1',
  rule: 'R1' as const,
  severity: 'warning' as const,
  detail: { nodeRunId: 'nr1' },
  detectedAt: 10,
  resolvedAt: null,
}

function fixture(input: { readonly releaseReads?: Promise<void> } = {}): Fixture {
  const calls: string[] = []
  const recovery = {
    async listEventsForTask(taskId: string, limit: number) {
      calls.push(`events:${taskId}:${limit}`)
      await input.releaseReads
      return [
        {
          id: 'e1',
          taskId,
          nodeRunId: null,
          actor: 'system',
          kind: 'boot-reap',
          reason: null,
          beforeJson: null,
          afterJson: '{"status":"interrupted"}',
          createdAt: 5,
        },
      ]
    },
    async isAutoRecoverySuspended(taskId: string) {
      calls.push(`suspended:${taskId}`)
      await input.releaseReads
      return true
    },
    async clearAutoRecoverySuspension(taskId: string) {
      calls.push(`clear:${taskId}`)
    },
    async listOpenLifecycleAlerts(taskId?: string) {
      calls.push(`open:${taskId ?? '*'}`)
      return [
        { ...INVARIANT_ROW, detail: JSON.stringify(INVARIANT_ROW.detail) },
        {
          id: 'alert-s1',
          taskId: 't1',
          rule: 'S1',
          severity: 'error',
          detail: 'not json',
          detectedAt: 20,
        },
      ]
    },
    async loadLifecycleInvariantSnapshots() {
      calls.push('snapshots')
      return [
        {
          taskId: 't1',
          taskStatus: 'running',
          workflowSnapshot: '{"nodes":[],"edges":[]}',
          hasUndispatchedDesignerQuestions: false,
          documentVersions: [],
          clarifyRounds: [],
          nodeRuns: [],
        },
      ]
    },
    async reconcileStuckAlerts() {
      calls.push('reconcile')
      return {
        newAlerts: 1,
        promotedAlerts: 0,
        resolvedAlerts: 1,
        openAlerts: [INVARIANT_ROW],
        transitions: [{ row: INVARIANT_ROW, kind: 'new' as const }],
        resolvedTaskIds: ['t1'],
      }
    },
  } as unknown as TaskRecoveryOperations
  return { calls, recovery }
}

function diagnostics(recovery: TaskRecoveryOperations) {
  return composeTaskDiagnostics({
    recovery,
    readModels: {} as TaskExecutionReadModels,
    nodeRunPrompts: {} as never,
    runtimeInventoryContent: {} as TaskRuntimeInventoryContent,
  })
}

describe('RFC-452 —— 诊断合同', () => {
  test('缺依赖在类型层不可表达（RFC-359 W1-T1：装配只接必填参数，不做运行期「未装配」检查）', () => {
    const complete: Parameters<typeof composeTaskDiagnostics>[0] = {
      recovery: fixture().recovery,
      readModels: {} as TaskExecutionReadModels,
      nodeRunPrompts: {} as never,
      runtimeInventoryContent: {} as TaskRuntimeInventoryContent,
    }
    const { recovery: _recovery, ...withoutRecovery } = complete
    const { runtimeInventoryContent: _content, ...withoutContent } = complete
    // @ts-expect-error the recovery operations are required
    const missingRecovery: Parameters<typeof composeTaskDiagnostics>[0] = withoutRecovery
    // @ts-expect-error the deployment's inventory content is required
    const missingContent: Parameters<typeof composeTaskDiagnostics>[0] = withoutContent
    expect([missingRecovery, missingContent].map((input) => Object.keys(input).sort())).toEqual([
      ['nodeRunPrompts', 'readModels', 'runtimeInventoryContent'],
      ['nodeRunPrompts', 'readModels', 'recovery'],
    ])
    expect(Object.isFrozen(composeTaskDiagnostics(complete))).toBe(true)
  })

  test('恢复审计与熔断态并发读取（审计取最近 50 条）', async () => {
    let release!: () => void
    const releaseReads = new Promise<void>((resolveReads) => {
      release = resolveReads
    })
    const { calls, recovery } = fixture({ releaseReads })
    const pending = diagnostics(recovery).recoveryHistory('t1')
    await Promise.resolve()
    expect(calls).toEqual(['events:t1:50', 'suspended:t1'])
    release()
    const history = await pending
    expect(history.suspended).toBe(true)
    expect(history.events.map((event) => event.id)).toEqual(['e1'])
    expect(TaskRecoveryEventsResponseSchema.parse(history)).toEqual(history)
  })

  test('清除熔断原样转给恢复操作', async () => {
    const { calls, recovery } = fixture()
    await diagnostics(recovery).clearRecoverySuspension('t1')
    expect(calls).toEqual(['clear:t1'])
  })

  test('告警：详情解析成对象，坏 JSON 回落为 { raw }', async () => {
    const { recovery } = fixture()
    const alerts = await diagnostics(recovery).openAlerts('t1')
    expect(alerts.map((alert) => [alert.id, alert.detail])).toEqual([
      ['alert-r1', { nodeRunId: 'nr1' }],
      ['alert-s1', { raw: 'not json' }],
    ])
    expect(TaskAlertsResponseSchema.parse({ alerts })).toEqual({ alerts })
  })

  test('诊断：实时扫描的通知转给接收者，再补上扫描没产出的未关闭行', async () => {
    const { calls, recovery } = fixture()
    const notices: string[] = []
    const sink: TaskLifecycleAlertNotices = {
      alert: (notice, transition) =>
        notices.push(`alert:${notice.taskId}:${notice.rule}:${notice.severity}:${transition}`),
      resolved: (taskId) => notices.push(`resolved:${taskId}`),
    }
    const result = await diagnostics(recovery).diagnose('t1', sink)
    expect(calls).toEqual(['snapshots', 'reconcile', 'open:t1'])
    expect(notices).toEqual(['alert:t1:R1:warning:new', 'resolved:t1'])
    expect(result.scanned).toBe(1)
    expect([result.newAlerts, result.promotedAlerts, result.resolvedAlerts]).toEqual([1, 0, 1])
    expect(result.openAlerts).toEqual([
      INVARIANT_ROW,
      {
        id: 'alert-s1',
        taskId: 't1',
        rule: 'S1',
        severity: 'error',
        detail: { raw: 'not json' },
        detectedAt: 20,
        resolvedAt: null,
      },
    ])
    expect(TaskDiagnoseResponseSchema.parse(result)).toEqual(result)
  })

  test('shared schema 拒绝未知规则（负对照）', () => {
    expect(
      TaskAlertsResponseSchema.safeParse({
        alerts: [{ ...INVARIANT_ROW, rule: 'Z9', resolvedAt: undefined }],
      }).success,
    ).toBe(false)
  })
})
