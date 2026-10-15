import { expect, test } from 'bun:test'
import { parseSessionTree } from '../src/sessionView'

test('RFC-370 normalized remote events render text and paired tools without native CLI payloads', () => {
  const events = [
    { type: 'text', data: { text: 'hello ' } },
    { type: 'text', data: { text: 'world' } },
    { type: 'tool-start', data: { callId: 'one', name: 'read', input: { path: 'file' } } },
    { type: 'tool-end', data: { callId: 'one', name: 'read', output: 'contents', isError: false } },
  ].map((event, id) => ({
    id,
    ts: id + 10,
    kind: event.type === 'text' ? ('text' as const) : ('tool_use' as const),
    sessionId: 'session',
    parentSessionId: null,
    payload: JSON.stringify({ format: 'aw-normalized-execution-v1', event }),
  }))
  const tree = parseSessionTree({
    rootSessionId: 'session',
    promptText: 'read file',
    startedAt: 0,
    primaryAgentName: 'agent',
    events,
  })
  expect(tree.messages).toEqual([
    { kind: 'user', text: 'read file', ts: 0 },
    { kind: 'assistant-text', text: 'hello world', ts: 10, messageId: 'normalized-stream' },
    {
      kind: 'tool-call',
      toolName: 'read',
      callId: 'one',
      status: 'completed',
      input: { path: 'file' },
      output: 'contents',
      ts: 12,
      messageId: null,
    },
  ])
})
