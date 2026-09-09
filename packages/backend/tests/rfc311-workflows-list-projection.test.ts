// RFC-311(proposal §5 C2)—— workflows 列表投影瘦身的 wire 锁:
//   GET /api/workflows 不再返回完整 `definition`(2000 工作流 × 全图 JSON 的
//   列表页负载),改返回 `nodeCount` 摘要;详情端点保持完整 definition。
// 依赖列表端点拿定义的外部 PAT 脚本需改走详情端点——正是本锁要暴露的差异。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workflows } from '../src/db/schema'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'

const TOKEN = 'a'.repeat(64)

const DEFINITION = {
  $schema_version: 4,
  inputs: [],
  nodes: [
    { id: 'n1', kind: 'agent-single', agentId: 'a1', agentName: 'a-one' },
    { id: 'n2', kind: 'agent-single', agentId: 'a1', agentName: 'a-one' },
    { id: 'n3', kind: 'agent-single', agentId: 'a1', agentName: 'a-one' },
  ],
  edges: [],
}

describeEachProvider('RFC-311 C2 — /api/workflows list projection', (harness) => {
  // Inner cleanup finishes while the outer harness still selects this database.
  describe('complete application lifetime', () => {
    let app: Hono
    let application: ProviderHttpApplication | undefined
    let tmp: string | undefined
    let previousAppHome: string | undefined
    beforeEach(async () => {
      previousAppHome = process.env.AGENT_WORKFLOW_HOME
      application = undefined
      tmp = mkdtempSync(join(tmpdir(), 'aw-rfc311-wf-'))
      const appHome = join(tmp, 'home')
      mkdirSync(appHome, { recursive: true })
      process.env.AGENT_WORKFLOW_HOME = appHome
      await harness.db
        .insert(workflows)
        .values({ id: 'wf1', name: 'wf-one', definition: JSON.stringify(DEFINITION) })
        .run()
      application = await createProviderHttpApplication(harness, {
        token: TOKEN,
        configPath: join(tmp, 'config.json'),
        opencodeVersion: '1.14.25',
        dbVersion: 17,
        appHome,
      })
      app = application.app
    })

    afterEach(async () => {
      try {
        await application?.dispose()
      } finally {
        if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
        else process.env.AGENT_WORKFLOW_HOME = previousAppHome
        if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
      }
    })

    async function get(path: string): Promise<unknown> {
      const res = await app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
      expect(res.status).toBe(200)
      return res.json()
    }

    test('list rows carry nodeCount and never the full definition', async () => {
      const items = (await get('/api/workflows')) as Array<Record<string, unknown>>
      const row = items.find((r) => r.id === 'wf1')!
      expect(row.nodeCount).toBe(3)
      expect('definition' in row).toBe(false)
    })

    test('?include=definition opts back into the full graphs (workflow editor call-ref resolver)', async () => {
      // 唯一 opt-in 消费者:编辑器的 call-workflow 引用解析器要按子工作流的
      // inputs + output 节点推导端口(shared/nodePorts.ts 的 call-workflow
      // deriver),该推导不能在服务端复制一份。
      const items = (await get('/api/workflows?include=definition')) as Array<
        Record<string, unknown>
      >
      const row = items.find((r) => r.id === 'wf1')!
      expect(row.nodeCount).toBe(3)
      expect((row.definition as { nodes: unknown[] }).nodes).toHaveLength(3)
    })

    test('the detail endpoint still returns the full definition (external scripts migrate here)', async () => {
      const item = (await get('/api/workflows/wf1')) as Record<string, unknown>
      // 读路径把定义迁到当前 $schema_version(5);节点/结构不变。
      // RFC-354: stored definitions are served at the current schema (v6).
      expect(item.definition).toEqual({ ...DEFINITION, $schema_version: 6 })
    })
  })
})
