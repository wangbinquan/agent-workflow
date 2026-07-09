import { rimrafDir } from './helpers/cleanup'
// RFC-024 T4 — locks the URL-mode branch of startTask:
//   1. Cold path: clones the URL into the cache, materializes a worktree
//      under appHome/worktrees/, persists tasks.repoUrl, does NOT touch
//      recent_repos.
//   2. Warm path: same URL on a second launch reuses the cache (single row
//      in cached_repos).
//   3. ref-not-found rewrap: a missing ref produces ValidationError
//      `repo-ref-not-found` whose details carry availableRefs[] + redacted URL.

import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { cachedRepos, recentRepos } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { startTask } from '../src/services/task'
import { stubCmd, writeStubOpencode } from './helpers/stub-runtime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-start-url-'))
  const appHome = join(tmp, 'home')
  mkdirSync(appHome, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)

  // Build a fixture bare repo we can clone via file://.
  const working = join(tmp, 'src')
  mkdirSync(working, { recursive: true })
  execSync(`git init -b main "${working}"`, { stdio: 'ignore' })
  execSync(`git -C "${working}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${working}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(working, 'README.md'), '# repo\n')
  execSync(`git -C "${working}" add . && git -C "${working}" commit -m init`, {
    stdio: 'ignore',
  })
  const bare = join(tmp, 'remote.git')
  execSync(`git clone --bare "${working}" "${bare}"`, { stdio: 'ignore' })
  const remoteUrl = `file://${bare}`

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

  return { tmp, appHome, db, stubOpencode, wf, remoteUrl }
}

describe('startTask URL mode (RFC-024)', () => {
  test('cold launch clones URL, persists repoUrl, does not write recent_repos', async () => {
    const { tmp, appHome, db, stubOpencode, wf, remoteUrl } = await setup()
    const task = await startTask(
      { workflowId: wf.id, name: 'fixture-task', repoUrl: remoteUrl, inputs: { topic: 'orders' } },
      { db, appHome, opencodeCmd: stubCmd(stubOpencode), awaitScheduler: true },
    )
    expect(task.repoUrl).toBe(remoteUrl)
    expect(task.repoPath.startsWith(join(appHome, 'repos'))).toBe(true)
    // Worktree is under appHome/worktrees and was created from the cache.
    expect(task.worktreePath.startsWith(join(appHome, 'worktrees'))).toBe(true)
    // cached_repos got exactly one row; recent_repos got nothing.
    expect(db.select().from(cachedRepos).all().length).toBe(1)
    expect(db.select().from(recentRepos).all().length).toBe(0)
    rimrafDir(tmp)
  })

  test('warm launch (second task same URL) reuses cache', async () => {
    const { tmp, appHome, db, stubOpencode, wf, remoteUrl } = await setup()
    const t1 = await startTask(
      { workflowId: wf.id, name: 'fixture-task', repoUrl: remoteUrl, inputs: { topic: 'a' } },
      { db, appHome, opencodeCmd: stubCmd(stubOpencode), awaitScheduler: true },
    )
    const t2 = await startTask(
      { workflowId: wf.id, name: 'fixture-task', repoUrl: remoteUrl, inputs: { topic: 'b' } },
      { db, appHome, opencodeCmd: stubCmd(stubOpencode), awaitScheduler: true },
    )
    expect(t1.repoPath).toBe(t2.repoPath)
    expect(db.select().from(cachedRepos).all().length).toBe(1)
    rimrafDir(tmp)
  })

  test('unknown ref → ValidationError repo-ref-not-found with available refs', async () => {
    const { tmp, appHome, db, stubOpencode, wf, remoteUrl } = await setup()
    let err: unknown
    try {
      await startTask(
        {
          workflowId: wf.id,
          name: 'fixture-task',
          repoUrl: remoteUrl,
          ref: 'this-ref-does-not-exist',
          inputs: { topic: 'orders' },
        },
        { db, appHome, opencodeCmd: stubCmd(stubOpencode), awaitScheduler: true },
      )
    } catch (e) {
      err = e
    }
    // @ts-expect-error runtime probe
    expect(err?.code).toBe('repo-ref-not-found')
    // @ts-expect-error runtime probe
    const details = err?.details as { availableRefs?: string[]; url?: string; ref?: string }
    expect(Array.isArray(details?.availableRefs)).toBe(true)
    expect((details?.availableRefs ?? []).includes('main')).toBe(true)
    expect(details?.ref).toBe('this-ref-does-not-exist')
    rimrafDir(tmp)
  })
})
