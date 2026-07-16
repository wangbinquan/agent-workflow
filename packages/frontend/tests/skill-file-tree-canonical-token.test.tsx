// RFC-201 T3.2 — composite-token save planning and stable snapshot recovery.

import { describe, expect, test } from 'vitest'
import type { SkillContent } from '@agent-workflow/shared'
import {
  aggregateSkillCompositeDraft,
  captureSkillSavePlan,
  createSkillCompositeDraft,
  editSkillFile,
  editSkillMetadata,
  editSkillNewPath,
  readStableSkillSnapshot,
  receiveSkillMetadata,
  reduceSkillCompositeScope,
  stageSkillFileCreate,
} from '../src/lib/skill-composite-draft'

function content(token: string, bodyMd = 'body', description = 'description'): SkillContent {
  return { name: 'sk1', description, bodyMd, frontmatterExtra: {}, token }
}

describe('RFC-201 Skill composite draft', () => {
  test('newPath participates in dirty/valid until Add stages it', () => {
    let state = createSkillCompositeDraft(content('T1'))
    state = editSkillNewPath(state, 'notes.md')
    expect(aggregateSkillCompositeDraft(state)).toMatchObject({ dirty: true, valid: false })
    expect(captureSkillSavePlan(state)).toEqual([])

    state = stageSkillFileCreate(state, 'notes.md')
    state = editSkillFile(state, 'notes.md', 'hello')
    expect(state.newPath.dirty).toBe(false)
    expect(aggregateSkillCompositeDraft(state)).toMatchObject({ dirty: true, valid: true })
    expect(captureSkillSavePlan(state)).toMatchObject([
      { kind: 'file', path: 'notes.md', op: 'put', submitted: { exists: true, content: 'hello' } },
    ])
  })

  test('successful scopes disappear from retry while failed/unexecuted scopes remain ordered', () => {
    let state = createSkillCompositeDraft(content('T1'))
    state = editSkillMetadata(state, { description: 'next', bodyMd: 'body' })
    state = stageSkillFileCreate(state, 'z.md')
    state = stageSkillFileCreate(state, 'a.md')
    const firstPlan = captureSkillSavePlan(state)
    expect(firstPlan.map((step) => (step.kind === 'metadata' ? 'metadata' : step.path))).toEqual([
      'metadata',
      'a.md',
      'z.md',
    ])

    const metadata = firstPlan[0]!
    expect(metadata.kind).toBe('metadata')
    if (metadata.kind !== 'metadata') throw new Error('expected metadata first')
    state = reduceSkillCompositeScope(
      state,
      { kind: 'metadata' },
      {
        type: 'begin-submit',
        requestId: 'm1',
        submittedRevision: metadata.submittedRevision,
      },
    )
    state = reduceSkillCompositeScope(
      state,
      { kind: 'metadata' },
      {
        type: 'submit-success',
        requestId: 'm1',
        submittedRevision: metadata.submittedRevision,
        persisted: metadata.submitted,
      },
    )

    expect(
      captureSkillSavePlan(state).map((step) => (step.kind === 'file' ? step.path : 'm')),
    ).toEqual(['a.md', 'z.md'])
  })

  test('a late success advances baseline but never clears a newer local revision', () => {
    let state = createSkillCompositeDraft(content('T1'))
    state = editSkillMetadata(state, { description: 'submitted', bodyMd: 'body' })
    const step = captureSkillSavePlan(state)[0]!
    if (step.kind !== 'metadata') throw new Error('expected metadata')
    state = reduceSkillCompositeScope(
      state,
      { kind: 'metadata' },
      {
        type: 'begin-submit',
        requestId: 'm1',
        submittedRevision: step.submittedRevision,
      },
    )
    state = editSkillMetadata(state, { description: 'newer', bodyMd: 'body' })
    state = reduceSkillCompositeScope(
      state,
      { kind: 'metadata' },
      {
        type: 'submit-success',
        requestId: 'm1',
        submittedRevision: step.submittedRevision,
        persisted: step.submitted,
      },
    )
    expect(state.metadata.baseline.description).toBe('submitted')
    expect(state.metadata.draft.description).toBe('newer')
    expect(state.metadata.dirty).toBe(true)
  })

  test('authoritative metadata reads follow clean state and expose dirty foreign state as stale', () => {
    let state = createSkillCompositeDraft(content('T1'))
    state = receiveSkillMetadata(state, { description: 'server-2', bodyMd: 'body-2' }, 2)
    expect(state.metadata).toMatchObject({
      baseline: { description: 'server-2', bodyMd: 'body-2' },
      draft: { description: 'server-2', bodyMd: 'body-2' },
      dirty: false,
      lastAcceptedReadEpoch: 2,
    })

    state = editSkillMetadata(state, { description: 'local', bodyMd: 'body-2' })
    state = receiveSkillMetadata(state, { description: 'server-3', bodyMd: 'body-3' }, 3)
    expect(state.metadata).toMatchObject({
      baseline: { description: 'server-2', bodyMd: 'body-2' },
      draft: { description: 'local', bodyMd: 'body-2' },
      dirty: true,
      staleRemote: { description: 'server-3', bodyMd: 'body-3' },
      lastAcceptedReadEpoch: 3,
    })

    const afterOlderRead = receiveSkillMetadata(state, { description: 'older', bodyMd: 'older' }, 1)
    expect(afterOlderRead.metadata).toEqual(state.metadata)
  })
})

describe('RFC-201 Skill stable snapshot', () => {
  test('B content followed by foreign C token is rejected; the whole snapshot is retried', async () => {
    const tokens = ['B', 'B', 'C', 'C', 'C', 'C']
    let contentReads = 0
    let treeReads = 0
    const result = await readStableSkillSnapshot(
      {
        readContent: async () =>
          content(tokens[contentReads++]!, treeReads === 0 ? 'body-B' : 'body-C'),
        readTree: async () => {
          treeReads += 1
          return [{ path: 'a.md', type: 'file' as const }]
        },
        readFile: async () => ({ content: treeReads === 1 ? 'file-B' : 'file-C' }),
      },
      ['a.md'],
    )

    expect(result.kind).toBe('stable')
    if (result.kind !== 'stable') throw new Error('expected stable retry')
    expect(result.attempts).toBe(2)
    expect(result.token).toBe('C')
    expect(result.metadata.bodyMd).toBe('body-C')
    expect(result.files['a.md']).toEqual({ exists: true, content: 'file-C' })
    expect(contentReads).toBe(6)
    expect(treeReads).toBe(2)
  })

  test('never combines B content with C token when no retry is allowed', async () => {
    const tokens = ['B', 'B', 'C']
    let index = 0
    const result = await readStableSkillSnapshot(
      {
        readContent: async () => content(tokens[index++]!),
        readTree: async () => [{ path: 'a.md', type: 'file' as const }],
        readFile: async () => ({ content: 'file-B' }),
      },
      ['a.md'],
      0,
    )
    expect(result).toMatchObject({ kind: 'unstable', tokenBefore: 'B', tokenAfter: 'C' })
  })

  test('two automatic token-change retries means three full attempts, then outcome stays unknown', async () => {
    let n = 0
    const result = await readStableSkillSnapshot(
      {
        readContent: async () => content(`T${++n}`),
        readTree: async () => [],
        readFile: async () => {
          throw { status: 404 }
        },
      },
      ['gone.md'],
    )
    expect(result).toMatchObject({ kind: 'unstable', attempts: 3 })
    expect(n).toBe(9)
  })

  test('a stable delete requires both an absent tree entry and a 404 file read', async () => {
    const result = await readStableSkillSnapshot(
      {
        readContent: async () => content('T2'),
        readTree: async () => [],
        readFile: async () => {
          throw { status: 404 }
        },
      },
      ['gone.md'],
    )
    expect(result.kind).toBe('stable')
    if (result.kind !== 'stable') throw new Error('expected stable snapshot')
    expect(result.files['gone.md']).toEqual({ exists: false, content: '' })
  })
})
