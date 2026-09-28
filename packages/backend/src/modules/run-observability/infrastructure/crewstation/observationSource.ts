import { timeoutSignal } from '@/util/timeoutSignal'
import {
  PlatformObservationPageSchema,
  PlatformObservationSourceError,
} from '../../domain/platformObservation'
import type { PlatformObservationSource } from '../../ports/platformObservationSource'

/** One deadline covers each async phase, including adapters that ignore a signal. */
function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    const finish = () => signal.removeEventListener('abort', abort)
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return work()
      })
      .then(
        (value) => {
          finish()
          resolve(value)
        },
        (error: unknown) => {
          finish()
          reject(error)
        },
      )
  })
}

/** Bootstrap supplies the platform endpoint and existing service identity mechanism. */
export function createCrewStationObservationSource(input: {
  readonly baseUrl: string
  readonly headers: () => Promise<NonNullable<RequestInit['headers']>>
  readonly request?: (url: URL, init: RequestInit) => Promise<Response>
  readonly timeoutMs?: number
}): PlatformObservationSource {
  const request = input.request ?? fetch
  const timeoutMs = input.timeoutMs ?? 15_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new RangeError('Observation timeout must be 1 through 60000ms')
  return {
    async read(query) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500)
        throw new RangeError('Observation page limit must be 1 through 500')
      if (
        query.mode === 'snapshot' &&
        ((query.snapshotId === undefined) !== (query.cursor === undefined) ||
          query.snapshotId === '' ||
          query.cursor === '')
      )
        throw new RangeError('Snapshot continuation needs both opaque identifiers')
      const url = new URL(
        '/v3/business-tasks/' + encodeURIComponent(query.taskId) + '/observations',
        input.baseUrl,
      )
      url.searchParams.set('limit', String(query.limit))
      if (query.mode === 'incremental') {
        if (query.after !== undefined) url.searchParams.set('after', query.after)
      } else {
        url.searchParams.set('snapshot', 'true')
        if (query.snapshotId !== undefined) url.searchParams.set('snapshotId', query.snapshotId)
        if (query.cursor !== undefined) url.searchParams.set('cursor', query.cursor)
      }
      query.signal?.throwIfAborted()
      const deadline = timeoutSignal(timeoutMs)
      const signal = query.signal
        ? AbortSignal.any([query.signal, deadline.signal])
        : deadline.signal
      try {
        let response: Response
        try {
          const headers = await abortable(input.headers, signal)
          response = await abortable(() => request(url, { method: 'GET', headers, signal }), signal)
        } catch {
          if (query.signal?.aborted) throw query.signal.reason
          throw new PlatformObservationSourceError(
            'unavailable',
            'Platform observation source is unavailable',
          )
        }
        if (!response.ok) {
          const code =
            response.status === 401 || response.status === 403
              ? 'access-unavailable'
              : response.status === 409 || response.status === 410
                ? 'snapshot-required'
                : response.status === 404
                  ? 'source-not-found'
                  : response.status === 501
                    ? 'capability-unavailable'
                    : 'unavailable'
          throw new PlatformObservationSourceError(
            code,
            'Platform observation response ' + response.status,
          )
        }
        let body: unknown
        try {
          body = await abortable(() => response.json(), signal)
        } catch (error) {
          if (query.signal?.aborted) throw query.signal.reason
          if (signal.aborted || !(error instanceof SyntaxError))
            throw new PlatformObservationSourceError(
              'unavailable',
              'Platform observation body is unavailable',
            )
          throw new PlatformObservationSourceError(
            'invalid-response',
            'Platform observation body is not valid JSON',
          )
        }
        const parsed = PlatformObservationPageSchema.safeParse(body)
        if (
          !parsed.success ||
          parsed.data.projectId !== query.projectId ||
          parsed.data.taskId !== query.taskId ||
          parsed.data.mode !== query.mode ||
          (query.mode === 'snapshot' &&
            query.snapshotId !== undefined &&
            parsed.data.mode === 'snapshot' &&
            parsed.data.snapshotId !== query.snapshotId)
        )
          throw new PlatformObservationSourceError(
            'invalid-response',
            'Platform observation page does not match the requested contract',
          )
        return parsed.data
      } finally {
        deadline.cancel()
      }
    },
  }
}
