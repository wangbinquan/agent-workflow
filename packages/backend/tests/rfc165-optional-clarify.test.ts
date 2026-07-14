// LOCKS: RFC-165 T8b (F12) — the OPTIONAL clarify directive, end to end.
//
//   O1 runner accepts EITHER envelope under directive='optional': a
//      <workflow-output> reply finalizes (no clarify-required rejection —
//      the mandatory gate must not fire), and a <workflow-clarify> reply
//      opens a round (no clarify-forbidden rejection — the stopped gate must
//      not fire). 'both' stays rejected (exactly-one-envelope invariant).
//   O2 scheduler composes directive='optional' from the wired self-clarify
//      node's clarifyMode field, with precedence stopped > optional >
//      mandatory/suppressed; clarifyMode undefined keeps the pre-RFC-165
//      mandatory/suppressed semantics byte-for-byte (R3-5 compat default).
//      Source-lock (the ladder itself is locked in rfc123-stop-enforcement).
//   O3 renderUserPrompt: optional renders the DUAL-envelope protocol —
//      optional preamble + clarify format + output format; inline rounds get
//      the dual-choice reminder; mandatory rendering is byte-unaffected.
//   O4 envelope-followup keeps the clarify option alive for optional rounds
//      (runner threads hasClarifyChannel=true into the followup renderer).
//   O5 the PUBLIC answer contract is untouched: SubmitClarifyAnswers
//      directive stays continue|stop — 'optional' is rejected (D2 lock).

import type { Agent } from '@agent-workflow/shared'
import {
  buildOptionalClarifyPreamble,
  renderUserPrompt,
  SubmitClarifyAnswersSchema,
} from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup: () => void
}

function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'asker',
    description: 'an agent that may clarify',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'You may ask back.',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc165-optional-'))
  const worktreePath = join(appHome, 'worktree-fake')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function insertPendingNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'asker', status: 'pending' })
  return id
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
  questions: [
    {
      id: 'q1',
      title: 'Pick a DB?',
      kind: 'single',
      recommended: true,
      options: ['Postgres', 'MySQL'],
    },
  ],
})

function runOptionalNode(h: Harness, nodeRunId: string, env: Record<string, string>) {
  return withEnv(env, () =>
    runNode({
      taskId: h.taskId,
      nodeRunId,
      nodeId: 'asker',
      agent: makeAgent(),
      inputs: {},
      worktreePath: h.worktreePath,
      templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
      skills: [],
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      db: h.db,
      clarifyChannel: { kind: 'self', directive: 'optional', injectStopNotice: false },
    }),
  )
}

describe('RFC-165 O1 — runner accepts either envelope under optional', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('O1a <workflow-output> finalizes (mandatory gate must not fire)', async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runOptionalNode(h, nodeRunId, {
      MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'all clear, done directly' }),
    })
    expect(result.status).toBe('done')
    expect(result.errorMessage ?? '').not.toMatch(/clarify-required/)
    expect(result.clarify).toBeUndefined()
    expect(result.outputs.summary).toBe('all clear, done directly')
  })

  test('O1b <workflow-clarify> opens a round (stopped gate must not fire)', async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runOptionalNode(h, nodeRunId, {
      MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY,
    })
    expect(result.status).toBe('done')
    expect(result.errorMessage ?? '').not.toMatch(/clarify-forbidden/)
    expect(result.clarify).toBeDefined()
    expect(result.clarify?.questions).toHaveLength(1)
  })

  test('O1c BOTH envelopes stays rejected (exactly-one invariant survives optional)', async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runOptionalNode(h, nodeRunId, {
      MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'x' }),
      MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY,
    })
    expect(result.status).toBe('failed')
    expect(result.errorMessage ?? '').toMatch(/both/i)
  })
})

describe('RFC-165 O2 — scheduler composition + R3-5 compat (source locks)', () => {
  const schedulerSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    'utf8',
  )
  const norm = (x: string) => x.replace(/\s+/g, ' ')

  test('optional derives from the wired self-clarify node clarifyMode (static field, every rerun)', () => {
    expect(norm(schedulerSrc)).toContain(
      "const clarifyOptional = hasClarifyChannel && clarifyNodeObjForGate?.clarifyMode === 'optional'",
    )
  })

  test('R3-5 compat: clarifyMode undefined leaves the mandatory/suppressed ladder untouched', () => {
    // The ladder falls through optional ONLY when the field says 'optional';
    // an undefined clarifyMode reaches the historical
    // effectiveHasClarifyChannel branch verbatim.
    expect(norm(schedulerSrc)).toContain(
      "clarifyOptional ? ('optional' as const) : effectiveHasClarifyChannel ? ('mandatory' as const) : ('suppressed' as const)",
    )
  })

  test('the channel-family local is renamed channelKind (no clash with the node field)', () => {
    expect(norm(schedulerSrc)).toContain("const channelKind: 'self' | 'cross' =")
    expect(norm(schedulerSrc)).not.toContain("const clarifyMode: 'self' | 'cross' =")
  })
})

describe('RFC-165 O3 — renderUserPrompt dual-envelope protocol', () => {
  const BASE = {
    promptTemplate: 'Do the thing: {{topic}}',
    inputs: { topic: 'refactor' },
    agentOutputs: ['summary'],
  }

  test('optional → optional preamble + BOTH format blocks', () => {
    const p = renderUserPrompt({
      ...BASE,
      clarifyChannel: { kind: 'self', directive: 'optional', injectStopNotice: false },
    } as never)
    expect(p).toContain('OPTIONAL clarify channel')
    expect(p).toContain('<workflow-clarify>')
    expect(p).toContain('<workflow-output>')
    // Sanity: the preamble helper is what rendered it (single source).
    expect(p).toContain(buildOptionalClarifyPreamble().trim().split('\n')[1]!.slice(0, 40))
  })

  test('P1 fix: optional dual block carries NO contradictory mandatory commands', () => {
    const p = renderUserPrompt({
      ...BASE,
      clarifyChannel: { kind: 'self', directive: 'optional', injectStopNotice: false },
    } as never)
    // The mandatory-only commands must be absent…
    expect(p).not.toContain('no <workflow-output> anywhere in the reply')
    expect(p).not.toContain('You MUST end your reply with')
    // …replaced by the explicit either/or framing.
    expect(p).toContain('Option A — ask the user')
    expect(p).toContain('Option B — finalize')
  })

  test('mandatory rendering unaffected: clarify-only, still NO output format', () => {
    const p = renderUserPrompt({
      ...BASE,
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
    } as never)
    expect(p).toContain('MANDATORY ASK-BACK')
    expect(p).toContain('<workflow-clarify>')
    expect(p).not.toContain('OPTIONAL clarify channel')
  })

  test('optional inline (post-answer) round → dual-choice reminder', () => {
    const p = renderUserPrompt({
      ...BASE,
      clarifyChannel: { kind: 'self', directive: 'optional', injectStopNotice: false },
      clarifyContext: {
        rounds: [],
        mode: 'inline',
        directive: 'continue',
      },
    } as never)
    expect(p).toContain('OPTIONAL ask-back mode')
    expect(p).toContain('exactly one of the two envelopes')
  })
})

describe('RFC-165 O4b — followup renderer dual-choice for optional (P2 fix)', () => {
  test('optional correction round offers BOTH envelopes; mandatory wording gone', async () => {
    const { renderEnvelopeFollowupPrompt } = await import('@agent-workflow/shared')
    const p = renderEnvelopeFollowupPrompt({
      reason: 'envelope-missing',
      hasClarifyChannel: true,
      clarifyOptional: true,
    } as never)
    expect(p).toContain('OPTIONAL clarify channel')
    expect(p).toContain('<workflow-output>')
    expect(p).not.toContain('MANDATORY ask-back mode: your reply MUST be exactly one')
  })

  test('optional answered round trailer allows finalizing', async () => {
    const { renderEnvelopeFollowupPrompt } = await import('@agent-workflow/shared')
    const p = renderEnvelopeFollowupPrompt({
      reason: 'clarify-malformed',
      hasClarifyChannel: true,
      clarifyOptional: true,
      clarifyDirective: 'continue',
    } as never)
    expect(p).toContain('OPTIONAL ask-back mode')
    expect(p).not.toContain('`<workflow-output>` is not an option')
  })
})

describe('RFC-165 O4 — followup keeps clarify alive for optional (source lock)', () => {
  test('runner threads mandatory OR optional into the followup renderer', () => {
    const runnerSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
      'utf8',
    )
    const norm = (x: string) => x.replace(/\s+/g, ' ')
    // RFC-183: the projection derives from the shared clarifyDispositionFor
    // classifier (invite⟺accept single source) instead of a directive literal.
    expect(norm(runnerSrc)).toContain(
      "const clarifyOptional = clarifyDisposition === 'invite-optional'",
    )
    expect(norm(runnerSrc)).toContain('hasClarifyChannel: clarifyMandatory || clarifyOptional')
  })
})

describe('RFC-165 O5 — public answer contract unchanged (D2)', () => {
  test("SubmitClarifyAnswers directive rejects 'optional'", () => {
    const ok = SubmitClarifyAnswersSchema.safeParse({
      answers: [],
      directive: 'optional',
    })
    expect(ok.success).toBe(false)
  })
})
