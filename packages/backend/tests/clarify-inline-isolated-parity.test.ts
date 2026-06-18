// RFC-026 regression — strict isolated-mode parity.
//
// Hard contract from proposal §C1 / §A1: ANY ClarifyNode authored WITHOUT
// `sessionMode` (or with `sessionMode: 'isolated'`) MUST produce the same
// scheduler / runner observable behavior as RFC-023 did before RFC-026
// landed. Concretely: the spawn argv must NEVER contain `--session` on the
// isolated path, regardless of how many rounds of clarify Q&A have already
// happened. If this goes red, RFC-026 has accidentally bled inline behavior
// into the default isolated path — investigate before relaxing.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { agents, clarifySessions, tasks, workflows } from '../src/db/schema'
import { submitClarifyAnswers } from '../src/services/clarify'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'
import { reenterScheduler } from './reenter-scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

async function buildHarness() {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc026-parity-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  const argvPath = join(appHome, 'argv.jsonl')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  await runGit(repoPath, ['init', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-m', 'init'])
  await runGit(worktreePath, ['init', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'r.md'), '# r\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    repoPath,
    worktreePath,
    argvPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function setup(
  h: Awaited<ReturnType<typeof buildHarness>>,
  sessionMode: 'isolated' | undefined,
) {
  await h.db.insert(agents).values({
    id: ulid(),
    name: 'designer',
    description: 't',
    outputs: JSON.stringify(['design']),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
  const clarifyNode: Record<string, unknown> = { id: 'c', kind: 'clarify', title: 'C' }
  if (sessionMode !== undefined) clarifyNode.sessionMode = sessionMode
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [{ kind: 'text', key: 'req', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input', inputKey: 'req' } as WorkflowNode,
      { id: 'd', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      clarifyNode as WorkflowNode,
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'in', portName: 'req' },
        target: { nodeId: 'd', portName: 'req' },
      },
      {
        id: 'e2',
        source: { nodeId: 'd', portName: '__clarify__' },
        target: { nodeId: 'c', portName: 'questions' },
      },
      {
        id: 'e3',
        source: { nodeId: 'c', portName: 'answers' },
        target: { nodeId: 'd', portName: '__clarify_response__' },
      },
    ],
  }
  const taskId = ulid()
  const workflowId = ulid()
  await h.db
    .insert(workflows)
    .values({ id: workflowId, name: 'wf', definition: JSON.stringify(def) })
  await h.db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({ req: 'go' }),
    startedAt: Date.now(),
  })
  return taskId
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

const CLARIFY_BODY = JSON.stringify({
  questions: [{ id: 'q1', title: 'A?', kind: 'single', recommended: true, options: ['x', 'y'] }],
})

describe('RFC-026 regression — isolated mode never resumes', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  // Run BOTH "no sessionMode field" and "explicit isolated" through the same
  // end-to-end flow: round-0 clarify → user answers → round-1 rerun. Each
  // round's spawn argv must lack `--session`. Two rounds × two configs gives
  // us four datapoints; any one of them carrying `--session` is a regression.
  for (const sessionMode of [undefined, 'isolated'] as const) {
    test(`sessionMode=${sessionMode ?? '<missing>'} → argv never contains --session across rounds`, async () => {
      const taskId = await setup(h, sessionMode)
      await withEnv(
        {
          MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY,
          MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_iso_only',
          MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvPath,
        },
        () =>
          runTask({
            taskId,
            db: h.db,
            appHome: h.appHome,
            opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          }),
      )
      const sessionRow = (
        await h.db.select().from(clarifySessions).where(eq(clarifySessions.taskId, taskId))
      )[0]
      await submitClarifyAnswers({
        db: h.db,
        clarifyNodeRunId: sessionRow!.clarifyNodeRunId,
        directive: 'stop', // RFC-100: finalize round → <workflow-output> accepted
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [0],
            selectedOptionLabels: [],
            customText: '',
          },
        ],
      })
      // RFC-097: runTask's entry CAS only claims pending tasks — reset first
      // (test stand-in for resumeTask).
      await reenterScheduler(h.db, taskId)
      await withEnv(
        {
          MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'ok' }),
          MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_iso_only',
          MOCK_OPENCODE_CAPTURE_ARGV_TO: h.argvPath,
        },
        () =>
          runTask({
            taskId,
            db: h.db,
            appHome: h.appHome,
            opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          }),
      )
      const lines = existsSync(h.argvPath)
        ? readFileSync(h.argvPath, 'utf8')
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l) as { argv: string[] })
        : []
      expect(lines.length).toBeGreaterThanOrEqual(2)
      for (const line of lines) {
        expect(line.argv).not.toContain('--session')
      }
    })
  }
})
