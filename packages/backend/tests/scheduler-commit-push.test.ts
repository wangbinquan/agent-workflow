// RFC-075 T11 — end-to-end scheduler trigger for auto commit&push.
//
// Drives a real task (single writer agent) through the scheduler with a stub
// opencode + a bare remote, and asserts:
//   - autoCommitPush ON  → after the writer's final output, a synthetic
//     commit&push node_run appears (pushed), and the remote received the
//     isolation branch.
//   - autoCommitPush OFF → no commit node_run (byte-baseline: zero change).
//   - clarify/readonly/no-change are covered by commit-push-core unit tests;
//     here we lock the live wiring path (diff-driven trigger + runNode-driven
//     commit-agent message + git push).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns } from '../src/db/schema'
import { runGit } from '../src/util/git'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { startTaskWithLocalRepo } from '../src/services/task'
import { commitPushNodeId, isCommitPushNodeId } from '../src/services/commitPush'
import type { CommitPushMeta } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  tmp: string
  appHome: string
  repoPath: string
  remote: string
  db: DbClient
  stub: string
  wfId: string
}

// One stub plays both roles: the commit agent (prompt mentions commit_message)
// emits a commit message and writes nothing; the writer agent dirties the
// worktree and emits its output port.
function makeStub(dir: string): string {
  const path = join(dir, 'stub-opencode.sh')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then echo 'stub-opencode 1.14.99'; exit 0; fi
if [[ "$1" == "run" ]]; then
  NONCE=$(printf '%s' "$*" | sed -n 's/.*nonce="\\([^"]*\\)".*/\\1/p' | head -n 1)
  OPEN='<workflow-output>'
  if [[ -n "$NONCE" ]]; then OPEN='<workflow-output nonce="'"$NONCE"'">'; fi
  if [[ "$*" == *commit_message* ]]; then
    ENV="$OPEN"'<port name="commit_message">feat: stub commit</port></workflow-output>'
  else
    printf 'agent change %s\\n' "$(date +%s%N)" > agent-output.txt
    ENV="$OPEN"'<port name="out">ok</port></workflow-output>'
  fi
  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$(date +%s%3N)" "$ENV"
  exit 0
fi
exit 1
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

async function setup(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc075-sched-'))
  const appHome = join(tmp, 'home')
  const repoPath = join(tmp, 'repo')
  const remote = mkdtempSync(join(tmp, 'remote-'))
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)

  await runGit(remote, ['init', '-q', '--bare', '-b', 'main'])
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])
  await runGit(repoPath, ['remote', 'add', 'origin', remote])
  await runGit(repoPath, ['push', '-q', '-u', 'origin', 'main'])

  const stub = makeStub(tmp)

  await createAgent(db, {
    name: 'writer',
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
        { id: 'writer', kind: 'agent-single', agentName: 'writer', promptTemplate: '{{topic}}' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'writer', portName: 'topic' },
        },
      ],
    },
  })

  return { tmp, appHome, repoPath, remote, db, stub, wfId: wf.id }
}

describe('RFC-075 scheduler auto commit&push', () => {
  let h: Harness
  beforeEach(async () => {
    h = await setup()
  })
  afterEach(() => rmSync(h.tmp, { recursive: true, force: true }))

  test('autoCommitPush ON → writer change is committed + pushed to the remote', async () => {
    const task = await startTaskWithLocalRepo(
      {
        workflowId: h.wfId,
        name: 'cp-on',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
        autoCommitPush: true,
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stub], awaitScheduler: true },
    )

    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
    // The commit CONTAINER row carries commit_push_json; session children share
    // the nodeId but have null commit_push_json.
    const commitRow = rows.find((r) => isCommitPushNodeId(r.nodeId) && r.commitPushJson !== null)
    expect(commitRow).toBeDefined()
    expect(commitRow!.nodeId).toBe(commitPushNodeId('writer'))
    expect(commitRow!.parentNodeRunId).not.toBeNull()
    expect(commitRow!.status).toBe('done')
    // The message-gen session was captured on a child node_run (parent = the
    // commit container) so the detail page can show it.
    const sessionChild = rows.find(
      (r) => r.parentNodeRunId === commitRow!.id && r.commitPushJson === null,
    )
    expect(sessionChild).toBeDefined()

    const meta = JSON.parse(commitRow!.commitPushJson!) as CommitPushMeta
    expect(meta.pushOutcome).toBe('pushed')
    expect(meta.messageSource).toBe('llm')
    expect(meta.commitSha).toMatch(/^[a-f0-9]{40}$/)
    expect(meta.repoBranch).toBe(`agent-workflow/${task.id}`)

    // Remote received the isolation branch with the commit.
    const ls = await runGit(h.remote, [
      'rev-parse',
      '--verify',
      `refs/heads/agent-workflow/${task.id}`,
    ])
    expect(ls.exitCode).toBe(0)
  })

  test('autoCommitPush OFF (default) → no commit node_run (byte-baseline)', async () => {
    const task = await startTaskWithLocalRepo(
      {
        workflowId: h.wfId,
        name: 'cp-off',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: { topic: 't' },
      },
      { db: h.db, appHome: h.appHome, opencodeCmd: [h.stub], awaitScheduler: true },
    )
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
    expect(rows.some((r) => isCommitPushNodeId(r.nodeId))).toBe(false)
    // Remote did NOT get an isolation branch.
    const ls = await runGit(h.remote, [
      'rev-parse',
      '--verify',
      `refs/heads/agent-workflow/${task.id}`,
    ])
    expect(ls.exitCode).not.toBe(0)
  })
})
