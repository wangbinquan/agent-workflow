// RFC-099 T10 — prompt isolation: attribution (user ids, display names, role
// snapshots) is record/UI-only and must NEVER reach agent-facing surfaces.
// Two layers of defense:
//   1. runtime — build the real prompt artifacts from rows saturated with
//      attribution and assert no identity string leaks;
//   2. source-level — the rendering functions must not reference the
//      attribution columns at all.
//
// If layer 2 goes red, someone wired an attribution column into a prompt
// builder; do NOT "fix" the test — re-read RFC-099 proposal 目标 #6.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { buildPromptContext } from '../src/services/clarifyRounds'
import { renderCommentsForPrompt } from '../src/services/review'
import type { ReviewComment, WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const USER_ID = '01HUSERIDLEAKCANARY0000000'
const DISPLAY_NAME = 'Leaky McLeakface'

describe('RFC-099 prompt isolation — runtime', () => {
  test('renderCommentsForPrompt never emits author / authorRole', () => {
    const comment: ReviewComment = {
      id: ulid(),
      docVersionId: ulid(),
      anchor: {
        sectionPath: 'Heading',
        paragraphIdx: 0,
        offsetStart: 0,
        offsetEnd: 4,
        selectedText: 'body',
        contextBefore: '',
        contextAfter: ' text',
        occurrenceIndex: 1,
      },
      commentText: 'please tighten this',
      author: USER_ID,
      authorRole: 'owner',
      createdAt: Date.now(),
    }
    const rendered = renderCommentsForPrompt([comment])
    expect(rendered).toContain('please tighten this')
    expect(rendered).not.toContain(USER_ID)
    expect(rendered).not.toContain('authorRole')
    expect(rendered).not.toContain(DISPLAY_NAME)
  })

  test('buildPromptContext blocks never contain submitter / per-question attribution', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `task_${ulid()}`
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [],
      nodes: [],
      edges: [],
      outputs: [],
    }
    const workflowId = `wf_${taskId}`
    await db
      .insert(workflows)
      .values({ id: workflowId, name: 'wf', description: '', definition: JSON.stringify(def) })
    await db.insert(tasks).values({
      name: 't',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/never-read',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const askingRunId = ulid()
    const intermediaryRunId = ulid()
    await db.insert(nodeRuns).values([
      { id: askingRunId, taskId, nodeId: 'asking', status: 'done', retryIndex: 0, iteration: 0 },
      {
        id: intermediaryRunId,
        taskId,
        nodeId: 'c1',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(clarifyRounds).values({
      id: ulid(),
      taskId,
      kind: 'self',
      askingNodeId: 'asking',
      askingNodeRunId: askingRunId,
      intermediaryNodeId: 'c1',
      intermediaryNodeRunId: intermediaryRunId,
      iteration: 0,
      questionsJson: JSON.stringify([
        {
          id: 'q1',
          title: 'Which database?',
          kind: 'single',
          recommended: true,
          options: [
            { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ]),
      answersJson: JSON.stringify([
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['Postgres'],
          customText: '',
        },
      ]),
      status: 'answered',
      answeredAt: Date.now(),
      answeredBy: USER_ID,
      // RFC-099 attribution saturation — none of this may surface below.
      submittedByRole: 'owner',
      answerAttributionsJson: JSON.stringify({
        q1: { userId: USER_ID, role: 'owner', updatedAt: Date.now() },
      }),
      createdAt: Date.now(),
    })

    const ctx = await buildPromptContext({
      db,
      definition: def,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'asking',
      targetIteration: 1,
    })
    expect(ctx).toBeDefined()
    const everything = `${ctx!.questionsBlock}\n${ctx!.answersBlock}`
    expect(everything).toContain('Postgres')
    expect(everything).not.toContain(USER_ID)
    expect(everything).not.toContain(DISPLAY_NAME)
    expect(everything).not.toContain('submittedByRole')
    expect(everything).not.toContain('answerAttributions')
  })
})

describe('RFC-099 prompt isolation — opencode injection', () => {
  test('buildInlineAgentEntry never serializes ownerUserId / visibility into OPENCODE_CONFIG_CONTENT', async () => {
    const { buildInlineAgentEntry } = await import('../src/services/runner')
    const entry = buildInlineAgentEntry({
      id: 'a1',
      name: 'leaky',
      description: 'd',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'prompt body',
      ownerUserId: USER_ID,
      visibility: 'private',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    const serialized = JSON.stringify(entry)
    expect(serialized).toContain('prompt body')
    expect(serialized).not.toContain(USER_ID)
    expect(serialized).not.toContain('ownerUserId')
    expect(serialized).not.toContain('visibility')
  })
})

describe('RFC-099 prompt isolation — source level', () => {
  const backendSrc = (p: string) => readFileSync(resolve(import.meta.dir, '..', 'src', p), 'utf8')

  /** Extract one top-level function's text (declaration → next top-level brace close). */
  function sliceFunction(source: string, marker: string): string {
    const start = source.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const tail = source.slice(start)
    const end = tail.indexOf('\n}\n')
    expect(end).toBeGreaterThan(-1)
    return tail.slice(0, end)
  }

  test('renderCommentsForPrompt body references neither author nor authorRole', () => {
    const review = backendSrc('services/review.ts')
    const fn = sliceFunction(review, 'export function renderCommentsForPrompt(')
    expect(fn).not.toContain('author')
    expect(fn).not.toContain('decidedBy')
  })

  test('buildPromptContext body references no attribution column', () => {
    const rounds = backendSrc('services/clarifyRounds.ts')
    const fn = sliceFunction(rounds, 'export async function buildPromptContext(')
    expect(fn).not.toContain('answeredBy')
    expect(fn).not.toContain('submittedByRole')
    expect(fn).not.toContain('answerAttributions')
    expect(fn).not.toContain('draftAnswers')
    expect(fn).not.toContain('displayName')
  })

  test('shared clarify prompt renderers reference no attribution identifiers', () => {
    const sharedClarify = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'clarify.ts'),
      'utf8',
    )
    expect(sharedClarify).not.toContain('answeredBy')
    expect(sharedClarify).not.toContain('submittedByRole')
    expect(sharedClarify).not.toContain('answerAttributions')
    expect(sharedClarify).not.toContain('displayName')
  })
})
