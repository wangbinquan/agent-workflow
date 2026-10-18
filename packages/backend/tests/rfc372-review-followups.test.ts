// RFC-372 review follow-ups (design/RFC-372-mindmap-clarify/review-followups-20261014.md).
// Locks O1 (task background in follow-up prompts), O2 (generator logic out of the
// composition), O3 (one in-flight registry shared with the seal, no reverse
// application import) and O4 (canonical content keys survive property order).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  clarifyContentKey,
  clarifyFollowupContext,
  clarifyQuestionSetKey,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { clarifyRounds, nodeRuns, tasks, workflows } from '@/db/schema'
import { createClarifyRound } from '@/services/clarify/service'
import { sealRoundQuestions } from '@/modules/collaboration/infrastructure/clarify/seal'
import { createClarifyFollowupStore } from '@/modules/collaboration/infrastructure/clarifyFollowupStore'
import { createClarifyFollowupOperations } from '@/modules/collaboration/application/clarifyFollowup'
import {
  assertClarifyFollowupIdle,
  clarifyFollowupActivity,
} from '@/modules/collaboration/infrastructure/clarifyFollowupActivity'
import type { ClarifyFollowupGenerator } from '@/modules/collaboration/application/ports/clarifyFollowup'
import { createClarifyFollowupGeneration } from '@/modules/task-execution/infrastructure/clarifyFollowupGeneration'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const SRC = resolve(import.meta.dir, '..', 'src')
const editor = { userId: 'fixture', displayName: 'Reviewer', role: 'owner' as const }
const events = { publish: async () => {} }
const generated =
  '<workflow-clarify>' +
  JSON.stringify({
    questions: [
      ClarifyQuestionSchema.parse({
        id: 'new',
        title: 'Question new',
        kind: 'single',
        options: ['A', 'B'],
        mindmap: { categoryPath: ['Scope'] },
      }),
    ],
  }) +
  '</workflow-clarify>'

async function seed(
  h: ProviderHarness,
  options: {
    inputs?: Record<string, unknown>
    declared?: { key: string; label: string; kind: string }[]
    template?: string
  } = {},
) {
  const taskId = randomUUID(),
    workflowId = randomUUID(),
    askingNodeRunId = randomUUID()
  const definition = {
    $schema_version: 7,
    inputs: options.declared ?? [],
    nodes: [
      {
        id: 'asking',
        kind: 'agent-single',
        agentName: 'asking',
        ...(options.template === undefined ? {} : { promptTemplate: options.template }),
      },
      {
        id: 'gate',
        kind: 'clarify',
        interactionMode: 'mindmap',
        mindmap: { categories: ['Scope'], instructions: '' },
      },
    ],
    edges: [],
    outputs: [],
  }
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'review',
    definition: JSON.stringify(definition),
    schemaVersion: 7,
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'review',
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/rfc372-review',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'fixture',
    status: 'running',
    inputs: JSON.stringify(options.inputs ?? {}),
    startedAt: Date.now(),
  })
  await h.db
    .insert(nodeRuns)
    .values({ id: askingNodeRunId, taskId, nodeId: 'asking', status: 'done', iteration: 0 })
  const round = await createClarifyRound({
    db: h.db,
    taskId,
    askingNodeId: 'asking',
    askingNodeRunId,
    intermediaryNodeId: 'gate',
    kind: 'self',
    askingShardKey: null,
    iteration: 0,
    questions: [
      ClarifyQuestionSchema.parse({
        id: 'a',
        title: 'Question a',
        kind: 'single',
        options: ['A', 'B'],
        mindmap: { categoryPath: ['Scope'] },
      }),
    ],
  })
  const read = async () =>
    (
      await h.db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, round.intermediaryNodeRunId))
    )[0]!
  return { taskId, askingNodeRunId, nodeRunId: round.intermediaryNodeRunId, read }
}

const generation = (h: ProviderHarness) =>
  createClarifyFollowupGeneration({
    db: h.db,
    registry: {} as never,
    family: {} as never,
    bindRuntime: (() => {
      throw new Error('context() never binds a runtime')
    }) as never,
  })

describeEachProvider('RFC-372 review O1: task background for follow-ups', (h) => {
  test('reads declared launcher inputs in definition order and the unexpanded asking template', async () => {
    const fixture = await seed(h, {
      declared: [
        { key: 'topic', label: '设计主题', kind: 'text' },
        { key: 'scale', label: 'Scale', kind: 'text' },
        { key: 'files', label: 'Files', kind: 'upload' },
        { key: 'missing', label: 'Missing', kind: 'text' },
      ],
      inputs: {
        scale: 500,
        topic: '会议室预约系统',
        files: [{ name: 'spec.pdf' }],
        undeclared: 'internal value',
      },
      template: '为以下主题设计系统。主题：{{topic}}',
    })
    expect(
      await generation(h).context({
        askingNodeRunId: fixture.askingNodeRunId,
        taskId: fixture.taskId,
      }),
    ).toEqual({
      inputs: [
        { key: 'topic', label: '设计主题', value: '会议室预约系统' },
        { key: 'scale', label: 'Scale', value: '500' },
      ],
      instruction: '为以下主题设计系统。主题：{{topic}}',
      truncated: false,
    })
  })

  test('bounds every value, the total and the instruction', async () => {
    const fixture = await seed(h, {
      declared: [
        { key: 'a', label: 'A', kind: 'text' },
        { key: 'b', label: 'B', kind: 'text' },
        { key: 'c', label: 'C', kind: 'text' },
      ],
      inputs: { a: 'x'.repeat(5000), b: 'y'.repeat(5000), c: 'z' },
      template: 't'.repeat(4500),
    })
    const context = await generation(h).context({
      askingNodeRunId: fixture.askingNodeRunId,
      taskId: fixture.taskId,
    })
    expect(context!.truncated).toBe(true)
    expect(context!.inputs.map((input) => input.value.length)).toEqual([4000, 4000])
    expect(context!.instruction).toHaveLength(4000)
  })

  test('is absent for another task, an empty background or unreadable rows', async () => {
    const fixture = await seed(h, { template: '   ' })
    const other = await seed(h, { template: 'Other task instruction' })
    expect(
      await generation(h).context({
        askingNodeRunId: other.askingNodeRunId,
        taskId: fixture.taskId,
      }),
    ).toBeNull()
    expect(
      await generation(h).context({
        askingNodeRunId: fixture.askingNodeRunId,
        taskId: fixture.taskId,
      }),
    ).toBeNull()
    await h.db.update(tasks).set({ inputs: '{' }).where(eq(tasks.id, other.taskId))
    expect(
      await generation(h).context({ askingNodeRunId: other.askingNodeRunId, taskId: other.taskId }),
    ).toBeNull()
  })

  test('the follow-up prompt carries taskContext as background; a failing source never blocks', async () => {
    const fixture = await seed(h)
    const store = createClarifyFollowupStore(h.db, events)
    const background = {
      inputs: [{ key: 'topic', label: 'Topic', value: 'Room booking' }],
      instruction: 'Design {{topic}}',
      truncated: false,
    }
    let prompt = ''
    const generator: ClarifyFollowupGenerator = {
      context: async (input) => {
        expect(input).toEqual({ askingNodeRunId: fixture.askingNodeRunId, taskId: fixture.taskId })
        return background
      },
      generate: async (input) => {
        prompt = input.prompt
        return generated
      },
    }
    const request = async (requestId: string) => {
      const snapshot = await store.read(fixture.nodeRunId, 'a')
      return {
        requestId,
        parentQuestionId: 'a',
        instruction: '',
        basis: clarifyContentKey(clarifyFollowupContext(snapshot.questions, snapshot.drafts, 'a')),
      }
    }
    const operations = createClarifyFollowupOperations(store, generator, clarifyFollowupActivity)
    await operations.append(fixture.nodeRunId, await request(randomUUID()), editor)
    expect(prompt).toContain('taskContext is the original task input')
    expect(JSON.parse(prompt.split('\n\n').at(-1)!).taskContext).toEqual(background)

    const failing = createClarifyFollowupOperations(
      store,
      {
        context: async () => {
          throw new Error('source unavailable')
        },
        generate: async (input) => {
          prompt = input.prompt
          return generated
        },
      },
      clarifyFollowupActivity,
    )
    const retried = await failing.append(fixture.nodeRunId, await request(randomUUID()), editor)
    expect(retried.questionIds).toHaveLength(1)
    expect(prompt).not.toContain('taskContext')
  })
})

describeEachProvider('RFC-372 review O4: canonical keys across property order', (h) => {
  test('a whole round seals with keys computed from questions built in another property order', async () => {
    const fixture = await seed(h)
    const stored = JSON.parse((await fixture.read()).questionsJson) as ClarifyQuestion[]
    // A client that re-parsed the round may hold differently ordered objects.
    const reordered = stored.map(
      (question) =>
        Object.fromEntries(Object.entries(question).reverse()) as unknown as ClarifyQuestion,
    )
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(stored))
    const answers: ClarifyAnswer[] = reordered.map((question) => {
      const value = {
        questionId: question.id,
        selectedOptionIndices: [0],
        selectedOptionLabels: [],
        customText: '',
      }
      return { ...value, confirmedBasis: clarifyAnswerBasis(question, value) }
    })
    const sealed = await sealRoundQuestions({
      db: h.db,
      originNodeRunId: fixture.nodeRunId,
      wholeRound: true,
      questionSetKey: clarifyQuestionSetKey(reordered),
      answers,
    })
    expect(sealed.roundFullySealed).toBe(true)
  })
})

describe('RFC-372 review O3: one in-flight registry shared with the seal', () => {
  const entry = (requestId: string, abort = new AbortController()) => ({
    requestId,
    requestKey: `key-${requestId}`,
    target: 'a',
    startedAt: 0,
    abort,
    generating: true,
    accepted: Promise.resolve({ state: 'running' as const }),
    result: Promise.resolve({ questionIds: [] }),
  })

  test('a canceled generation stops blocking the seal but still occupies its round until settled', () => {
    const abort = new AbortController()
    const release = clarifyFollowupActivity.begin('round-o3', entry('r1', abort))
    try {
      expect(() => assertClarifyFollowupIdle('round-o3')).toThrow('follow-up is being generated')
      abort.abort()
      expect(() => assertClarifyFollowupIdle('round-o3')).not.toThrow()
      expect(clarifyFollowupActivity.current('round-o3')?.requestId).toBe('r1')
      expect(() => clarifyFollowupActivity.begin('round-o3', entry('r2'))).toThrow(
        'already being generated',
      )
    } finally {
      release()
    }
    expect(clarifyFollowupActivity.current('round-o3')).toBeUndefined()
  })

  test('a stale release never removes a newer generation', () => {
    const first = clarifyFollowupActivity.begin('round-o3-release', entry('r1'))
    first()
    const second = clarifyFollowupActivity.begin('round-o3-release', entry('r2'))
    first()
    expect(clarifyFollowupActivity.current('round-o3-release')?.requestId).toBe('r2')
    second()
  })

  test('the seal reads the infrastructure registry, not an application module', () => {
    const seal = readFileSync(
      resolve(SRC, 'modules/collaboration/infrastructure/clarify/seal.ts'),
      'utf8',
    )
    expect(seal).toContain("from '../clarifyFollowupActivity'")
    expect(seal).not.toMatch(/from '\.\.\/\.\.\/application\//)
  })
})

describe('RFC-372 review O2: the composition only wires the generator', () => {
  test('database reads and runtime resolution live in the task-execution adapter', () => {
    const composition = readFileSync(
      resolve(SRC, 'modules/task-execution/composition/clarifyFollowupGenerator.ts'),
      'utf8',
    )
    expect(composition).toContain('createClarifyFollowupGeneration(')
    expect(composition).not.toMatch(/from '@\/db\/schema'|from 'drizzle-orm'/)
    expect(composition).not.toContain('resolveRuntimeByName')
  })
})
