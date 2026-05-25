// RFC-062 PR-A T1 — workflow edge contract regression locks.
//
// These tests pin the public contract that scheduler-v2 + fanout +
// validator rely on. If anyone tries to slim SYSTEM_PORT_NAMES or
// change the filter helpers' semantics, every consumer that gates
// topology on workflow.edges would deadlock workflows containing
// self-clarify or cross-clarify (the 2026-05-25 incident root
// cause).
//
// Add a corresponding test here BEFORE adding a new entry to
// SYSTEM_PORT_NAMES — adding to the set is a contract change.

import { describe, expect, test } from 'bun:test'

import {
  SYSTEM_PORT_NAMES,
  isFeedbackEdge,
  filterDataEdges,
  filterFeedbackEdges,
  type WorkflowEdgeLike,
} from '../src/workflow-edges'

describe('SYSTEM_PORT_NAMES', () => {
  test('contains exactly the two known feedback ports', () => {
    expect(SYSTEM_PORT_NAMES.has('__clarify_response__')).toBe(true)
    expect(SYSTEM_PORT_NAMES.has('__external_feedback__')).toBe(true)
    expect(SYSTEM_PORT_NAMES.size).toBe(2)
  })

  test('does NOT include other __ prefixed builtins (those are prompt-template tokens, not edge targets)', () => {
    for (const name of [
      '__repo_path__',
      '__base_branch__',
      '__task_id__',
      '__node_id__',
      '__iteration__',
      '__shard_key__',
      '__review_rejection__',
      '__review_comments__',
      '__iterate_target_port__',
      '__sibling_outputs__',
      '__clarify__', // SOURCE port (agent → clarify node), not a target
      '__clarify_questions__',
      '__clarify_answers__',
      '__clarify_iteration__',
      '__clarify_remaining__',
      '__external_feedback_iteration__',
      '__external_feedback_sources__',
      '__done__',
    ]) {
      expect(SYSTEM_PORT_NAMES.has(name)).toBe(false)
    }
  })
})

describe('isFeedbackEdge', () => {
  test('true when target.portName is __clarify_response__', () => {
    const e: WorkflowEdgeLike = {
      source: { nodeId: 'clarify_x', portName: 'answers' },
      target: { nodeId: 'agent_y', portName: '__clarify_response__' },
    }
    expect(isFeedbackEdge(e)).toBe(true)
  })

  test('true when target.portName is __external_feedback__', () => {
    const e: WorkflowEdgeLike = {
      source: { nodeId: 'cross_x', portName: 'to_designer' },
      target: { nodeId: 'agent_y', portName: '__external_feedback__' },
    }
    expect(isFeedbackEdge(e)).toBe(true)
  })

  test('false when target.portName is a normal data port', () => {
    const e: WorkflowEdgeLike = {
      source: { nodeId: 'in_a', portName: 'requirement' },
      target: { nodeId: 'agent_y', portName: 'requirement' },
    }
    expect(isFeedbackEdge(e)).toBe(false)
  })

  test('false when target is missing entirely', () => {
    expect(isFeedbackEdge({})).toBe(false)
    expect(isFeedbackEdge({ source: { nodeId: 's', portName: 'p' } })).toBe(false)
  })

  test('false when target.portName is missing', () => {
    expect(isFeedbackEdge({ target: { nodeId: 'n' } })).toBe(false)
  })

  test('false for unknown __ ports — set is closed, not a prefix match', () => {
    expect(
      isFeedbackEdge({
        target: { nodeId: 'n', portName: '__some_future_port__' },
      }),
    ).toBe(false)
  })
})

describe('filterDataEdges / filterFeedbackEdges', () => {
  // The exact edge shape from the 2026-05-25 incident workflow's
  // agent_m7p3n1 inbound edges. Before RFC-062 readyScanner gated on
  // all three, so agent_m7p3n1 was never minted (clarify_400qzp +
  // cross_clarify_6c910f have no `done` row until agent_m7p3n1 first
  // suspends with a clarify signal — a circular wait that deadlocks
  // every cross-clarify workflow).
  const incidentEdges: WorkflowEdgeLike[] = [
    {
      // Data — must gate
      source: { nodeId: 'in_0ck111', portName: 'requirement' },
      target: { nodeId: 'agent_m7p3n1', portName: 'requirement' },
    },
    {
      // Feedback — must NOT gate
      source: { nodeId: 'cross_clarify_6c910f', portName: 'to_designer' },
      target: { nodeId: 'agent_m7p3n1', portName: '__external_feedback__' },
    },
    {
      // Feedback — must NOT gate
      source: { nodeId: 'clarify_400qzp', portName: 'answers' },
      target: { nodeId: 'agent_m7p3n1', portName: '__clarify_response__' },
    },
  ]

  test('filterDataEdges drops feedback edges and preserves order', () => {
    expect(filterDataEdges(incidentEdges)).toEqual([incidentEdges[0]!])
  })

  test('filterFeedbackEdges keeps only feedback edges and preserves order', () => {
    expect(filterFeedbackEdges(incidentEdges)).toEqual([incidentEdges[1]!, incidentEdges[2]!])
  })

  test('filterDataEdges + filterFeedbackEdges partition the input (no edge appears in both, no edge disappears)', () => {
    const data = filterDataEdges(incidentEdges)
    const feedback = filterFeedbackEdges(incidentEdges)
    expect(data.length + feedback.length).toBe(incidentEdges.length)
    for (const e of incidentEdges) {
      const inData = data.includes(e)
      const inFeedback = feedback.includes(e)
      expect(inData !== inFeedback).toBe(true) // exactly one
    }
  })

  test('filterDataEdges on empty input returns empty', () => {
    expect(filterDataEdges([])).toEqual([])
    expect(filterFeedbackEdges([])).toEqual([])
  })

  test('filterDataEdges preserves element identity (helps grep guards downstream)', () => {
    const data = filterDataEdges(incidentEdges)
    expect(data[0]).toBe(incidentEdges[0]) // same reference, not a copy
  })
})
