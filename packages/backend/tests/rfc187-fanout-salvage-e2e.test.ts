// RFC-187 PR-2 §4-2 — 真子进程 e2e：两成员各在自己 iso 写同一文件（冲突）+ 各自
// 专属文件（干净），锁「逐路径救回」的用户可见价值：
//   - 无论合并顺序，两个成员的专属文件都必须落进 canonical——修复前，输家
//     repo 的整个 delta 被扣留，其专属文件随冲突一起丢失（audit §4-2
//     whole-repo 粒度丢输者）；
//   - 冲突文件保持赢家内容（冲突路径继续走 merge agent / conflict-human 线，
//     本用例的 merge agent 无剧本 → 失败 → assignment failed 浮出，正是
//     确定性的「未解决」分支）；
//   - 失败的 assignment 的房间 note 带上「N clean path(s) already landed」。
//
// 复用 rfc187-workgroup-e2e.test.ts 的 scenario-opencode harness（RFC-186 首绿
// 后的 stub 缝封锁模式）；writeFiles 步骤 mixin 为本 RFC 新增。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workgroupAssignments, workgroupMessages } from '../src/db/schema'
import { buildActor } from '../src/auth/actor'
import { createAgent } from '../src/services/agent'
import { createWorkgroup } from '../src/services/workgroups'
import { startWorkgroupTask } from '../src/services/workgroup/launch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_STUB = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

function harness() {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-wg187-salvage-'))
  const appHome = join(tmp, 'home')
  const stateDir = join(tmp, 'state')
  const planFile = join(tmp, 'plan.json')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    stateDir,
    planFile,
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true })
      delete process.env.SCENARIO_PLAN_FILE
      delete process.env.SCENARIO_STATE_DIR
    },
  }
}

async function seedAgent(db: DbClient, name: string): Promise<string> {
  const agent = await createAgent(db, {
    name,
    description: name,
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: `you are ${name}`,
  })
  return agent.id
}

const actor = buildActor({
  user: { id: 'u-e2e', username: 'e2e', displayName: 'e2e', role: 'admin', status: 'active' },
  source: 'daemon',
})

describe('RFC-187 §4-2 — fan-out 同文件冲突：逐路径救回（真子进程 e2e）', () => {
  test('输家 repo 的干净文件照样落地；冲突文件保持赢家内容；房间 note 带救回统计', async () => {
    const h = harness()
    try {
      const leadId = await seedAgent(h.db, 'wg-lead')
      const worker1Id = await seedAgent(h.db, 'wg-w1')
      const worker2Id = await seedAgent(h.db, 'wg-w2')
      await createWorkgroup(h.db, {
        name: 'wg187-salvage',
        description: '',
        instructions: '',
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        autonomous: true,
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 8,
        completionGate: false,
        members: [
          { memberType: 'agent', agentId: leadId, displayName: 'lead', roleDesc: '协调' },
          { memberType: 'agent', agentId: worker1Id, displayName: 'w1', roleDesc: '产出' },
          { memberType: 'agent', agentId: worker2Id, displayName: 'w2', roleDesc: '产出' },
        ],
      } as Parameters<typeof createWorkgroup>[1])

      // 一轮双派单（不同成员——无需 fanOut 开关）→ 两成员并发各写 same.txt（冲突）
      // + 专属 extraN.txt（干净）。merge agent 无剧本 → 冲突不可解 → 输家
      // assignment failed；leader 第二步收 done。
      writeFileSync(
        h.planFile,
        JSON.stringify({
          'wg-lead': [
            {
              output: {
                wg_assignments: JSON.stringify([
                  { member: 'w1', title: 'write-1', brief: 'write same.txt + extra1.txt' },
                  { member: 'w2', title: 'write-2', brief: 'write same.txt + extra2.txt' },
                ]),
                wg_decision: JSON.stringify({ action: 'continue' }),
              },
            },
            { output: { wg_decision: JSON.stringify({ action: 'done', summary: 'wrap' }) } },
          ],
          'wg-w1': [
            {
              writeFiles: { 'same.txt': 'from-w1\n', 'extra1.txt': 'extra-1\n' },
              output: { wg_result: JSON.stringify({ summary: 'w1 done' }) },
            },
          ],
          'wg-w2': [
            {
              writeFiles: { 'same.txt': 'from-w2\n', 'extra2.txt': 'extra-2\n' },
              output: { wg_result: JSON.stringify({ summary: 'w2 done' }) },
            },
          ],
        }),
      )
      process.env.SCENARIO_PLAN_FILE = h.planFile
      process.env.SCENARIO_STATE_DIR = h.stateDir

      const task = await startWorkgroupTask(
        h.db,
        actor,
        'wg187-salvage',
        { name: 'e2e-salvage', goal: '双写冲突', scratch: true },
        {
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', SCENARIO_STUB],
          awaitScheduler: true,
        },
      )

      const final = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(final).toBeDefined()
      // 任务收敛（leader 消费失败/成功结果后 done）——不因冲突整体 failed。
      expect(final!.status).toBe('done')

      const worktree = final!.worktreePath
      // §4-2 核心锁：两个成员的专属（干净）文件都在 canonical——输家的那份
      // 修复前随整仓扣留一起丢失。
      expect(existsSync(join(worktree, 'extra1.txt'))).toBe(true)
      expect(existsSync(join(worktree, 'extra2.txt'))).toBe(true)
      // 冲突文件保持赢家内容（两者之一，取决于合并顺序），绝不含冲突标记。
      const same = readFileSync(join(worktree, 'same.txt'), 'utf8')
      expect(['from-w1\n', 'from-w2\n']).toContain(same)

      // 一胜一败：输家 assignment failed，且其房间 note 带救回统计。
      const cards = await h.db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.taskId, task.id))
      expect(cards.filter((c) => c.status === 'done')).toHaveLength(1)
      expect(cards.filter((c) => c.status === 'failed')).toHaveLength(1)
      const notes = await h.db
        .select()
        .from(workgroupMessages)
        .where(eq(workgroupMessages.taskId, task.id))
      const failNote = notes.find(
        (m) => m.authorKind === 'system' && m.bodyMd.includes('merge-back-conflict'),
      )
      expect(failNote).toBeDefined()
      expect(failNote!.bodyMd).toContain('clean path(s) already landed')
    } finally {
      h.cleanup()
    }
  }, 120_000)
})
