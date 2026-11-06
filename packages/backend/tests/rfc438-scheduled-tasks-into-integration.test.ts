// RFC-438 — 定时任务归入 integration，task-execution 不再依赖定时任务（RFC-294 W4 B / D 第四步）。
//
// 锁四件事：
// ① 位置：服务、节拍与路由迁入 integration，原文件不存在；运行期 heal 不在生产源码里（RFC-395 II-b 起由 epoch-2
//    转换规则取代，按 RFC-424 先例迁入用例辅助）。
// ② 方向：task-execution 的源码不再 import 任何定时任务文件；迁入的文件不碰 legacy `services/`、WS 与 git
//    （RFC-440 起两个 HTTP 传输助手迁入 platform/http，绑定也不再例外）。
// ③ 端口：`composeScheduledTaskRunner` 的 `runDue` 跑一轮，限额 `SCHEDULE_MAX_IN_FLIGHT`；节拍间隔在节奏登记表里；
//    变更通知连到 WS 广播；校验运行时补上的三条 legacy 校验与原函数同一判定。
// ④ 生产应用里定时任务管理面的路由元数据不变。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { ScheduledTaskWsMessage } from '@agent-workflow/shared'
import {
  composeScheduledTaskRunner,
  composeScheduledTaskRuntime,
} from '@/modules/integration/composition/scheduledTasks'
import { SCHEDULE_MAX_IN_FLIGHT } from '@/modules/integration/application/scheduledTaskScheduler'
import type {
  IntegrationTriggerValidationRuntime,
  ScheduledTaskOperations,
} from '@/modules/integration/application/scheduledTasks'
import { lookupRouteMeta } from '@/routes/registry'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { assertWorkflowLaunchInputs } from '@/modules/resource-catalog/domain/workflowLaunchInputs'
import { SCHEDULED_TASK_CHANNEL, scheduledTaskBroadcaster } from '@/ws/broadcaster'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'

const SRC = resolve(import.meta.dir, '..', 'src')
const INTEGRATION = join(SRC, 'modules', 'integration')

const OLD_FILES = [
  'services/scheduledTasks.ts',
  'services/scheduledTaskScheduler.ts',
  'routes/scheduledTasks.ts',
] as const
const NEW_FILES = [
  'application/scheduledTasks.ts',
  'application/scheduledTaskScheduler.ts',
  'application/ports/scheduledTaskNotifications.ts',
  'application/ports/scheduledLaunch.ts',
  'inbound/http/scheduledTaskRoutes.ts',
] as const

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : name.endsWith('.ts') ? [path] : []
  })
}

function specifiers(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
  )) {
    out.push(match[1]!)
  }
  for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push(match[1]!)
  }
  return out
}

describe('RFC-438 —— 位置与方向', () => {
  test('三个原文件不再存在，新文件就位；运行期 heal 不在生产源码里', () => {
    expect(OLD_FILES.filter((path) => existsSync(join(SRC, path)))).toEqual([])
    expect(NEW_FILES.filter((path) => !existsSync(join(INTEGRATION, path)))).toEqual([])
    const healers = walk(SRC).filter((file) =>
      readFileSync(file, 'utf8').includes('healScheduledLaunchPayloads'),
    )
    expect(healers).toEqual([])
  })

  test('task-execution 的源码不 import 任何定时任务文件', () => {
    const offenders: string[] = []
    const taskExecution = join(SRC, 'modules', 'task-execution')
    for (const file of walk(taskExecution)) {
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        // 只看定时任务文件；task-execution 对 integration 的其他既有依赖（参与者、执行端口）不在本 RFC 范围。
        if (/scheduledTask/.test(specifier)) {
          offenders.push(`${file.slice(SRC.length + 1)} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('迁入的文件（含绑定）不碰 legacy services/、WS、git 与文件系统', () => {
    const offenders: string[] = []
    for (const path of NEW_FILES) {
      for (const specifier of specifiers(readFileSync(join(INTEGRATION, path), 'utf8'))) {
        // RFC-440：删除确认与删除快照迁入 platform/http，绑定不再需要 services/ 例外。
        if (specifier.startsWith('@/services/')) {
          offenders.push(`${path} -> ${specifier}`)
        }
        if (/^(?:@\/ws\/|@\/util\/git|node:fs|node:child_process)/.test(specifier)) {
          offenders.push(`${path} -> ${specifier}`)
        }
        const other = /^@\/modules\/([a-z-]+)\/(.+)$/.exec(specifier)
        if (other && other[1] !== 'integration' && !other[2]!.startsWith('public/')) {
          offenders.push(`${path} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('节拍间隔在节奏登记表里，task-execution 的后台从那里取', () => {
    expect(DAEMON_CADENCE.scheduledTasks).toBe(30_000)
    const binding = readFileSync(
      join(SRC, 'modules', 'task-execution', 'composition', 'providerBackground.ts'),
      'utf8',
    )
    expect(binding).toContain('scheduleTickMs: () => DAEMON_CADENCE.scheduledTasks,')
    expect(binding).toContain('scheduled: dependencies.scheduled,')
  })
})

const VALIDATION: IntegrationTriggerValidationRuntime = {
  assertWorkflowLaunchable: async () => {},
  assertAgentIntegrity: async () => {},
}

function runtimeWith(pollAndClaim: (input: { readonly limit: number }) => Promise<never[]>) {
  return composeScheduledTaskRuntime({
    persistence: { pollAndClaim } as unknown as ScheduledTaskOperations['persistence'],
    integrationTriggerResources: {} as never,
    validation: VALIDATION,
    resourceAclChanged: () => {},
  })
}

describe('RFC-438 —— 端口', () => {
  test('runDue 跑一轮：认领限额是 SCHEDULE_MAX_IN_FLIGHT，没有到期行就不启动', async () => {
    const limits: number[] = []
    const runtime = runtimeWith(async (input) => {
      limits.push(input.limit)
      return []
    })
    let launches = 0
    const runner = composeScheduledTaskRunner({
      operations: runtime.operations,
      identityAccess: {} as never,
      buildLaunch: () => async () => {
        launches++
        return { id: 'never' }
      },
    })
    await runner.runDue({ maxFailures: 10, defaultRuntime: undefined })
    expect(limits).toEqual([SCHEDULE_MAX_IN_FLIGHT])
    expect(SCHEDULE_MAX_IN_FLIGHT).toBe(32)
    expect(launches).toBe(0)
  })

  test('变更通知连到 WS 广播的定时任务频道，消息原样转发', () => {
    const runtime = runtimeWith(async () => [])
    const received: ScheduledTaskWsMessage[] = []
    const unsubscribe = scheduledTaskBroadcaster.subscribe(SCHEDULED_TASK_CHANNEL, (message) => {
      received.push(message)
    })
    try {
      const change: ScheduledTaskWsMessage = {
        type: 'scheduled.updated',
        id: 'sched-1',
        ownerUserId: 'owner-1',
      }
      runtime.operations.notifications.notify(change)
      expect(received).toEqual([change])
    } finally {
      unsubscribe()
    }
  })

  test('校验运行时：注入的两条照转，补上的三条与原 legacy 函数同一判定', async () => {
    const calls: string[] = []
    const runtime = composeScheduledTaskRuntime({
      persistence: {} as never,
      integrationTriggerResources: {} as never,
      validation: {
        assertWorkflowLaunchable: async () => {
          calls.push('launchable')
        },
        assertAgentIntegrity: async (ids) => {
          calls.push(`agents:${ids.join(',')}`)
        },
      },
      resourceAclChanged: () => {},
    })
    const validation = runtime.operations.validation
    await validation.assertWorkflowLaunchable({} as never)
    await validation.assertAgentIntegrity(['a1'])
    expect(calls).toEqual(['launchable', 'agents:a1'])

    const defs = [{ name: 'topic', required: true }] as never
    const legacy = (() => {
      try {
        assertWorkflowLaunchInputs(defs, {})
        return null
      } catch (error) {
        return (error as { code?: string }).code ?? String(error)
      }
    })()
    const viaPort = (() => {
      try {
        validation.assertWorkflowLaunchInputs(defs, {})
        return null
      } catch (error) {
        return (error as { code?: string }).code ?? String(error)
      }
    })()
    expect(viaPort).toBe(legacy)

    // agent 启动形状：未声明输入的 agent 收到 inputs 时拒绝（与原服务相同的判定，仍为异步惰性加载）
    await expect(
      validation.validateAgentLaunchShape(undefined, { inputs: { x: 'y' } }, { multipart: false }),
    ).rejects.toBeDefined()
    await expect(
      validation.validateAgentLaunchShape(undefined, { description: 'go' }, { multipart: false }),
    ).resolves.toBeUndefined()
  })
})

const DAEMON_TOKEN = 'd'.repeat(64)

describeEachProviderHttpApplication(
  'RFC-438 —— 生产应用里的定时任务管理面',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc438-scheduled-',
  },
  (scope: ProviderHttpApplicationScope) => {
    test('路由元数据不变；未登录调用 401', async () => {
      const app = (await scope.open()).app
      expect(lookupRouteMeta('GET', '/api/scheduled-tasks')).toMatchObject({
        permissions: ['scheduled-tasks:read'],
        tokenAccess: 'allow',
      })
      expect(lookupRouteMeta('POST', '/api/scheduled-tasks/:id/run-now')).toMatchObject({
        permissions: ['scheduled-tasks:execute', 'tasks:execute'],
        tokenAccess: 'allow',
        executionGroup: 'task',
      })
      expect(lookupRouteMeta('PUT', '/api/scheduled-tasks/:id/acl')).toBeDefined()
      const anonymous = await app.request('/api/scheduled-tasks')
      expect(anonymous.status).toBe(401)
    })
  },
)
