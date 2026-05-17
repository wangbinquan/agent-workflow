// RFC-027 T3 — locks the opencode-row → NDJSON-event transcoder. This
// is the single point where the SessionTab depends on opencode's
// internal message/part JSON layout (packages/opencode/src/storage/
// session.sql.ts). When opencode bumps schema, this suite catches the
// regression early.

import { describe, expect, test } from 'bun:test'
import { transcodeOpencodeRowsToEvents } from '../src/services/sessionCapture'

describe('transcodeOpencodeRowsToEvents', () => {
  test('assistant text part becomes a `text` event', () => {
    const out = transcodeOpencodeRowsToEvents({
      sessionId: 'child-1',
      messages: [{ id: 'm1', time_created: 100, data: '{"role":"assistant"}' }],
      parts: [
        {
          id: 'p1',
          message_id: 'm1',
          time_created: 110,
          data: '{"type":"text","text":"hello"}',
        },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('text')
    const envelope = JSON.parse(out[0]!.payload)
    expect(envelope.sessionID).toBe('child-1')
    expect(envelope.messageID).toBe('m1')
    expect(envelope.part.type).toBe('text')
    expect(envelope.part.text).toBe('hello')
  })

  test('tool part becomes a `tool_use` event with the `tool_use` envelope type', () => {
    const out = transcodeOpencodeRowsToEvents({
      sessionId: 'child-1',
      messages: [],
      parts: [
        {
          id: 'p1',
          message_id: 'm1',
          time_created: 50,
          data: '{"type":"tool","callID":"c1","tool":"task","metadata":{"sessionID":"grand-1"},"state":{"status":"completed","output":"ok"}}',
        },
      ],
    })
    expect(out[0]!.kind).toBe('tool_use')
    const envelope = JSON.parse(out[0]!.payload)
    expect(envelope.type).toBe('tool_use')
    expect(envelope.part.tool).toBe('task')
    expect(envelope.part.metadata.sessionID).toBe('grand-1')
  })

  test('step-start / step-finish / reasoning parts produce matching event kinds', () => {
    const out = transcodeOpencodeRowsToEvents({
      sessionId: 'child-1',
      messages: [],
      parts: [
        { id: 'p1', message_id: 'm1', time_created: 1, data: '{"type":"step-start"}' },
        {
          id: 'p2',
          message_id: 'm1',
          time_created: 2,
          data: '{"type":"reasoning","text":"thinking"}',
        },
        { id: 'p3', message_id: 'm1', time_created: 3, data: '{"type":"step-finish"}' },
      ],
    })
    expect(out.map((e) => e.kind)).toEqual(['step_start', 'reasoning', 'step_finish'])
  })

  test('unrecognized part types are skipped silently', () => {
    const out = transcodeOpencodeRowsToEvents({
      sessionId: 'child-1',
      messages: [],
      parts: [
        { id: 'p1', message_id: 'm1', time_created: 1, data: '{"type":"file"}' },
        { id: 'p2', message_id: 'm1', time_created: 2, data: '{"type":"text","text":"keep"}' },
        { id: 'p3', message_id: 'm1', time_created: 3, data: 'not json' },
      ],
    })
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0]!.payload).part.text).toBe('keep')
  })

  test('parts are sorted by (time_created, id) for deterministic event ordering', () => {
    const out = transcodeOpencodeRowsToEvents({
      sessionId: 'child-1',
      messages: [],
      parts: [
        { id: 'pB', message_id: 'm1', time_created: 50, data: '{"type":"text","text":"late"}' },
        { id: 'pA', message_id: 'm1', time_created: 50, data: '{"type":"text","text":"early"}' },
      ],
    })
    const texts = out.map((e) => JSON.parse(e.payload).part.text)
    expect(texts).toEqual(['early', 'late'])
  })
})
