// RFC-359 AC-1（plan §5hh）—— **启动内核在两个引擎上都要能真启动一次**。
//
// 为什么这条用例存在（plan §5hg 的表）：全仓此前跑过的组合只有两种——
//   · 「内核 + PostgreSQL 库」：PG daemon 生产路径、`tasks.test.ts` 的 PG lane；
//   · 「`startTask` + SQLite 库」：SQLite daemon 生产路径、`tasks.test.ts` 的 SQLite lane。
// **「内核 + SQLite 库」没有任何地方在跑。**
//
// 而 AC-1 要合掉的那三对（action 执行环境 / agent 装配 / script 装配）合并时取的正是内核那半
// ——合并之后**默认部署（SQLite）的数字员工启动路就会走它**。把一条今天零覆盖的机制推上生产，
// 出问题的形态会是「动作卡住不失败」，要等有人在真机上跑才发现。所以先有这条用例，再合并。
//
// 判据只钉**启动事务本身**在这个引擎上成立：开事务 → 插 task 行 → 借用工作区租约 commit →
// 返回 id，并且驱动请求确实被提交给了协调器。
// 「任务被真正驱动到 done」由 `rfc359-w5-t21b-execution-chain` 在两个引擎上覆盖，这里不重复。

import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { agents, tasks, users, workflows } from '@/db/schema'
import { runGit } from '@/util/git'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'

describeEachProvider('RFC-359 —— 启动内核在两个引擎上各真启动一次', (harness) => {
  test('kernel.launch 落 task 行、返回 id 与库内一致、并把驱动请求交给协调器', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-kernel-launch-'))
    const workspacePath = join(appHome, 'workspace')
    const previousHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = appHome
    try {
      mkdirSync(workspacePath)
      await runGit(workspacePath, ['init', '-q', '-b', 'main'])
      await runGit(workspacePath, ['config', 'user.name', 'Kernel Launch Fixture'])
      await runGit(workspacePath, ['config', 'user.email', 'kernel-launch@example.test'])
      writeFileSync(join(workspacePath, 'README.md'), '# kernel launch fixture\n')
      await runGit(workspacePath, ['add', 'README.md'])
      await runGit(workspacePath, ['commit', '-q', '-m', 'fixture'])
      const baselineSha = (await runGit(workspacePath, ['rev-parse', 'HEAD'])).stdout.trim()

      const userId = ulid()
      const agentId = ulid()
      const workflowId = ulid()
      const now = Date.now()
      await harness.db.insert(users).values({
        id: userId,
        username: `kernel-${userId}`,
        displayName: 'Kernel Launch Fixture',
        gitName: 'Kernel Launch Fixture',
        email: 'kernel-launch@example.test',
        role: 'admin',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      await harness.db.insert(agents).values({
        id: agentId,
        name: 'kernel-launch-agent',
        description: 'Kernel launch fixture',
        outputs: JSON.stringify(['summary']),
        permission: '{}',
        skills: '[]',
        frontmatterExtra: '{}',
        bodyMd: 'Return a summary.',
        createdAt: now,
        updatedAt: now,
      })
      const definition: WorkflowDefinition = {
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [{ kind: 'text', key: 'requirement', label: 'Requirement' }],
        nodes: [
          { id: 'input', kind: 'input', inputKey: 'requirement' },
          { id: 'agent', kind: 'agent-single', agentId, agentName: 'kernel-launch-agent' },
          {
            id: 'output',
            kind: 'output',
            ports: [{ name: 'result', bind: { nodeId: 'agent', portName: 'summary' } }],
          },
        ],
        edges: [
          {
            id: 'requirement-to-agent',
            source: { nodeId: 'input', portName: 'requirement' },
            target: { nodeId: 'agent', portName: 'requirement' },
          },
          {
            id: 'summary-to-output',
            source: { nodeId: 'agent', portName: 'summary' },
            target: { nodeId: 'output', portName: 'result' },
          },
        ],
      }
      await harness.db.insert(workflows).values({
        id: workflowId,
        name: 'Kernel launch',
        definition: JSON.stringify(definition),
        createdAt: now,
        updatedAt: now,
      })

      const execution = await createEachProviderTaskExecution(
        harness,
        { appHome, defaultNodeRetries: 0 },
        userId,
      )
      expect(await harness.db.select({ id: tasks.id }).from(tasks)).toEqual([])

      const launched = await execution.launchViaKernel(
        {
          workflowId,
          name: 'Kernel launch on the selected engine',
          inputs: { requirement: 'launch through the kernel' },
        },
        { workspacePath, baselineSha },
      )

      const [row] = await harness.db.select().from(tasks).where(eq(tasks.id, launched.taskId))
      expect(
        row,
        '启动内核在这个引擎上没有把任务行写进去——「内核 + 本引擎」这个组合不成立，' +
          '合并 action 执行装配面（取内核那半）就会把生产打坏',
      ).toBeDefined()
      expect(row).toMatchObject({ id: launched.taskId, ownerUserId: userId })
      expect(
        launched.submitted,
        '启动提交后应当把驱动请求交给协调器；没有说明提交后的那一段在这个引擎上断了',
      ).toEqual([launched.taskId])
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = previousHome
      rmSync(appHome, { recursive: true, force: true })
    }
  }, 120_000)
})
