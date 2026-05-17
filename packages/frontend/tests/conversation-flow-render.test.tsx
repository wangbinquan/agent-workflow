// RFC-027 T5 — locks ConversationFlow rendering: user / assistant text
// / tool-call render with role labels + body. Subagent nesting is
// covered in subagent-block-nested.test.tsx.

import { render, screen } from '@testing-library/react'
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

describe('ConversationFlow', () => {
  test('renders user + assistant blocks with role labels and body text', () => {
    wrap({
      sessionId: 's',
      parentSessionId: null,
      agentName: 'coder',
      captureComplete: true,
      messages: [
        { kind: 'user', text: 'HELLO_USER', ts: 1000 },
        { kind: 'assistant-text', text: 'HELLO_ASSISTANT', ts: 2000, messageId: 'm1' },
      ],
    })
    expect(screen.getByText('User')).toBeTruthy()
    expect(screen.getByText('Assistant')).toBeTruthy()
    expect(screen.getByText('HELLO_USER')).toBeTruthy()
    expect(screen.getByText('HELLO_ASSISTANT')).toBeTruthy()
  })

  test('renders tool-call with toolName + status chip + output details', () => {
    wrap({
      sessionId: 's',
      parentSessionId: null,
      agentName: 'coder',
      captureComplete: true,
      messages: [
        {
          kind: 'tool-call',
          toolName: 'read_file',
          callId: 'c1',
          status: 'completed',
          input: { path: 'x.ts' },
          output: 'OUTPUT_LINE',
          ts: 0,
          messageId: 'm1',
        },
      ],
    })
    expect(screen.getAllByText(/Tool call/i).length).toBeGreaterThan(0)
    expect(screen.getByText('read_file')).toBeTruthy()
    // Output details open by default — body should be in DOM.
    expect(screen.getByText('OUTPUT_LINE')).toBeTruthy()
  })

  test('empty messages renders the muted "empty" hint', () => {
    wrap({
      sessionId: 's',
      parentSessionId: null,
      agentName: 'coder',
      captureComplete: true,
      messages: [],
    })
    expect(screen.getByText(/No session events recorded/i)).toBeTruthy()
  })

  test('renders assistant-reasoning collapsed by default with thinking summary', () => {
    wrap({
      sessionId: 's',
      parentSessionId: null,
      agentName: 'coder',
      captureComplete: true,
      messages: [
        {
          kind: 'assistant-reasoning',
          text: 'THINK_BODY',
          ts: 1000,
          messageId: 'm1',
        },
      ],
    })
    // Role badge label visible
    expect(screen.getByText('Thinking')).toBeTruthy()
    // Summary mentions the char count
    expect(screen.getByText(/thinking · 10 chars/i)).toBeTruthy()
    // Body lives inside a <details> — closed by default. The text exists in
    // the DOM but the surrounding <details> has open=false.
    const detailsList = document.querySelectorAll('details')
    expect(detailsList.length).toBeGreaterThan(0)
    const reasoningDetails = Array.from(detailsList).find((d) =>
      (d.textContent ?? '').includes('THINK_BODY'),
    )
    expect(reasoningDetails).toBeTruthy()
    expect(reasoningDetails!.hasAttribute('open')).toBe(false)
  })

  test('multiple message kinds preserve order in the DOM', () => {
    wrap({
      sessionId: 's',
      parentSessionId: null,
      agentName: 'coder',
      captureComplete: true,
      messages: [
        { kind: 'user', text: 'FIRST', ts: 0 },
        {
          kind: 'tool-call',
          toolName: 'bash',
          callId: 'c1',
          status: 'completed',
          input: { cmd: 'ls' },
          output: 'MIDDLE',
          ts: 1,
          messageId: 'm1',
        },
        { kind: 'assistant-text', text: 'LAST', ts: 2, messageId: 'm2' },
      ],
    })
    const html = document.body.innerHTML
    const first = html.indexOf('FIRST')
    const middle = html.indexOf('MIDDLE')
    const last = html.indexOf('LAST')
    expect(first).toBeGreaterThan(-1)
    expect(middle).toBeGreaterThan(first)
    expect(last).toBeGreaterThan(middle)
  })
})
