import type { NativeSpan } from '@/modules/runtime-management/public/participants'
import { spanObject as object, spanId as id, isoSpanTime as time } from '../spanCapture'

export function normalizeClaudeSpans(raw: unknown, root: string): readonly NativeSpan[] {
  const event = object(raw),
    message = object(event?.message)
  if (
    !event ||
    event.session_id !== root ||
    event.isSidechain === true ||
    typeof event.subagent_type === 'string'
  )
    return []
  // Inline sidechain ownership requires an explicit native child session, which this root stream lacks.
  if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) return []
  const observedAt = time(event.timestamp),
    scope = { sessionId: root, parentSessionId: null, ancestors: [], parentCallId: null }
  const spans: NativeSpan[] = []
  for (const value of Array.isArray(message?.content) ? message.content.slice(0, 200) : []) {
    const item = object(value)
    if (event.type === 'assistant' && item?.type === 'tool_use' && id(item.id) && id(item.name))
      spans.push({
        ...scope,
        callId: id(item.id)!,
        kind: 'tool',
        label: id(item.name)!.slice(0, 120),
        origin: 'creation',
        model: null,
        measurementRecordId: null,
        state: {
          startedAt: observedAt,
          endedAt: null,
          nativeObservedAt: observedAt,
          status: 'open',
        },
      })
    if (event.type === 'user' && item?.type === 'tool_result' && id(item.tool_use_id))
      spans.push({
        ...scope,
        callId: id(item.tool_use_id)!,
        kind: 'tool',
        label: 'tool',
        origin: 'completion',
        model: null,
        measurementRecordId: null,
        state: {
          startedAt: null,
          endedAt: observedAt,
          nativeObservedAt: observedAt,
          status: item.is_error === true ? 'error' : 'success',
        },
      })
  }
  if (event.type === 'assistant' && id(message?.id) && object(message?.usage)) {
    const model = id(message?.model)
    spans.push({
      ...scope,
      callId: id(message!.id)!,
      kind: 'model',
      label: model?.slice(0, 120) ?? 'model',
      origin: 'creation',
      model: model ? { provider: null, id: model } : null,
      measurementRecordId: 'claude:message:' + id(message!.id),
      state: { startedAt: null, endedAt: null, nativeObservedAt: observedAt, status: 'unknown' },
    })
  }
  // A cumulative result is neither a request boundary nor proof that every tool ended.
  return spans
}
