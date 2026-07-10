import { rimrafDir } from './helpers/cleanup'
// RFC-068 — startTask integration: opt-in path fetch + URL-mode FF.
// Two end-to-end scenarios:
//   1. Path mode: fetchBeforeLaunch=true triggers `git fetch` (refreshes
//      origin/<branch>) without touching the user's local branch or working
//      tree. Subsequent baseBranch resolves at the user-supplied ref.
//   2. URL mode: when the cached mirror exists and origin/main advanced
//      between launches, the new task's baseCommit equals the new origin/main
//      sha — proves the FF actually ran in the launch path.

import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { startTask } from '../src/services/task'
import { runGit } from '../src/util/git'
import { stubCmd, writeStubOpencode } from './helpers/stub-runtime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function setupPathMode() {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-068-task-path-'))
  const appHome = join(tmp, 'home')
  mkdirSync(appHome, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)

  // Build seed + bare remote + user-supplied clone.
  const seed = join(tmp, 'seed')
  mkdirSync(seed)
  execSync(`git init -b main "${seed}"`, { stdio: 'ignore' })
  execSync(`git -C "${seed}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${seed}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(seed, 'README.md'), '# seed\n')
  execSync(`git -C "${seed}" add . && git -C "${seed}" commit -m first`, { stdio: 'ignore' })
  const bareRemote = join(tmp, 'remote.git')
  execSync(`git clone --bare "${seed}" "${bareRemote}"`, { stdio: 'ignore' })

  const repoPath = join(tmp, 'user-repo')
  execSync(`git clone "${bareRemote}" "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.name t`, { stdio: 'ignore' })

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

  const workflow = await createWorkflow(db, {
    name: 'wf-068-path',
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

  const stubOpencode = writeStubOpencode(tmp, { outputs: { out: 'hello' } })
  return { tmp, db, appHome, workflow, repoPath, bareRemote, stubOpencode }
}

async function advanceRemote(bareRemote: string, root: string, message: string): Promise<string> {
  const tmpWork = join(root, 'advance-' + Date.now())
  execSync(`git clone "${bareRemote}" "${tmpWork}"`, { stdio: 'ignore' })
  execSync(`git -C "${tmpWork}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${tmpWork}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(tmpWork, 'NEW.md'), `# ${message}\n`)
  execSync(
    `git -C "${tmpWork}" add . && git -C "${tmpWork}" commit -m "${message}" && git -C "${tmpWork}" push origin main`,
    { stdio: 'ignore' },
  )
  const r = await runGit(tmpWork, ['rev-parse', 'HEAD'])
  rimrafDir(tmpWork)
  return r.stdout.trim()
}

describe('startTask RFC-068 path-mode opt-in fetch', () => {
  test('BP-01 startTask + fetchBeforeLaunch=true refreshes origin/main without touching local main', async () => {
    const h = await setupPathMode()
    try {
      const localBefore = (await runGit(h.repoPath, ['rev-parse', 'main'])).stdout.trim()
      // Add user wip file so we can later assert the working tree wasn't disturbed.
      writeFileSync(join(h.repoPath, 'WIP.md'), 'wip\n')
      // Advance remote.
      const newSha = await advanceRemote(h.bareRemote, h.tmp, 'second')
      expect(newSha).not.toBe(localBefore)

      const task = await startTask(
        {
          workflowId: h.workflow.id,
          name: 'task-068-fetch',
          repoPath: h.repoPath,
          baseBranch: 'main',
          fetchBeforeLaunch: true,
          inputs: { topic: 't' },
        },
        {
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: stubCmd(h.stubOpencode),
          awaitScheduler: true,
        },
      )
      expect(task.status === 'done' || task.status === 'running').toBe(true)

      // origin/main advanced.
      const originAfter = (await runGit(h.repoPath, ['rev-parse', 'origin/main'])).stdout.trim()
      expect(originAfter).toBe(newSha)

      // Local main on user repo UNCHANGED (RFC-068 invariant).
      const localAfter = (await runGit(h.repoPath, ['rev-parse', 'main'])).stdout.trim()
      expect(localAfter).toBe(localBefore)

      // User's WIP file survives.
      expect(readFileSync(join(h.repoPath, 'WIP.md'), 'utf-8')).toBe('wip\n')

      rimrafDir(h.tmp)
    } catch (e) {
      rimrafDir(h.tmp)
      throw e
    }
  })

  test('BP-03 startTask without fetchBeforeLaunch never invokes path fetch (legacy behavior)', async () => {
    const h = await setupPathMode()
    try {
      const localBefore = (await runGit(h.repoPath, ['rev-parse', 'main'])).stdout.trim()
      const originBefore = (await runGit(h.repoPath, ['rev-parse', 'origin/main'])).stdout.trim()
      await advanceRemote(h.bareRemote, h.tmp, 'second-no-fetch')

      const task = await startTask(
        {
          workflowId: h.workflow.id,
          name: 'task-068-legacy',
          repoPath: h.repoPath,
          baseBranch: 'main',
          // fetchBeforeLaunch omitted — should preserve legacy behavior.
          inputs: { topic: 't' },
        },
        {
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: stubCmd(h.stubOpencode),
          awaitScheduler: true,
        },
      )
      expect(task.status === 'done' || task.status === 'running').toBe(true)

      // Neither local main NOR origin/main moved (no fetch happened).
      const originAfter = (await runGit(h.repoPath, ['rev-parse', 'origin/main'])).stdout.trim()
      const localAfter = (await runGit(h.repoPath, ['rev-parse', 'main'])).stdout.trim()
      expect(originAfter).toBe(originBefore)
      expect(localAfter).toBe(localBefore)

      rimrafDir(h.tmp)
    } catch (e) {
      rimrafDir(h.tmp)
      throw e
    }
  })

  test('BP-02 path-mode fetch failure does not abort task launch (downgrade + WARN)', async () => {
    const h = await setupPathMode()
    try {
      // Yank the bare remote so fetch fails.
      rimrafDir(h.bareRemote)

      const task = await startTask(
        {
          workflowId: h.workflow.id,
          name: 'task-068-fetch-fail',
          repoPath: h.repoPath,
          baseBranch: 'main',
          fetchBeforeLaunch: true,
          inputs: { topic: 't' },
        },
        {
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: stubCmd(h.stubOpencode),
          awaitScheduler: true,
        },
      )
      // Task still launches (not failed because of fetch).
      expect(task.status === 'done' || task.status === 'running').toBe(true)

      rimrafDir(h.tmp)
    } catch (e) {
      rimrafDir(h.tmp)
      throw e
    }
  })
})

describe('startTask RFC-068 URL-mode FF', () => {
  test('BP-09 URL mode: second launch after origin advanced gets new baseCommit (FF effective)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-068-task-url-'))
    const appHome = join(tmp, 'home')
    mkdirSync(appHome, { recursive: true })
    const db = createInMemoryDb(MIGRATIONS)
    try {
      // Build fixture bare remote.
      const seed = join(tmp, 'seed')
      mkdirSync(seed)
      execSync(`git init -b main "${seed}"`, { stdio: 'ignore' })
      execSync(`git -C "${seed}" config user.email t@t.test`, { stdio: 'ignore' })
      execSync(`git -C "${seed}" config user.name t`, { stdio: 'ignore' })
      writeFileSync(join(seed, 'README.md'), '# seed\n')
      execSync(`git -C "${seed}" add . && git -C "${seed}" commit -m first`, { stdio: 'ignore' })
      const bareRemote = join(tmp, 'remote.git')
      execSync(`git clone --bare "${seed}" "${bareRemote}"`, { stdio: 'ignore' })
      const remoteUrl = `file://${bareRemote}`

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
      const workflow = await createWorkflow(db, {
        name: 'wf-068-url',
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
      const stubOpencode = writeStubOpencode(tmp, { outputs: { out: 'hello' } })

      // First launch — cold clone (no FF needed since clone is fresh).
      const t1 = await startTask(
        {
          workflowId: workflow.id,
          name: 't1',
          repoUrl: remoteUrl,
          inputs: { topic: 't' },
        },
        { db, appHome, opencodeCmd: stubCmd(stubOpencode), awaitScheduler: true },
      )
      const c1 = t1.baseCommit
      expect(c1).toMatch(/^[0-9a-f]{40}$/)

      // Advance remote.
      const newSha = await advanceRemote(bareRemote, tmp, 'two')
      expect(newSha).not.toBe(c1)

      // Second launch — warm reuse + FF should pick up origin/main = newSha.
      const t2 = await startTask(
        {
          workflowId: workflow.id,
          name: 't2',
          repoUrl: remoteUrl,
          inputs: { topic: 't' },
        },
        { db, appHome, opencodeCmd: stubCmd(stubOpencode), awaitScheduler: true },
      )
      expect(t2.baseCommit).toBe(newSha)

      rimrafDir(tmp)
    } catch (e) {
      rimrafDir(tmp)
      throw e
    }
    // RFC-W001: builds a bare remote + two startTask launches (origin advances
    // between them) + mock-opencode spawn, >5s on Windows CI; raise per-test
    // timeout past bun's 5s default so it doesn't fire mid-run.
  }, 60_000)
})
