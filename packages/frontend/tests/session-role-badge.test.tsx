// RFC-027 §UX revision — locks the per-role visual treatment so future
// refactors can't strip the colored role pills back to plain text.
// Asserts each of user / assistant / tool / subagent renders a
// `.session-role-badge--<variant>` element with the role label inside,
// plus the per-role class on the parent `.session-block`.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { SessionTree } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { ConversationFlow } from '../src/components/node-session/ConversationFlow'

function wrap(tree: SessionTree) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ConversationFlow tree={tree} />
    </I18nextProvider>,
  )
}

describe('RFC-027 role-badge UX', () => {
  test('user role renders a .session-role-badge--user pill containing the User label', () => {
    wrap({
      sessionId: 's',
      parentSessionId: null,
      agentName: null,
      captureComplete: true,
      messages: [{ kind: 'user', text: 'hi', ts: 0 }],
    })
    const badge = document.querySelector('.session-role-badge--user')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('User')
    // Block also carries the per-role modifier class.
    expect(document.querySelector('.session-block--user')).not.toBeNull()
  })

  test('assistant role renders a .session-role-badge--assistant pill', () => {
    wrap({
      sessionId: 's',
      parentSessionId: null,
      agentName: null,
      captureComplete: true,
      messages: [{ kind: 'assistant-text', text: 'hi', ts: 0, messageId: null }],
    })
    expect(document.querySelector('.session-role-badge--assistant')).not.toBeNull()
    expect(document.querySelector('.session-block--assistant')).not.toBeNull()
  })

  test('tool role renders a .session-role-badge--tool pill + tool-name chip + status chip', () => {
    wrap({
      sessionId: 's',
      parentSessionId: null,
      agentName: null,
      captureComplete: true,
      messages: [
        {
          kind: 'tool-call',
          toolName: 'read_file',
          callId: 'c1',
          status: 'completed',
          input: {},
          output: 'ok',
          ts: 0,
          messageId: null,
        },
      ],
    })
    expect(document.querySelector('.session-role-badge--tool')).not.toBeNull()
    expect(document.querySelector('.session-block__tool-name')?.textContent).toBe('read_file')
    expect(document.querySelector('.status-chip--success')).not.toBeNull()
  })

  test('subagent role renders a .session-role-badge--subagent pill on its card', () => {
    wrap({
      sessionId: 's',
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
          child: {
            sessionId: 'child',
            parentSessionId: 's',
            agentName: 'auditor',
            captureComplete: true,
            messages: [],
          },
          childOutputFallback: null,
          childAgentName: 'auditor',
        },
      ],
    })
    expect(document.querySelector('.session-role-badge--subagent')).not.toBeNull()
    // Subagent toggle keeps its expand label for a11y.
    const toggle = screen.getByRole('button', { expanded: false })
    expect(toggle.getAttribute('aria-label')).toMatch(/expand/i)
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { expanded: true }).getAttribute('aria-label')).toMatch(
      /collapse/i,
    )
  })

  test('all four role pill variants are distinct classes (no accidental aliasing)', () => {
    wrap({
      sessionId: 's',
      parentSessionId: null,
      agentName: null,
      captureComplete: true,
      messages: [
        { kind: 'user', text: 'hi', ts: 0 },
        { kind: 'assistant-text', text: 'hi', ts: 1, messageId: null },
        {
          kind: 'tool-call',
          toolName: 'bash',
          callId: 'c1',
          status: 'completed',
          input: {},
          output: 'ok',
          ts: 2,
          messageId: null,
        },
        {
          kind: 'subagent-call',
          toolName: 'task',
          callId: 'c2',
          status: 'completed',
          input: {},
          output: null,
          ts: 3,
          messageId: null,
          childSessionId: 'c',
          child: null,
          childOutputFallback: null,
          childAgentName: null,
        },
      ],
    })
    const classes = ['user', 'assistant', 'tool', 'subagent']
    for (const v of classes) {
      expect(document.querySelector(`.session-role-badge--${v}`)).not.toBeNull()
    }
  })
})
