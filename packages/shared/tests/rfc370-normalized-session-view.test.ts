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

// RFC-370 hosted acceptance (2026-10-18): OpenCode reports a tool once, finished, and CrewStation projects
// that call as a single `tool-end` carrying its input (CS RFC-040). Before, it arrived as a bare start and
// every hosted OpenCode tool rendered as still running with no output.
test('RFC-370 a remote tool reported only once finished renders with its input and result', () => {
  const events = [
    {
      type: 'tool-end',
      data: {
        callId: 'two',
        name: 'bash',
        input: { command: 'ls' },
        output: 'a.ts',
        isError: false,
      },
    },
    {
      type: 'tool-end',
      data: { callId: 'three', name: 'bash', input: { command: 'x' }, isError: true },
    },
  ].map((event, id) => ({
    id,
    ts: id + 20,
    kind: 'tool_use' as const,
    sessionId: 'session',
    parentSessionId: null,
    payload: JSON.stringify({ format: 'aw-normalized-execution-v1', event }),
  }))
  const tree = parseSessionTree({
    rootSessionId: 'session',
    promptText: 'list',
    startedAt: 0,
    primaryAgentName: 'agent',
    events,
  })
  expect(tree.messages.slice(1)).toEqual([
    {
      kind: 'tool-call',
      toolName: 'bash',
      callId: 'two',
      status: 'completed',
      input: { command: 'ls' },
      output: 'a.ts',
      ts: 20,
      messageId: null,
    },
    {
      kind: 'tool-call',
      toolName: 'bash',
      callId: 'three',
      status: 'error',
      input: { command: 'x' },
      output: null,
      ts: 21,
      messageId: null,
    },
  ])
})
