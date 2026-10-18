// RFC-377 locks child-slot rendering and RoleBadge while removing the component import cycle.
// The collapsed state must not mount children; expanded markup keeps fallback then nested flow.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { SessionSubagentCall, SessionTree } from '@agent-workflow/shared'
import type { ReactNode } from 'react'
import i18n from '../src/i18n'
import { ConversationFlow } from '../src/components/node-session/ConversationFlow'
import { SubagentBlock } from '../src/components/node-session/SubagentBlock'
import { RoleBadge, type RoleVariant } from '../src/components/node-session/RoleBadge'

function tree(messages: SessionTree['messages']): SessionTree {
  return {
    sessionId: 'session',
    parentSessionId: null,
    agentName: null,
    captureComplete: true,
    messages,
  }
}

function call(child: SessionTree | null): SessionSubagentCall {
  return {
    kind: 'subagent-call',
    toolName: 'task',
    callId: 'call',
    status: 'completed',
    input: {},
    output: null,
    ts: 0,
    messageId: null,
    childSessionId: child?.sessionId ?? null,
    child,
    childOutputFallback: 'CAPTURE_FALLBACK',
    childAgentName: 'auditor',
  }
}

function wrap(content: ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{content}</I18nextProvider>)
}

describe('RFC-377 recursive session rendering', () => {
  test('SubagentBlock mounts children only when open, after fallback content', () => {
    let renders = 0
    function Child() {
      renders += 1
      return <p>INJECTED_CHILD</p>
    }
    const { container } = wrap(
      <SubagentBlock call={call(null)}>
        <Child />
      </SubagentBlock>,
    )
    expect(renders).toBe(0)
    expect(container.querySelector('.session-subagent__body')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(renders).toBe(1)
    const body = container.querySelector('.session-subagent__body')
    expect(body?.firstElementChild?.textContent).toContain('CAPTURE_FALLBACK')
    expect(body?.lastElementChild).toBe(screen.getByText('INJECTED_CHILD'))
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByText('INJECTED_CHILD')).toBeNull()
  })

  test('SubagentBlock without children does not render call.child on its own', () => {
    const child = tree([{ kind: 'assistant-text', text: 'NOT_A_SLOT', ts: 0, messageId: null }])
    const { container } = wrap(<SubagentBlock call={call(child)} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(container.querySelector('.session-subagent__body')).not.toBeNull()
    expect(container.querySelector('.session-flow')).toBeNull()
    expect(screen.queryByText('NOT_A_SLOT')).toBeNull()
  })

  test('ConversationFlow puts the nested flow last in the expanded body', () => {
    const child = {
      ...tree([{ kind: 'assistant-text' as const, text: 'CHILD_MESSAGE', ts: 0, messageId: null }]),
      captureComplete: false,
    }
    const { container } = wrap(<ConversationFlow tree={tree([call(child)])} />)
    expect(container.querySelector('.session-flow--nested')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const body = container.querySelector('.session-subagent__body')
    const nested = container.querySelector('.session-flow.session-flow--nested')
    expect(nested).not.toBeNull()
    expect(body?.lastElementChild).toBe(nested)
    expect(body?.firstElementChild?.textContent).toContain('CAPTURE_FALLBACK')
    expect(nested?.textContent).toContain('CHILD_MESSAGE')
  })

  test('an empty nested tree keeps its empty state in the child slot', () => {
    const { container } = wrap(<ConversationFlow tree={tree([call(tree([]))])} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const empty = container.querySelector('.session-flow__empty')
    expect(empty?.textContent).toBe(i18n.t('session.empty'))
    expect(container.querySelector('.session-subagent__body')?.lastElementChild).toBe(empty)
  })

  test.each<RoleVariant>(['user', 'assistant', 'reasoning', 'tool', 'subagent'])(
    'RoleBadge preserves the %s variant and decorative icon',
    (variant) => {
      const { container } = render(<RoleBadge variant={variant} icon="🤖" label="ROLE_LABEL" />)
      const badge = container.querySelector(`.session-role-badge.session-role-badge--${variant}`)
      expect(badge?.querySelector('.session-role-badge__label')?.textContent).toBe('ROLE_LABEL')
      const icon = badge?.querySelector('.session-role-badge__icon')
      expect(icon?.textContent).toBe('🤖')
      expect(icon?.getAttribute('aria-hidden')).toBe('true')
    },
  )
})
