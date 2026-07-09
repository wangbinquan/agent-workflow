import { rimrafDir } from './helpers/cleanup'
// RFC-145 T3 — 写侧正向声明：runner 在 stamp 点落 failure_code。
//
// 为什么这条测试存在：failure_code 的产出从「scheduler 反解 errorMessage 前缀」
// 移到「runner 产出点自述」（design §2.2）。本文件用真实 runTask 链路锁住主 stamp
// 形态：agent 输出无 <workflow-output> 信封 → 失败行带 failureCode='envelope-missing'
// 且 errorMessage 文案与 RFC-145 之前逐字节相同（机器地位取消、人读价值保留）。
// supersede 双列的写侧断言在 reviews-iterate-mints-new-run（T4 锁更新时并入）。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  mockPath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc145-write-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true }) // 非 git → passthrough iso，聚焦 runner
  const mockPath = join(appHome, 'mock-opencode.ts')
  // agent 只输出普通文本、无任何信封 → runner 判 envelope-missing。
  writeFileSync(
    mockPath,
    `process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: 'plain text, no envelope' } }) + '\\n',
)
process.exit(0)
`,
  )
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    mockPath,
    cleanup: () => rimrafDir(appHome),
  }
}

describe('RFC-145 写侧 — runner 正向声明 failure_code', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('无信封输出 → 行落 failureCode=envelope-missing，errorMessage 文案零变更', async () => {
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'a',
      description: '',
      outputs: JSON.stringify(['summary']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'A', kind: 'agent-single', agentName: 'a' }],
      edges: [],
    }
    const workflowId = ulid()
    const taskId = ulid()
    await h.db.insert(workflows).values({
      id: workflowId,
      name: 'wf',
      definition: JSON.stringify(def),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await h.db.insert(tasks).values({
      id: taskId,
      name: 'fixture',
      workflowId,
      workflowSnapshot: JSON.stringify(def),
      repoPath: h.worktreePath,
      worktreePath: h.worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await runTask({ taskId, db: h.db, appHome: h.appHome, opencodeCmd: ['bun', 'run', h.mockPath] })

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(t.status).toBe('failed')
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const failed = rows.filter((r) => r.nodeId === 'A' && r.status === 'failed')
    expect(failed.length).toBeGreaterThan(0)
    for (const r of failed) {
      expect(r.failureCode).toBe('envelope-missing')
      // 机器地位取消但文案零变更（意图+载体弱锁全仓保持绿的依据）。
      expect(r.errorMessage).toBe('no <workflow-output> envelope found in stdout')
    }
  }, 30000)
})
