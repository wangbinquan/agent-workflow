// RFC-041 — distiller unit tests (PR2 scope).
//
// All cases stub out the real `spawnFn` so no opencode subprocess is
// invoked; what we lock here is the orchestration (load events / load
// scope context / build prompt / parse envelope / persist candidates) +
// the grep-able protocol invariants (OPENCODE_CONFIG_CONTENT, tmp cwd,
// hardcoded agent name + system prompt anchors).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifySessions,
  memories,
  memoryDistillJobs,
  nodeRuns,
  taskFeedback,
  tasks,
  workflows,
} from '../src/db/schema'
import {
  DISTILLER_AGENT_NAME,
  DISTILLER_SYSTEM_PROMPT,
  buildDistillerUserPrompt,
  loadScopeContexts,
  loadSourceEvents,
  parseDistillerOutput,
  runDistill,
  validateAndPersistCandidate,
  type DistillerSpawnFn,
} from '../src/services/memoryDistiller'
import { rowToDistillJob } from '../src/services/memoryDistiller'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface SeededTask {
  taskId: string
  workflowId: string
}

function seedTask(db: DbClient): SeededTask {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 'fixture-task',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { taskId, workflowId: wfId }
}

describe('parseDistillerOutput', () => {
  test('extracts candidates from a clean envelope on raw stdout', () => {
    const stdout = `
<workflow-output>
<port name="candidates">{"candidates":[{
  "scopeType":"global","scopeId":null,
  "title":"Prefer plural for collection endpoints",
  "bodyMd":"Name list endpoints /items, not /item.",
  "knownTags":["rest"],"newTags":[],
  "action":"new","referenceMemoryId":null,
  "sourceRefs":[{"kind":"clarify","id":"c1"}]
}]}</port>
</workflow-output>
`
    const cands = parseDistillerOutput(stdout)
    expect(cands.length).toBe(1)
    expect(cands[0]!.scopeType).toBe('global')
    expect(cands[0]!.title).toContain('plural')
  })

  test('extracts candidates from opencode --format json stdout (line-delimited)', () => {
    const lines = [
      JSON.stringify({ type: 'session.created', sessionID: 's1' }),
      JSON.stringify({
        type: 'message',
        message: { content: '<workflow-output>\n<port name="candidates">' },
      }),
      JSON.stringify({ type: 'message', message: { content: '{"candidates":[]}' } }),
      JSON.stringify({ type: 'message', message: { content: '</port>\n</workflow-output>' } }),
    ].join('\n')
    expect(parseDistillerOutput(lines)).toEqual([])
  })

  // Regression: real opencode 1.15.x --format json wraps each model part in
  // { type:'text', sessionID, messageID, part:{type:'text', text:'...'}, timestamp }.
  // The original extractEventText only looked at evt.text / evt.message.content /
  // evt.delta.text, so production stdout always parsed as "no envelope" and
  // every candidate batch was silently dropped (no memories.distill_job_id
  // backlink, detail page showed "No candidates emitted" while the conversation
  // tab clearly displayed the envelope). Locks in the part.text path.
  test('extracts candidates from the real opencode --format json part.text shape', () => {
    const candidatesPort =
      '{"candidates":[{"scopeType":"global","scopeId":null,"title":"perf matters","bodyMd":"treat performance as critical","knownTags":[],"newTags":["performance"],"action":"new","referenceMemoryId":null,"sourceRefs":[{"kind":"feedback","id":"f1"}]}]}'
    const lines = [
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_X',
        messageID: 'msg_1',
        part: { id: 'prt_1', type: 'text', text: '# Source events to distill\n' },
        timestamp: 1,
      }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_X',
        messageID: 'msg_2',
        part: {
          id: 'prt_2',
          type: 'text',
          text: `<workflow-output>\n<port name="candidates">${candidatesPort}</port>\n</workflow-output>`,
        },
        timestamp: 2,
      }),
    ].join('\n')
    const cands = parseDistillerOutput(lines)
    expect(cands.length).toBe(1)
    expect(cands[0]!.title).toBe('perf matters')
    expect(cands[0]!.scopeType).toBe('global')
  })

  test('returns [] on missing envelope rather than throwing', () => {
    expect(parseDistillerOutput('no envelope here')).toEqual([])
  })

  test('returns [] on malformed candidates JSON', () => {
    const stdout = '<workflow-output><port name="candidates">{not json}</port></workflow-output>'
    expect(parseDistillerOutput(stdout)).toEqual([])
  })

  test('returns [] when port name is wrong', () => {
    const stdout = '<workflow-output><port name="other">{"candidates":[]}</port></workflow-output>'
    expect(parseDistillerOutput(stdout)).toEqual([])
  })

  test('takes the LAST envelope when multiple are present', () => {
    const stdout = `
<workflow-output>
<port name="candidates">{"candidates":[{"scopeType":"global","scopeId":null,"title":"first","bodyMd":"x","action":"new"}]}</port>
</workflow-output>
later draft:
<workflow-output>
<port name="candidates">{"candidates":[{"scopeType":"global","scopeId":null,"title":"winner","bodyMd":"x","action":"new"}]}</port>
</workflow-output>
`
    const cands = parseDistillerOutput(stdout)
    expect(cands.length).toBe(1)
    expect(cands[0]!.title).toBe('winner')
  })
})

describe('loadSourceEvents + loadScopeContexts', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('loads clarify + review + feedback rows by id and groups them by kind', async () => {
    const { taskId } = seedTask(db)
    // Seed a parent node_run so clarify session has a valid FK target.
    const sourceRunId = ulid()
    db.insert(nodeRuns)
      .values({
        id: sourceRunId,
        taskId,
        nodeId: 'agent-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        clarifyIteration: 0,
        status: 'awaiting_human',
      })
      .run()
    const clarifyRunId = ulid()
    db.insert(nodeRuns)
      .values({
        id: clarifyRunId,
        taskId,
        nodeId: 'clarify-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        clarifyIteration: 0,
        status: 'awaiting_human',
      })
      .run()
    const clarifyId = ulid()
    db.insert(clarifySessions)
      .values({
        id: clarifyId,
        taskId,
        sourceAgentNodeId: 'agent-1',
        sourceAgentNodeRunId: sourceRunId,
        sourceShardKey: null,
        clarifyNodeId: 'clarify-1',
        clarifyNodeRunId: clarifyRunId,
        iterationIndex: 0,
        questionsJson: JSON.stringify([{ id: 'q1', kind: 'open', text: 'what?' }]),
        answersJson: JSON.stringify([{ questionId: 'q1', text: 'answer' }]),
        status: 'answered',
      })
      .run()
    const feedbackId = ulid()
    db.insert(taskFeedback)
      .values({
        id: feedbackId,
        taskId,
        authorUserId: null,
        bodyMd: 'remember this',
        createdAt: Date.now(),
        distilled: 1,
      })
      .run()

    const job = rowToDistillJob({
      id: ulid(),
      debounceKey: `${taskId}:clarify`,
      sourceKind: 'clarify',
      sourceEventId: clarifyId,
      taskId,
      scopeResolvedJson: JSON.stringify({
        agentIds: [],
        workflowId: null,
        repoId: null,
        includeGlobal: true,
      }),
      status: 'pending',
      attempts: 0,
      nextRunAt: Date.now(),
      lastError: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    })
    const feedbackJob = rowToDistillJob({
      id: ulid(),
      debounceKey: `${taskId}:feedback`,
      sourceKind: 'feedback',
      sourceEventId: feedbackId,
      taskId,
      scopeResolvedJson: JSON.stringify({
        agentIds: [],
        workflowId: null,
        repoId: null,
        includeGlobal: true,
      }),
      status: 'pending',
      attempts: 0,
      nextRunAt: Date.now(),
      lastError: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    })

    const loaded = await loadSourceEvents(db, [job, feedbackJob])
    expect(loaded.clarify.length).toBe(1)
    expect(loaded.clarify[0]!.id).toBe(clarifyId)
    expect(loaded.feedback.length).toBe(1)
    expect(loaded.feedback[0]!.bodyMd).toBe('remember this')
    expect(loaded.review.length).toBe(0)
  })

  test('loadScopeContexts collects approved memories per scope and aggregates the tag pool', async () => {
    // Seed two approved memories on different scopes + one candidate (excluded).
    db.insert(memories)
      .values({
        id: ulid(),
        scopeType: 'global',
        scopeId: null,
        title: 'g-mem',
        bodyMd: 'body',
        tags: JSON.stringify(['tag-a', 'tag-b']),
        status: 'approved',
        sourceKind: 'manual',
        createdAt: Date.now(),
      })
      .run()
    db.insert(memories)
      .values({
        id: ulid(),
        scopeType: 'agent',
        scopeId: 'a1',
        title: 'a-mem',
        bodyMd: 'body',
        tags: JSON.stringify(['tag-c']),
        status: 'approved',
        sourceKind: 'manual',
        createdAt: Date.now(),
      })
      .run()
    // Candidate must NOT appear.
    db.insert(memories)
      .values({
        id: ulid(),
        scopeType: 'global',
        scopeId: null,
        title: 'cand',
        bodyMd: 'body',
        tags: JSON.stringify(['tag-z']),
        status: 'candidate',
        sourceKind: 'manual',
        createdAt: Date.now(),
      })
      .run()
    const ctx = await loadScopeContexts(db, {
      agentIds: ['a1'],
      workflowId: null,
      repoId: null,
      includeGlobal: true,
    })
    const global = ctx.find((s) => s.scopeType === 'global')
    const agent = ctx.find((s) => s.scopeType === 'agent')
    expect(global?.approved.length).toBe(1)
    expect(global?.tagPool).toEqual(['tag-a', 'tag-b'])
    expect(agent?.approved.length).toBe(1)
    expect(agent?.tagPool).toEqual(['tag-c'])
  })
})

describe('buildDistillerUserPrompt', () => {
  test('renders clarify / review / feedback events + per-scope dedup context', () => {
    const prompt = buildDistillerUserPrompt({
      events: {
        clarify: [{ id: 'c1', taskId: 't1', nodeId: 'n1', questions: '[]', answers: '[]' }],
        review: [
          {
            id: 'r1',
            taskId: 't1',
            nodeId: 'rn1',
            decision: 'approved',
            bodyPath: 'docs/v1.md',
            comments: [{ body: 'tighten', anchorParagraphIdx: 2, selectedText: 'foo bar' }],
          },
        ],
        feedback: [{ id: 'f1', taskId: 't1', bodyMd: 'note', createdAt: 1 }],
      },
      scopeContexts: [{ scopeType: 'global', scopeId: null, approved: [], tagPool: [] }],
      taskId: 't1',
    })
    expect(prompt).toContain('# Source events to distill')
    expect(prompt).toContain('## Clarify sessions')
    expect(prompt).toContain('## Review decisions')
    expect(prompt).toContain('## Task feedback notes')
    expect(prompt).toContain('scope=global/null')
    expect(prompt).toContain('(¶2)')
    expect(prompt).toContain('feedback:f1')
  })
})

describe('validateAndPersistCandidate', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('persists a valid candidate with status=candidate + tag merge', async () => {
    const job = rowToDistillJob({
      id: 'j1',
      debounceKey: 't1:clarify',
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId: 't1',
      scopeResolvedJson: '{}',
      status: 'running',
      attempts: 0,
      nextRunAt: 0,
      lastError: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    })
    const ok = await validateAndPersistCandidate(
      db,
      {
        scopeType: 'global',
        scopeId: null,
        title: 'T',
        bodyMd: 'B',
        knownTags: ['x', 'y'],
        newTags: ['z'],
        action: 'new',
        referenceMemoryId: null,
        sourceRefs: [],
      },
      job,
    )
    expect(ok).not.toBeNull()
    expect(ok!.memory.tags).toEqual(['x', 'y', 'z'])
    expect(ok!.memory.distillAction).toBe('new')
    expect(ok!.memory.sourceKind).toBe('clarify')
    const rowCount = db.select().from(memories).all().length
    expect(rowCount).toBe(1)
  })

  test('returns null + skips insert on invalid candidate (e.g. scope/scopeId mismatch)', async () => {
    const job = rowToDistillJob({
      id: 'j1',
      debounceKey: 't1:clarify',
      sourceKind: 'clarify',
      sourceEventId: 'c1',
      taskId: 't1',
      scopeResolvedJson: '{}',
      status: 'running',
      attempts: 0,
      nextRunAt: 0,
      lastError: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    })
    const r = await validateAndPersistCandidate(
      db,
      {
        scopeType: 'global',
        scopeId: 'should-be-null',
        title: 'T',
        bodyMd: 'B',
        action: 'new',
        sourceRefs: [],
      },
      job,
    )
    expect(r).toBeNull()
    expect(db.select().from(memories).all().length).toBe(0)
  })
})

describe('runDistill orchestration (mocked spawnFn)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('happy path: spawn returns one candidate envelope → persisted as candidate', async () => {
    const { taskId } = seedTask(db)
    const jobId = ulid()
    db.insert(memoryDistillJobs)
      .values({
        id: jobId,
        debounceKey: `${taskId}:clarify`,
        sourceKind: 'clarify',
        sourceEventId: 'c1',
        taskId,
        scopeResolvedJson: JSON.stringify({
          agentIds: [],
          workflowId: null,
          repoId: null,
          includeGlobal: true,
        }),
        status: 'running',
        attempts: 0,
        nextRunAt: Date.now(),
        createdAt: Date.now(),
      })
      .run()
    const jobRow = db.select().from(memoryDistillJobs).all()[0]!
    const spawnFn: DistillerSpawnFn = async (input) => {
      expect(input.cwd).toContain('aw-distiller-')
      const cfg = JSON.parse(input.inlineConfigJson) as {
        agent: Record<string, { prompt: string }>
      }
      expect(cfg.agent[DISTILLER_AGENT_NAME]?.prompt).toContain('aw-memory-distiller')
      return {
        exitCode: 0,
        stderr: '',
        stdout: `<workflow-output>
<port name="candidates">{"candidates":[{
  "scopeType":"global","scopeId":null,
  "title":"X","bodyMd":"B","knownTags":[],"newTags":[],
  "action":"new","referenceMemoryId":null,"sourceRefs":[]
}]}</port>
</workflow-output>`,
      }
    }
    const r = await runDistill({
      db,
      job: rowToDistillJob(jobRow),
      siblings: [rowToDistillJob(jobRow)],
      spawnFn,
    })
    expect(r.candidatesCreated).toBe(1)
    const inserted = db.select().from(memories).all()
    expect(inserted.length).toBe(1)
    expect(inserted[0]!.status).toBe('candidate')
  })

  test('non-zero exit propagates as thrown error (scheduler retries / records last_error)', async () => {
    const { taskId } = seedTask(db)
    const jobRow = {
      id: ulid(),
      debounceKey: `${taskId}:clarify`,
      sourceKind: 'clarify' as const,
      sourceEventId: 'c1',
      taskId,
      scopeResolvedJson: '{}',
      status: 'running' as const,
      attempts: 0,
      nextRunAt: Date.now(),
      lastError: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    }
    const job = rowToDistillJob(jobRow)
    const spawnFn: DistillerSpawnFn = async () => ({
      exitCode: 1,
      stderr: 'boom',
      stdout: '',
    })
    await expect(runDistill({ db, job, siblings: [job], spawnFn })).rejects.toThrow(
      /exited with code 1/,
    )
  })

  test('grep guards: source file pins protocol invariants', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'memoryDistiller.ts'),
      'utf8',
    )
    expect(src).toContain('OPENCODE_CONFIG_CONTENT')
    expect(src).toContain('mkdtemp')
    expect(src).toContain('aw-memory-distiller')
    expect(DISTILLER_SYSTEM_PROMPT.length).toBeGreaterThan(200)
  })
})
