import type { NativeSpan } from '@/modules/runtime-management/public/participants'
import { spanObject as object, spanId as id, spanTime as time } from '../spanCapture'

/** Native call identity and state only. Payloads and configured models are never captured. */
export function normalizeOpencodeSpans(raw: unknown, root: string): readonly NativeSpan[] {
  const event = object(raw),
    part = object(event?.part)
  if (!part || event?.sessionID !== root || part.sessionID !== root) return []
  const scope = { sessionId: root, parentSessionId: null, ancestors: [], parentCallId: null }
  if (part.type === 'tool' && id(part.callID) && id(part.tool)) {
    const state = object(part.state),
      boundaries = object(state?.time)
    const start = time(boundaries?.start),
      end = time(boundaries?.end),
      invalid = start !== null && end !== null && end < start
    return [
      {
        ...scope,
        callId: id(part.callID)!,
        kind: 'tool',
        label: id(part.tool)!.slice(0, 120),
        model: null,
        measurementRecordId: null,
        state: {
          startedAt: invalid ? null : start,
          endedAt: invalid ? null : end,
          nativeObservedAt: time(event.timestamp),
          status: invalid
            ? 'unknown'
            : state?.status === 'completed'
              ? 'success'
              : state?.status === 'error'
                ? 'error'
                : state?.status === 'running' || state?.status === 'pending'
                  ? 'open'
                  : 'unknown',
        },
        ...(invalid ? { issues: ['native-span-time-conflict'] } : {}),
      },
    ]
  }
  if (part.type === 'step-finish' && id(part.id))
    return [
      {
        ...scope,
        callId: id(part.id)!,
        kind: 'model',
        label: 'model',
        model: null,
        origin: 'creation',
        measurementRecordId: 'opencode:step:' + id(part.id),
        state: {
          startedAt: null,
          endedAt: null,
          nativeObservedAt: time(event.timestamp),
          status: 'unknown',
        },
      },
    ]
  return []
}
