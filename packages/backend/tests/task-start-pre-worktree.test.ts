import { rimrafDir } from './helpers/cleanup'
// RFC-020 T3: startTask now accepts a `preCreatedWorktree` so the multipart
// upload route can land user-uploaded files into the worktree BEFORE the
// task row is created. When passed, startTask must NOT shell out to git;
// when omitted, behavior is identical to the pre-RFC-020 path.

import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { materializeWorktree, startTask } from '../src/services/task'
import { ulid } from 'ulid'
import { stubCmd, writeStubOpencode } from './helpers/stub-runtime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-start-pre-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const db = createInMemoryDb(MIGRATIONS)

  execSync('git init -b main "${repoPath}"'.replace('${repoPath}', repoPath), { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  execSync(`git -C "${repoPath}" add . && git -C "${repoPath}" commit -m init`, {
    stdio: 'ignore',
  })

  const stubOpencode = writeStubOpencode(tmp, { outputs: { out: 'hello' } })

  await createAgent(db, {
    name: 'echoer',
    description: '',
    outputs: ['out'],
    outputKinds: { out: 'string' },
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })

  const wf = await createWorkflow(db, {
    name: 'trivial',
    description: '',
    definition: {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic' },
        {
          id: 'echoer',
          kind: 'agent-single',
          agentName: 'echoer',
          promptTemplate: '{{topic}}',
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'echoer', portName: 'topic' },
        },
      ],
    },
  })

  return { tmp, appHome, repoPath, db, stubOpencode, wf }
}

describe('startTask with preCreatedWorktree (RFC-020)', () => {
  test('honors caller-supplied taskId / worktreePath / branch / baseCommit', async () => {
    const { tmp, appHome, repoPath, db, stubOpencode, wf } = await setup()
    // Caller pre-creates the worktree (simulating the multipart route).
    const taskId = ulid()
    const wt = await materializeWorktree({
      repoPath,
      baseBranch: 'main',
      taskId,
      appHome,
    })
    expect(wt.earlyError).toBeNull()
    expect(existsSync(wt.worktreePath)).toBe(true)
    // Write a marker into the worktree to simulate an uploaded file landing
    // there before startTask runs.
    writeFileSync(join(wt.worktreePath, 'uploaded.txt'), 'hi')

    const task = await startTask(
      {
        workflowId: wf.id,
        name: 'fixture-task',
        repoPath,
        baseBranch: 'main',
        inputs: { topic: 'orders' },
      },
      {
        db,
        appHome,
        opencodeCmd: stubCmd(stubOpencode),
        awaitScheduler: true,
        preCreatedWorktree: {
          taskId,
          worktreePath: wt.worktreePath,
          branch: wt.branch,
          baseCommit: wt.baseCommit,
        },
      },
    )

    expect(task.id).toBe(taskId)
    expect(task.worktreePath).toBe(wt.worktreePath)
    expect(task.branch).toBe(wt.branch)
    // Marker file is still where the caller put it.
    expect(readFileSync(join(wt.worktreePath, 'uploaded.txt'), 'utf8')).toBe('hi')

    rimrafDir(tmp)
  })

  test('without preCreatedWorktree, falls back to the original git path', async () => {
    const { tmp, appHome, repoPath, db, stubOpencode, wf } = await setup()
    const task = await startTask(
      {
        workflowId: wf.id,
        name: 'fixture-task',
        repoPath,
        baseBranch: 'main',
        inputs: { topic: 'orders' },
      },
      { db, appHome, opencodeCmd: stubCmd(stubOpencode), awaitScheduler: true },
    )
    expect(task.worktreePath).not.toBe('')
    expect(existsSync(task.worktreePath)).toBe(true)
    rimrafDir(tmp)
  })

  test('materializeWorktree returns earlyError on bad repo', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-materialize-'))
    const wt = await materializeWorktree({
      repoPath: join(tmp, 'no-such-repo'),
      baseBranch: 'main',
      taskId: ulid(),
      appHome: join(tmp, 'home'),
    })
    expect(wt.earlyError).not.toBeNull()
    expect(wt.worktreePath).toBe('')
    rimrafDir(tmp)
  })
})
