// Locks the false-root fix (2026-06): a generic data edge dropped onto a
// clarify/cross-clarify channel system handle must be REJECTED by
// isValidConnection, because buildScopeUpstreams (scheduler.ts) strips every
// edge touching these ports — so a stray drop silently erases the target
// node's real upstream dependency and makes it a FALSE dispatch root
// (premature execution).
//
// Incident: an upstream agent's output was dropped onto a downstream agent's
// `__clarify_response__` handle. The historical inline guard listed
// `__external_feedback__` but OMITTED `__clarify_response__` and `__clarify__`,
// so the drop was accepted and the downstream agent ran before its predecessor.
//
// Guard 1: isStrayClarifyChannelDrop covers EVERY clarify-channel handle name
//          (symmetric — both answer-injection ports + both ask source ports).
// Guard 2: WorkflowCanvas.isValidConnection actually calls it (source-text).

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
} from '@agent-workflow/shared'
import { isStrayClarifyChannelDrop } from '../src/components/canvas/crossClarifyDragHelper'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('isStrayClarifyChannelDrop — clarify-channel stray-drop guard', () => {
  // Every channel handle a generic edge must never land on.
  const REJECTED: Array<[string, { sourceHandle: string | null; targetHandle: string | null }]> = [
    // the regression: questioner answer-injection port (was UNGUARDED)
    [
      'target __clarify_response__',
      { sourceHandle: 'design', targetHandle: '__clarify_response__' },
    ],
    // 2026-06-26 report ("use accepted, not clarify response"): a review node's
    // approval output dropped onto the clarify-answer injection port. The guard
    // keys on the target handle, so the review `accepted` source is rejected the
    // same as any other — locked here to make the review flavor explicit.
    [
      'review accepted → __clarify_response__',
      { sourceHandle: 'accepted', targetHandle: '__clarify_response__' },
    ],
    // ask source port (was UNGUARDED)
    ['source __clarify__', { sourceHandle: '__clarify__', targetHandle: 'context' }],
    // designer answer-injection port (already guarded — no regression)
    [
      'target __external_feedback__',
      { sourceHandle: 'design', targetHandle: '__external_feedback__' },
    ],
    // cross output source ports
    ['source to_questioner', { sourceHandle: 'to_questioner', targetHandle: 'context' }],
    ['source to_designer', { sourceHandle: 'to_designer', targetHandle: 'context' }],
    // clarify/cross input port + answers source
    ['target questions', { sourceHandle: 'design', targetHandle: 'questions' }],
    ['source answers', { sourceHandle: 'answers', targetHandle: 'context' }],
  ]

  for (const [name, conn] of REJECTED) {
    test(`rejects stray drop: ${name}`, () => {
      expect(isStrayClarifyChannelDrop(conn)).toBe(true)
    })
  }

  test('allows a normal output → input data edge', () => {
    expect(isStrayClarifyChannelDrop({ sourceHandle: 'design', targetHandle: 'topic' })).toBe(false)
  })

  test('allows a drop carrying no handles (null/null)', () => {
    expect(isStrayClarifyChannelDrop({ sourceHandle: null, targetHandle: null })).toBe(false)
  })

  test('the two false-root incident ports are in the rejected set', () => {
    // Belt-and-suspenders against a future edit that drops a constant from the
    // guard: assert via the shared constants (not string literals).
    expect(
      isStrayClarifyChannelDrop({
        sourceHandle: null,
        targetHandle: CLARIFY_RESPONSE_TARGET_PORT_NAME,
      }),
    ).toBe(true)
    expect(
      isStrayClarifyChannelDrop({ sourceHandle: CLARIFY_SOURCE_PORT_NAME, targetHandle: null }),
    ).toBe(true)
    expect(
      isStrayClarifyChannelDrop({
        sourceHandle: null,
        targetHandle: CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
      }),
    ).toBe(true)
  })

  test('the shared planner wires the guard used by isValidConnection', () => {
    const planner = readFileSync(
      path.resolve(here, '../src/lib/workflow-connection-plan.ts'),
      'utf-8',
    )
    expect(planner).toContain('isStrayClarifyChannelDrop({')
    const canvas = readFileSync(
      path.resolve(here, '../src/components/canvas/WorkflowCanvas.tsx'),
      'utf-8',
    )
    expect(canvas).toContain('planWorkflowConnection(definition, request, semanticContext)')
  })
})
