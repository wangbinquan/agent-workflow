import {
  openOpencodeUsagePass,
  type NativeUsagePassReader,
} from '@/modules/runtime-management/public/participants'
import type {
  NativeUsagePassWorkerEvent,
  NativeUsagePassWorkerInput,
} from './nativeUsagePassProtocol'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<NativeUsagePassWorkerInput>) => void) | null
  postMessage(value: NativeUsagePassWorkerEvent): void
  close(): void
}
let reader: NativeUsagePassReader | undefined,
  started = false
scope.onmessage = (event) => {
  const { id, request } = event.data
  try {
    if (request.kind === 'open') {
      if (started) throw new Error('Native worker pass already started')
      started = true
      reader = openOpencodeUsagePass(request.input.path, request.input.identity, request.input)
      scope.postMessage({
        id,
        ok: true,
        result: { kind: 'opened', identity: reader.identity, initialCursor: reader.initialCursor },
      })
    } else {
      if (!reader) throw new Error('Native worker has no accepted pass')
      switch (request.kind) {
        case 'next':
          scope.postMessage({
            id,
            ok: true,
            result: { kind: 'page', page: reader.next(request.cursor) },
          })
          break
        case 'ack':
          reader.acknowledge(request.ordinal, request.digest)
          scope.postMessage({ id, ok: true, result: { kind: 'acknowledged' } })
          break
        case 'close':
          reader.close()
          scope.postMessage({ id, ok: true, result: { kind: 'closed' } })
          scope.close()
          break
      }
    }
  } catch (error) {
    try {
      reader?.close()
      scope.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      scope.close()
    }
  }
}
