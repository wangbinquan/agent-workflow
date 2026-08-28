// RFC-257 — 源码文本锁（design §10）。
// ① `/webhooks` handler 不得用 `c.req.url` 推导/拼接对外 URL：反代/TLS 终止下
//    它是内网 origin（docs/audit-backlog.md:81 已登记的既有缺陷类），给 GitLab
//    的完整 URL 只能由 config.publicBaseUrl 拼装（批次二管理面实现）。
// ② dispatch 只经 startExecution 门面启动（细锁在 rfc243-executor-facade.test.ts
//    的 CALL_FACES；此处冗余断言 import 面，双保险）。
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

  test('webhookDispatch launches only via the executor facade', () => {
    const text = readFileSync(resolve(SRC, 'services/webhook/webhookDispatch.ts'), 'utf8')
    expect(text.includes("from '@/services/execution/executor'")).toBe(true)
    for (const banned of ["from '@/services/task'", "from '@/services/agentLaunch'"]) {
      expect(text.includes(banned)).toBe(false)
    }
  })

  test('webhookDispatch forwards its SecretBox and daemon-scoped execution driver', () => {
    // RFC-339 后 publication transport 已在 bootstrap 组装进同一个 driver；
    // Webhook 必须显式传入该 driver 与 SecretBox，不得在启动时另组 topology
    // 或丢失密封凭据能力。
    const text = readFileSync(resolve(SRC, 'services/webhook/webhookDispatch.ts'), 'utf8')
    expect(text.replace(/\s+/g, '')).toContain(
      'buildStartTaskDeps(deps.db,requireSchedulerDriver(deps.schedulerDriver),deps.configPath,actor.user.id,deps.secretBox,)',
    )
    expect(text).not.toContain('actor.user.id, undefined)')
  })
})
