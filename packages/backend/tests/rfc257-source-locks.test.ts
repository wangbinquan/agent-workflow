// RFC-257 — 源码文本锁（design §10）。
// ① `/webhooks` handler 不得用 `c.req.url` 推导/拼接对外 URL：反代/TLS 终止下
//    它是内网 origin（docs/audit-backlog.md:81 已登记的既有缺陷类），给 GitLab
//    的完整 URL 只能由 config.publicBaseUrl 拼装（批次二管理面实现）。
// ② dispatch 只经 injected TaskExecution participant 启动（细锁在
//    rfc243-executor-facade.test.ts 的 CALL_FACES；此处冗余断言 import 面，双保险）。
// ③ 2026-08-10 回归：dispatcher 的仓库解析阶段能用 secretBox 命中密封
//    cache，但真启动曾向 buildStartTaskDeps 传 undefined，导致 materializeSpace
//    再次解封同一行时恒报 cached-repo-credential-unavailable。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')

describe('RFC-257 · source locks', () => {
  test('routes/webhooks.ts never touches c.req.url', () => {
    const text = readFileSync(resolve(SRC, 'routes/webhooks.ts'), 'utf8')
    expect(text.includes('c.req.url')).toBe(false)
  })

  test('webhookDispatch launches only via the injected TaskExecution participant', () => {
    const text = readFileSync(
      resolve(SRC, 'modules/integration/infrastructure/sqliteWebhookDispatchRuntime.ts'),
      'utf8',
    )
    expect(text).toContain('createWebhookExecutionRuntime')
    expect(text).toContain('taskExecutions: input.taskExecutions')
    for (const banned of ["from '@/services/task'", "from '@/services/agentLaunch'"]) {
      expect(text.includes(banned)).toBe(false)
    }
    expect(text).not.toContain("from '@/services/execution/executor'")
  })

  test('webhookDispatch forwards selected-provider execution and Digital Employee ports', () => {
    // RFC-349: repository credentials and publication topology are owned by
    // the injected TaskExecution participant. Integration must not rebuild a
    // SQLite StartTaskDeps graph or receive SecretBox/DbClient directly.
    const text = readFileSync(
      resolve(SRC, 'modules/integration/infrastructure/sqliteWebhookDispatchRuntime.ts'),
      'utf8',
    )
    expect(text).toContain('taskExecutions: input.taskExecutions')
    expect(text).toContain('digitalEmployeeWorkStart: input.digitalEmployeeWorkStart')
    expect(text).not.toContain('buildStartTaskDeps(')
    expect(text).not.toMatch(/\b(?:DbClient|SecretBox)\b/)
  })
})
