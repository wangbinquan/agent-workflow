// RFC-111 SessionTab-parity fix — locks parseSessionTree's Claude Code dialect.
//
// Why this suite exists: claude-code node_runs persist raw stream-json stdout
// lines / transcript JSONL lines verbatim into node_run_events.payload, but
// parseSessionTree only understood opencode's `{part: {...}}` envelope — every
// claude event was skipped (`part` undefined) and the Session tab rendered an
// empty conversation for claude runs (user report 2026-07-07). Fixture shapes
// below are modeled 1:1 on a real `claude -p --output-format stream-json
// --verbose` probe against claude 2.1.202 (assistant events arrive one per
// content block; subagent turns inline with parent_tool_use_id; async Agent
// completion via system/task_started + task_notification) and on real
// `projects/<slug>/<sid>/subagents/agent-*.jsonl` transcript lines.

import { describe, expect, test } from 'bun:test'
import { parseSessionTree, type ParseSessionInputEvent } from '../src/sessionView'

let nextId = 0
function evt(
  partial: Partial<ParseSessionInputEvent> & { payload: object | string },
): ParseSessionInputEvent {
  nextId += 1
  const payload =
    typeof partial.payload === 'string' ? partial.payload : JSON.stringify(partial.payload)
  return {
    id: partial.id ?? nextId,
    ts: partial.ts ?? nextId * 10,
    kind: partial.kind ?? 'text',
    sessionId: partial.sessionId === undefined ? 'root' : partial.sessionId,
    parentSessionId: partial.parentSessionId ?? null,
    payload,
  }
}

/** Root-session stream-json rows as the stdout pump persists them. */
function streamAssistant(opts: {
  ts?: number
  kind?: string
  msgId: string
  block: Record<string, unknown>
  parentToolUseId?: string
}): ParseSessionInputEvent {
  return evt({
    ...(opts.ts !== undefined ? { ts: opts.ts } : {}),
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    payload: {
      type: 'assistant',
      message: { id: opts.msgId, type: 'message', role: 'assistant', content: [opts.block] },
      parent_tool_use_id: opts.parentToolUseId ?? null,
      session_id: 'root-uuid',
      uuid: `uuid-${nextId + 1}`,
    },
  })
}

function streamToolResult(opts: {
  ts?: number
  toolUseId: string
  content: unknown
  isError?: boolean
  toolUseResult?: Record<string, unknown>
}): ParseSessionInputEvent {
  return evt({
    ...(opts.ts !== undefined ? { ts: opts.ts } : {}),
    kind: 'tool_use',
    payload: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: opts.toolUseId,
            content: opts.content,
            ...(opts.isError === true ? { is_error: true } : {}),
          },
        ],
      },
      parent_tool_use_id: null,
      ...(opts.toolUseResult !== undefined ? { tool_use_result: opts.toolUseResult } : {}),
      session_id: 'root-uuid',
    },
  })
}

const baseInput = {
  rootSessionId: 'root',
  promptText: null as string | null,
  startedAt: null as number | null,
  primaryAgentName: 'coder',
}

describe('parseSessionTree — claude stream-json root session', () => {
  test('regression lock: claude rows render blocks instead of being skipped as part=undefined', () => {
    const tree = parseSessionTree({
      ...baseInput,
      promptText: 'do the thing',
      startedAt: 5,
      events: [
        streamAssistant({
          ts: 10,
          kind: 'reasoning',
          msgId: 'msg_1',
          block: { type: 'thinking', thinking: 'let me think', signature: 'sig' },
        }),
        streamAssistant({
          ts: 20,
          kind: 'text',
          msgId: 'msg_1',
          block: { type: 'text', text: 'Reading the file now.' },
        }),
      ],
    })
    expect(tree.messages).toHaveLength(3)
    expect(tree.messages[0]).toMatchObject({ kind: 'user', text: 'do the thing' })
    expect(tree.messages[1]).toMatchObject({
      kind: 'assistant-reasoning',
      text: 'let me think',
      messageId: 'msg_1',
    })
    expect(tree.messages[2]).toMatchObject({
      kind: 'assistant-text',
      text: 'Reading the file now.',
      messageId: 'msg_1',
    })
  })

  test('tool_use + string tool_result fold into one completed tool-call', () => {
    const tree = parseSessionTree({
      ...baseInput,
      events: [
        streamAssistant({
          ts: 10,
          kind: 'tool_use',
          msgId: 'msg_1',
          block: {
            type: 'tool_use',
            id: 'toolu_read',
            name: 'Read',
            input: { file_path: '/x/target.txt' },
            caller: { type: 'direct' },
          },
        }),
        streamToolResult({
          ts: 20,
          toolUseId: 'toolu_read',
          content: '1\tprobe-file-content-42\n2\t',
          toolUseResult: { type: 'text', file: { filePath: '/x/target.txt' } },
        }),
      ],
    })
    expect(tree.messages).toHaveLength(1)
    expect(tree.messages[0]).toMatchObject({
      kind: 'tool-call',
      toolName: 'Read',
      callId: 'toolu_read',
      status: 'completed',
      input: { file_path: '/x/target.txt' },
      output: '1\tprobe-file-content-42\n2\t',
    })
  })

  test('tool_result array-of-text content flattens; is_error → status error', () => {
    const tree = parseSessionTree({
      ...baseInput,
      events: [
        streamAssistant({
          ts: 10,
          msgId: 'msg_1',
          block: { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'false' } },
        }),
        streamToolResult({
          ts: 20,
          toolUseId: 'toolu_b',
          isError: true,
          content: [
            { type: 'text', text: 'line one' },
            { type: 'text', text: 'line two' },
          ],
        }),
      ],
    })
    expect(tree.messages[0]).toMatchObject({
      kind: 'tool-call',
      status: 'error',
      output: 'line one\nline two',
    })
  })

  test('tool_result sorted before its tool_use still folds (Codex review P2)', () => {
    // A result row carrying its own ISO timestamp can sort before the
    // tool_use row stamped with the pump's arrival Date.now() (ms-level
    // skew across the two clocks/sources). It must be held pending and
    // folded once the call appears, not silently dropped.
    const tree = parseSessionTree({
      ...baseInput,
      events: [
        streamToolResult({ ts: 10, toolUseId: 'toolu_early', content: 'early result' }),
        streamAssistant({
          ts: 20,
          msgId: 'msg_1',
          block: { type: 'tool_use', id: 'toolu_early', name: 'Bash', input: { command: 'x' } },
        }),
      ],
    })
    expect(tree.messages).toHaveLength(1)
    expect(tree.messages[0]).toMatchObject({
      kind: 'tool-call',
      callId: 'toolu_early',
      status: 'completed',
      output: 'early result',
    })
  })

  test('system / result / rate_limit_event / attachment rows render nothing', () => {
    const tree = parseSessionTree({
      ...baseInput,
      promptText: 'p',
      events: [
        evt({
          kind: 'step_start',
          payload: {
            type: 'system',
            subtype: 'init',
            session_id: 'root-uuid',
            model: 'claude-haiku-4-5',
          },
        }),
        evt({
          kind: 'step_start',
          payload: { type: 'system', subtype: 'status', status: null, session_id: 'root-uuid' },
        }),
        evt({
          kind: 'step_start',
          payload: {
            type: 'system',
            subtype: 'thinking_tokens',
            estimated_tokens: 12,
            session_id: 'root-uuid',
          },
        }),
        evt({
          kind: 'step_start',
          payload: {
            type: 'system',
            subtype: 'hook_started',
            hook_name: 'SessionStart',
            session_id: 'root-uuid',
          },
        }),
        evt({
          kind: 'text',
          payload: {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'allowed' },
            session_id: 'root-uuid',
          },
        }),
        evt({
          kind: 'step_finish',
          payload: {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'MAIN-DONE',
            session_id: 'root-uuid',
            usage: {},
          },
        }),
        evt({
          kind: 'text',
          payload: {
            type: 'attachment',
            attachment: { type: 'queued_command' },
            sessionId: 'sub-uuid',
          },
        }),
      ],
    })
    expect(tree.messages).toHaveLength(1)
    expect(tree.messages[0]).toMatchObject({ kind: 'user', text: 'p' })
  })

  test('two different text blocks under the same message id both render (per-block events)', () => {
    const tree = parseSessionTree({
      ...baseInput,
      events: [
        streamAssistant({ ts: 10, msgId: 'msg_1', block: { type: 'text', text: 'first block' } }),
        streamAssistant({ ts: 20, msgId: 'msg_1', block: { type: 'text', text: 'second block' } }),
        streamAssistant({ ts: 30, msgId: 'msg_1', block: { type: 'text', text: '' } }), // empty skipped
      ],
    })
    expect(tree.messages.map((m) => (m.kind === 'assistant-text' ? m.text : '?'))).toEqual([
      'first block',
      'second block',
    ])
  })
})

describe('parseSessionTree — claude subagents (async Agent lane, probe-shaped)', () => {
  const AGENT_INPUT = {
    description: 'subagent task',
    prompt: 'Reply with exactly SUB-DONE. Do not use any tools.',
    subagent_type: 'general-purpose',
  }

  function asyncAgentEvents(): ParseSessionInputEvent[] {
    return [
      streamAssistant({
        ts: 50,
        kind: 'tool_use',
        msgId: 'msg_2',
        block: { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: AGENT_INPUT },
      }),
      evt({
        ts: 55,
        kind: 'step_start',
        payload: {
          type: 'system',
          subtype: 'task_started',
          task_id: 'a6d5d39e7',
          tool_use_id: 'toolu_agent',
          description: 'subagent task',
          subagent_type: 'general-purpose',
          task_type: 'local_agent',
          prompt: AGENT_INPUT.prompt,
          session_id: 'root-uuid',
        },
      }),
      // async launch ack — placeholder metadata, must NOT complete the call
      streamToolResult({
        ts: 60,
        toolUseId: 'toolu_agent',
        content: [
          {
            type: 'text',
            text: 'Async agent launched successfully. agentId: a6d5d39e7 (internal ID - do not mention)',
          },
        ],
        toolUseResult: {
          agentId: 'a6d5d39e7',
          isAsync: true,
          status: 'in_progress',
          description: 'subagent task',
        },
      }),
      // inline subagent turns, tagged with parent_tool_use_id
      streamAssistant({
        ts: 65,
        kind: 'reasoning',
        msgId: 'msg_sub1',
        block: { type: 'thinking', thinking: 'trivial ask', signature: 's' },
        parentToolUseId: 'toolu_agent',
      }),
      streamAssistant({
        ts: 70,
        kind: 'text',
        msgId: 'msg_sub1',
        block: { type: 'text', text: 'SUB-DONE' },
        parentToolUseId: 'toolu_agent',
      }),
      evt({
        ts: 75,
        kind: 'step_start',
        payload: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'a6d5d39e7',
          tool_use_id: 'toolu_agent',
          status: 'completed',
          summary: 'Subagent replied SUB-DONE',
          session_id: 'root-uuid',
        },
      }),
      streamAssistant({
        ts: 80,
        kind: 'text',
        msgId: 'msg_3',
        block: { type: 'text', text: 'MAIN-DONE' },
      }),
    ]
  }

  test('inline subagent rows re-bucket under agent-<taskId>; call completes via task_notification', () => {
    const tree = parseSessionTree({
      ...baseInput,
      promptText: 'orchestrate',
      events: asyncAgentEvents(),
    })

    // root: user, subagent-call, trailing MAIN-DONE — inline sub turns are NOT in root
    expect(tree.messages.map((m) => m.kind)).toEqual(['user', 'subagent-call', 'assistant-text'])
    const call = tree.messages[1]!
    if (call.kind !== 'subagent-call') throw new Error('expected subagent-call')
    expect(call.toolName).toBe('Agent')
    expect(call.childAgentName).toBe('general-purpose')
    expect(call.childSessionId).toBe('agent-a6d5d39e7')
    // async: launch-ack junk suppressed; completion + summary from task_notification
    expect(call.status).toBe('completed')
    expect(call.output).toBe('Subagent replied SUB-DONE')
    expect(call.childOutputFallback).toBe('Subagent replied SUB-DONE')

    // child tree: synthesized user prompt (from task_started) + reasoning + text
    const child = call.child
    expect(child).not.toBeNull()
    expect(child!.captureComplete).toBe(true)
    expect(child!.parentSessionId).toBe('root')
    expect(child!.agentName).toBe('general-purpose')
    expect(child!.messages.map((m) => m.kind)).toEqual([
      'user',
      'assistant-reasoning',
      'assistant-text',
    ])
    expect(child!.messages[0]).toMatchObject({ kind: 'user', text: AGENT_INPUT.prompt })
    expect(child!.messages[2]).toMatchObject({ kind: 'assistant-text', text: 'SUB-DONE' })
  })

  test('post-run transcript capture rows dedup against the inline stream rows', () => {
    // transcript lines for the same subagent, as captureClaudeSessions persists
    // them: sessionId=agent-<id>, parent=root, per-block message lines with the
    // SAME message ids, plus the initial user-prompt line (content is a string).
    const transcriptRows: ParseSessionInputEvent[] = [
      evt({
        ts: 63,
        kind: 'tool_use', // capture kinds are coarse — parser must ignore them
        sessionId: 'agent-a6d5d39e7',
        parentSessionId: 'root',
        payload: {
          type: 'user',
          isSidechain: true,
          agentId: 'a6d5d39e7',
          sessionId: 'sub-uuid',
          timestamp: '2026-07-07T04:51:00.000Z',
          message: { role: 'user', content: AGENT_INPUT.prompt },
        },
      }),
      evt({
        ts: 66,
        kind: 'reasoning',
        sessionId: 'agent-a6d5d39e7',
        parentSessionId: 'root',
        payload: {
          type: 'assistant',
          isSidechain: true,
          agentId: 'a6d5d39e7',
          sessionId: 'sub-uuid',
          message: {
            id: 'msg_sub1',
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'trivial ask', signature: 's' }],
          },
        },
      }),
      evt({
        ts: 71,
        kind: 'text',
        sessionId: 'agent-a6d5d39e7',
        parentSessionId: 'root',
        payload: {
          type: 'assistant',
          isSidechain: true,
          agentId: 'a6d5d39e7',
          sessionId: 'sub-uuid',
          message: {
            id: 'msg_sub1',
            role: 'assistant',
            content: [{ type: 'text', text: 'SUB-DONE' }],
          },
        },
      }),
    ]
    const tree = parseSessionTree({
      ...baseInput,
      promptText: 'orchestrate',
      events: [...asyncAgentEvents(), ...transcriptRows],
    })
    const call = tree.messages[1]!
    if (call.kind !== 'subagent-call') throw new Error('expected subagent-call')
    const child = call.child!
    // exactly one prompt / one thinking / one SUB-DONE — live + captured folded
    expect(child.messages.map((m) => m.kind)).toEqual([
      'user',
      'assistant-reasoning',
      'assistant-text',
    ])
    expect(child.messages.filter((m) => m.kind === 'user')).toHaveLength(1)
  })

  test('sync Agent lane: real tool_result completes the call; agentId from toolUseResult claims the captured bucket', () => {
    const events: ParseSessionInputEvent[] = [
      streamAssistant({
        ts: 10,
        msgId: 'msg_1',
        block: {
          type: 'tool_use',
          id: 'toolu_sync',
          name: 'Task',
          input: { description: 'd', prompt: 'sub p', subagent_type: 'Explore' },
        },
      }),
      // sync completion — transcript-dialect toolUseResult (camelCase) with agentId
      evt({
        ts: 20,
        kind: 'tool_use',
        payload: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_sync',
                content: [{ type: 'text', text: 'final sub answer' }],
              },
            ],
          },
          toolUseResult: {
            agentId: 'sync1',
            agentType: 'Explore',
            status: 'completed',
            content: [],
          },
          session_id: 'root-uuid',
        },
      }),
      evt({
        ts: 15,
        kind: 'text',
        sessionId: 'agent-sync1',
        parentSessionId: 'root',
        payload: {
          type: 'assistant',
          isSidechain: true,
          agentId: 'sync1',
          message: {
            id: 'msg_s',
            role: 'assistant',
            content: [{ type: 'text', text: 'working…' }],
          },
        },
      }),
    ]
    const tree = parseSessionTree({ ...baseInput, events })
    expect(tree.messages.map((m) => m.kind)).toEqual(['subagent-call'])
    const call = tree.messages[0]!
    if (call.kind !== 'subagent-call') throw new Error('expected subagent-call')
    expect(call.toolName).toBe('Task')
    expect(call.status).toBe('completed')
    expect(call.output).toBe('final sub answer')
    expect(call.childSessionId).toBe('agent-sync1')
    expect(call.child!.messages).toEqual([
      expect.objectContaining({ kind: 'assistant-text', text: 'working…' }),
    ])
  })

  test('depth-2 nesting: grandchild hangs off the child bucket, not duplicated as a root orphan', () => {
    const events: ParseSessionInputEvent[] = [
      streamAssistant({
        ts: 10,
        msgId: 'msg_1',
        block: {
          type: 'tool_use',
          id: 'tu_child',
          name: 'Agent',
          input: { subagent_type: 'general-purpose', prompt: 'child prompt' },
        },
      }),
      evt({
        ts: 11,
        kind: 'step_start',
        payload: {
          type: 'system',
          subtype: 'task_started',
          task_id: 'child1',
          tool_use_id: 'tu_child',
          prompt: 'child prompt',
          session_id: 'root-uuid',
        },
      }),
      // child's own turns (inline, ptid = tu_child) — including spawning the grandchild
      streamAssistant({
        ts: 20,
        msgId: 'msg_c1',
        block: { type: 'thinking', thinking: 'plan', signature: 's' },
        parentToolUseId: 'tu_child',
      }),
      streamAssistant({
        ts: 30,
        msgId: 'msg_c2',
        block: {
          type: 'tool_use',
          id: 'tu_grand',
          name: 'Agent',
          input: { subagent_type: 'Explore', prompt: 'grand prompt' },
        },
        parentToolUseId: 'tu_child',
      }),
      evt({
        ts: 31,
        kind: 'step_start',
        payload: {
          type: 'system',
          subtype: 'task_started',
          task_id: 'grand1',
          tool_use_id: 'tu_grand',
          prompt: 'grand prompt',
          session_id: 'root-uuid',
        },
      }),
      streamAssistant({
        ts: 40,
        msgId: 'msg_g1',
        block: { type: 'text', text: 'GRAND-DONE' },
        parentToolUseId: 'tu_grand',
      }),
      evt({
        ts: 50,
        kind: 'step_start',
        payload: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'grand1',
          tool_use_id: 'tu_grand',
          status: 'completed',
          summary: 'grand ok',
          session_id: 'root-uuid',
        },
      }),
      evt({
        ts: 51,
        kind: 'step_start',
        payload: {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'child1',
          tool_use_id: 'tu_child',
          status: 'completed',
          summary: 'child ok',
          session_id: 'root-uuid',
        },
      }),
    ]
    const tree = parseSessionTree({ ...baseInput, events })
    // root has exactly the child call — no orphan placeholder for the grandchild
    expect(tree.messages.map((m) => m.kind)).toEqual(['subagent-call'])
    const child = tree.messages[0]!
    if (child.kind !== 'subagent-call') throw new Error('expected subagent-call')
    expect(child.childSessionId).toBe('agent-child1')
    expect(child.status).toBe('completed')
    const childTree = child.child!
    const grand = childTree.messages.find((m) => m.kind === 'subagent-call')
    expect(grand).toBeDefined()
    if (grand!.kind !== 'subagent-call') throw new Error('expected subagent-call')
    expect(grand!.childSessionId).toBe('agent-grand1')
    expect(grand!.status).toBe('completed')
    expect(grand!.child!.parentSessionId).toBe('agent-child1')
    expect(grand!.child!.messages).toEqual([
      expect.objectContaining({ kind: 'user', text: 'grand prompt' }),
      expect.objectContaining({ kind: 'assistant-text', text: 'GRAND-DONE' }),
    ])
  })

  test('capture-only child (no tool_use / task_started) still surfaces via the RFC-048 orphan pass', () => {
    const tree = parseSessionTree({
      ...baseInput,
      promptText: 'p',
      events: [
        evt({
          ts: 20,
          kind: 'tool_use',
          sessionId: 'agent-orphan9',
          parentSessionId: 'root',
          payload: {
            type: 'user',
            isSidechain: true,
            agentId: 'orphan9',
            message: { role: 'user', content: 'orphan prompt' },
          },
        }),
        evt({
          ts: 30,
          kind: 'text',
          sessionId: 'agent-orphan9',
          parentSessionId: 'root',
          payload: {
            type: 'assistant',
            isSidechain: true,
            agentId: 'orphan9',
            message: {
              id: 'msg_o',
              role: 'assistant',
              content: [{ type: 'text', text: 'orphan says hi' }],
            },
          },
        }),
      ],
    })
    const orphan = tree.messages.find((m) => m.kind === 'subagent-call')
    expect(orphan).toBeDefined()
    if (orphan!.kind !== 'subagent-call') throw new Error('expected subagent-call')
    expect(orphan!.childSessionId).toBe('agent-orphan9')
    expect(orphan!.child!.messages).toEqual([
      expect.objectContaining({ kind: 'user', text: 'orphan prompt' }),
      expect.objectContaining({ kind: 'assistant-text', text: 'orphan says hi' }),
    ])
  })
})
