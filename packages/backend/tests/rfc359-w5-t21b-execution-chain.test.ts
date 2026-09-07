// RFC-359 W5-T21b: the root launch command must actually drive a task to done
// on each real database. The runtime is a real child process using the existing
// mock-opencode fixture; task/node state and output rows are never fabricated.
// Ubuntu push-CI backend shards provide PostgreSQL through eachProvider.ts.

import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import {
  agents,
  nodeRunOutputs,
  nodeRuns,
  taskExecutionIntents,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { runGit } from '@/util/git'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'

const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

describeEachProvider(
  'RFC-359 W5-T21b real root launch -> TaskEngine -> node -> done',
  (harness) => {
    test('persists task launch, runs the agent subprocess, projects output and releases its owner', async () => {
      const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-execution-chain-'))
      const workspacePath = join(appHome, 'workspace')
      const capture = join(appHome, 'agent-invocations.jsonl')
      const overrides = {
        AGENT_WORKFLOW_HOME: appHome,
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'executed on the selected database' }),
        MOCK_OPENCODE_CAPTURE_ARGV_TO: capture,
      }
      const previous = Object.fromEntries(
        Object.keys(overrides).map((key) => [key, process.env[key]]),
      )
      Object.assign(process.env, overrides)
      let execution: Awaited<ReturnType<typeof createEachProviderTaskExecution>> | undefined
      try {
        mkdirSync(workspacePath)
        await runGit(workspacePath, ['init', '-q', '-b', 'main'])
        await runGit(workspacePath, ['config', 'user.name', 'Execution Chain Fixture'])
        await runGit(workspacePath, ['config', 'user.email', 'execution-chain@example.test'])
        writeFileSync(join(workspacePath, 'README.md'), '# execution chain fixture\n')
        await runGit(workspacePath, ['add', 'README.md'])
        await runGit(workspacePath, ['commit', '-q', '-m', 'fixture'])
        const baselineSha = (await runGit(workspacePath, ['rev-parse', 'HEAD'])).stdout.trim()
        const userId = ulid()
        const agentId = ulid()
        const workflowId = ulid()
        const now = Date.now()
        await harness.db.insert(users).values({
          id: userId,
          username: `execution-${userId}`,
          displayName: 'Execution Chain Fixture',
          gitName: 'Execution Chain Fixture',
          email: 'execution-chain@example.test',
          role: 'admin',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        await harness.db.insert(agents).values({
          id: agentId,
          name: 'execution-chain-agent',
          description: 'Real subprocess fixture',
          outputs: JSON.stringify(['summary']),
          permission: '{}',
          skills: '[]',
          frontmatterExtra: '{}',
          bodyMd: 'Return a summary of the requirement.',
          createdAt: now,
          updatedAt: now,
        })
        const definition: WorkflowDefinition = {
          $schema_version: WORKFLOW_SCHEMA_VERSION,
          inputs: [{ kind: 'text', key: 'requirement', label: 'Requirement' }],
          nodes: [
            { id: 'input', kind: 'input', inputKey: 'requirement' },
            { id: 'agent', kind: 'agent-single', agentId, agentName: 'execution-chain-agent' },
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
          name: 'Execution chain',
          definition: JSON.stringify(definition),
          createdAt: now,
          updatedAt: now,
        })
        execution = await createEachProviderTaskExecution(
          harness,
          {
            appHome,
            binaryOverride: [process.execPath, 'run', MOCK_OPENCODE],
            defaultNodeRetries: 0,
          },
          userId,
        )
        expect(await harness.db.select({ id: tasks.id }).from(tasks)).toEqual([])
        const launched = await execution.launch(
          {
            workflowId,
            name: 'Real provider task',
            inputs: { requirement: 'execute this workflow' },
          },
          { workspacePath, baselineSha },
        )
        const [task] = await harness.db.select().from(tasks).where(eq(tasks.id, launched.id))
        expect(task, task?.errorMessage ?? undefined).toMatchObject({
          status: 'done',
          errorMessage: null,
          errorSummary: null,
          ownerUserId: userId,
        })
        expect(task?.finishedAt).toBeGreaterThanOrEqual(now)
        const runs = await harness.db
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.taskId, launched.id))
        expect(runs.map((row) => [row.nodeId, row.status]).sort()).toEqual([
          ['agent', 'done'],
          ['input', 'done'],
          ['output', 'done'],
        ])
        const agentRun = runs.find((row) => row.nodeId === 'agent')!
        expect(agentRun.exitCode).toBe(0)
        const outputRun = runs.find((row) => row.nodeId === 'output')!
        const output = await harness.db
          .select({ portName: nodeRunOutputs.portName, content: nodeRunOutputs.content })
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, outputRun.id))
        expect(output).toEqual([
          { portName: 'result', content: 'executed on the selected database' },
        ])
        const invocations = readFileSync(capture, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(invocations).toHaveLength(1)
        expect(invocations[0].prompt).toContain('execute this workflow')
        expect(await execution.persistence.ownership.read(launched.id)).toMatchObject({
          state: 'released',
        })
        expect(execution.isActive(launched.id)).toBe(false)
        const intents = await harness.db
          .select({ kind: taskExecutionIntents.kind, state: taskExecutionIntents.state })
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.taskId, launched.id))
        expect(intents).toEqual([{ kind: 'launch', state: 'completed' }])
      } finally {
        execution?.shutdown()
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        rmSync(appHome, { recursive: true, force: true })
      }
    }, 60_000)
  },
)
