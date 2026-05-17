// RFC-027: locks SessionTreeSchema acceptance rules. The schema is the
// wire contract for GET /api/tasks/:id/node-runs/:nodeRunId/session;
// changes that loosen it must be intentional and reflected here.

import { describe, expect, test } from 'bun:test'
import { SessionTreeSchema, SessionViewResponseSchema } from '../src/schemas/sessionView'

const leafTree = {
  sessionId: 'child',
  parentSessionId: 'root',
  agentName: 'subagent',
  messages: [{ kind: 'assistant-text' as const, text: 'hi', ts: 1, messageId: null }],
  captureComplete: true,
}

const rootTree = {
  sessionId: 'root',
  parentSessionId: null,
  agentName: 'coder',
  messages: [
    { kind: 'user' as const, text: 'go', ts: 0 },
    {
      kind: 'subagent-call' as const,
      toolName: 'task',
      callId: 'c1',
      status: 'completed' as const,
      input: { subagent_type: 'auditor' },
      output: 'audit done',
      ts: 5,
      messageId: 'm1',
      childSessionId: 'child',
      child: leafTree,
      childOutputFallback: 'audit done',
      childAgentName: 'auditor',
    },
  ],
  captureComplete: true,
}

describe('SessionTreeSchema', () => {
  test('accepts a fully populated nested tree', () => {
    const parsed = SessionTreeSchema.parse(rootTree)
    expect(parsed.messages).toHaveLength(2)
    if (parsed.messages[1].kind !== 'subagent-call') throw new Error('expected subagent-call')
    expect(parsed.messages[1].child?.sessionId).toBe('child')
  })

  test('accepts tree with no messages and captureComplete=false', () => {
    const tree = {
      sessionId: 's',
      parentSessionId: null,
      agentName: null,
      messages: [],
      captureComplete: false,
    }
    expect(() => SessionTreeSchema.parse(tree)).not.toThrow()
  })

  test('rejects subagent-call missing the childOutputFallback field', () => {
    const bad = {
      ...rootTree,
      messages: [
        ...rootTree.messages.slice(0, 1),
        { ...(rootTree.messages[1] as Record<string, unknown>), childOutputFallback: undefined },
      ],
    }
    expect(() => SessionTreeSchema.parse(bad)).toThrow()
  })

  test('SessionViewResponseSchema wraps a tree under .tree', () => {
    const parsed = SessionViewResponseSchema.parse({ tree: rootTree })
    expect(parsed.tree.messages).toHaveLength(2)
  })
})
