// RFC-027 T5 — locks SubagentBlock: collapse default / expand toggle /
// three-level nested rendering / capture-missing fallback. The
// component tree must mirror the data tree at every depth so
// arbitrarily deep `task` chains render without truncation.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { SessionTree } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { ConversationFlow } from '../src/components/node-session/ConversationFlow'

function leaf(text: string): SessionTree {
  return {
    sessionId: `leaf-${text}`,
    parentSessionId: null,
    agentName: null,
    captureComplete: true,
    messages: [{ kind: 'assistant-text', text, ts: 0, messageId: null }],
  }
}

describe('SubagentBlock', () => {
  test('defaults to collapsed — child text not visible until expanded', () => {
    const tree: SessionTree = {
      sessionId: 'root',
      parentSessionId: null,
      agentName: null,
      captureComplete: true,
      messages: [
        {
          kind: 'subagent-call',
          toolName: 'task',
          callId: 'c1',
          status: 'completed',
          input: {},
          output: 'FALLBACK',
          ts: 0,
          messageId: null,
          childSessionId: 'child',
          child: leaf('HIDDEN_BY_DEFAULT'),
          childOutputFallback: 'FALLBACK',
          childAgentName: 'auditor',
        },
      ],
    }
    render(
      <I18nextProvider i18n={i18n}>
        <ConversationFlow tree={tree} />
      </I18nextProvider>,
    )
    expect(screen.queryByText('HIDDEN_BY_DEFAULT')).toBeNull()
  })

  test('clicking the toggle reveals the nested ConversationFlow', () => {
    const tree: SessionTree = {
      sessionId: 'root',
      parentSessionId: null,
      agentName: null,
      captureComplete: true,
      messages: [
        {
          kind: 'subagent-call',
          toolName: 'task',
          callId: 'c1',
          status: 'completed',
          input: {},
          output: null,
          ts: 0,
          messageId: null,
          childSessionId: 'child',
          child: leaf('NOW_VISIBLE'),
          childOutputFallback: null,
          childAgentName: 'auditor',
        },
      ],
    }
    render(
      <I18nextProvider i18n={i18n}>
        <ConversationFlow tree={tree} />
      </I18nextProvider>,
    )
    const toggle = screen.getByRole('button', { expanded: false })
    fireEvent.click(toggle)
    expect(screen.getByText('NOW_VISIBLE')).toBeTruthy()
  })

  test('three-level nesting: expand root + mid + leaf reveals leaf text', () => {
    const leafTree = leaf('DEEPEST_TEXT')
    const midTree: SessionTree = {
      sessionId: 'mid',
      parentSessionId: 'root',
      agentName: null,
      captureComplete: true,
      messages: [
        {
          kind: 'subagent-call',
          toolName: 'task',
          callId: 'c-mid',
          status: 'completed',
          input: {},
          output: null,
          ts: 0,
          messageId: null,
          childSessionId: 'leaf',
          child: leafTree,
          childOutputFallback: null,
          childAgentName: 'leafAgent',
        },
      ],
    }
    const tree: SessionTree = {
      sessionId: 'root',
      parentSessionId: null,
      agentName: null,
      captureComplete: true,
      messages: [
        {
          kind: 'subagent-call',
          toolName: 'task',
          callId: 'c-root',
          status: 'completed',
          input: {},
          output: null,
          ts: 0,
          messageId: null,
          childSessionId: 'mid',
          child: midTree,
          childOutputFallback: null,
          childAgentName: 'midAgent',
        },
      ],
    }
    render(
      <I18nextProvider i18n={i18n}>
        <ConversationFlow tree={tree} />
      </I18nextProvider>,
    )
    expect(screen.queryByText('DEEPEST_TEXT')).toBeNull()
    // Expand root → reveals midAgent block (still collapsed) — DEEPEST is
    // still nested two levels down.
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]!)
    expect(screen.queryByText('DEEPEST_TEXT')).toBeNull()
    // Expand the now-visible mid level → DEEPEST_TEXT lives directly on the
    // leaf SessionTree's assistant-text message, so it surfaces here.
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]!)
    expect(screen.getByText('DEEPEST_TEXT')).toBeTruthy()
  })

  test('capture-missing child shows the fallback output banner when expanded', () => {
    const tree: SessionTree = {
      sessionId: 'root',
      parentSessionId: null,
      agentName: null,
      captureComplete: true,
      messages: [
        {
          kind: 'subagent-call',
          toolName: 'task',
          callId: 'c1',
          status: 'completed',
          input: {},
          output: 'CARRIED_FALLBACK',
          ts: 0,
          messageId: null,
          childSessionId: 'child',
          child: {
            sessionId: 'child',
            parentSessionId: 'root',
            agentName: null,
            captureComplete: false,
            messages: [],
          },
          childOutputFallback: 'CARRIED_FALLBACK',
          childAgentName: null,
        },
      ],
    }
    render(
      <I18nextProvider i18n={i18n}>
        <ConversationFlow tree={tree} />
      </I18nextProvider>,
    )
    expect(screen.getByText(/not captured/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('CARRIED_FALLBACK')).toBeTruthy()
  })

  test('subagent without child (childSessionId=null) shows captureMissing without crashing', () => {
    const tree: SessionTree = {
      sessionId: 'root',
      parentSessionId: null,
      agentName: null,
      captureComplete: true,
      messages: [
        {
          kind: 'subagent-call',
          toolName: 'task',
          callId: 'c1',
          status: 'completed',
          input: {},
          output: null,
          ts: 0,
          messageId: null,
          childSessionId: null,
          child: null,
          childOutputFallback: null,
          childAgentName: null,
        },
      ],
    }
    render(
      <I18nextProvider i18n={i18n}>
        <ConversationFlow tree={tree} />
      </I18nextProvider>,
    )
    expect(screen.getByText(/not captured/i)).toBeTruthy()
  })
})
