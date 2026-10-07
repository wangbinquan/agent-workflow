import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { withNativeUsageBaselineSnapshot } from '@/modules/task-execution/public/queries'
import type { NativeUsageBaselineReadView } from '@/modules/task-execution/public/types'
import { originalSqliteFileReportSnapshot } from '../persistence/reportSqliteSnapshot'
import { reportReadonlyChannelClient } from '../persistence/reportReadonlyChannelClient'
import type { OriginalReportSnapshot } from '../persistence/reportSnapshotTypes'
import { observationReportChannel } from './observationReportChannel'
import type {
  NativeUsageBaselineWorkerEvent,
  NativeUsageBaselineWorkerInput,
  NativeUsageBaselineWorkerStart,
} from './nativeUsageBaselineProtocol'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<NativeUsageBaselineWorkerInput>) => void) | null
  postMessage(value: NativeUsageBaselineWorkerEvent): void
}
const stop = new AbortController()
const channel = observationReportChannel((event) => {
  if (event.kind !== 'request') throw new Error('Native baseline channel changed operation')
  scope.postMessage(event)
}, stop.signal)
let started = false,
  ready = false,
  reading = false,
  view: NativeUsageBaselineReadView | null = null,
  closeId: string | undefined,
  release: (() => void) | undefined

async function run(id: string, input: NativeUsageBaselineWorkerStart) {
  const retain = (snapshot: OriginalReportSnapshot) =>
    withNativeUsageBaselineSnapshot({
      snapshots: { run: async (work) => work(snapshot) },
      binding: input.binding,
      original: input.original,
      signal: stop.signal,
      run: async (baseline) => {
        view = baseline
        const wait = new Promise<void>((resolve, reject) => {
          release = resolve
          stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true })
        })
        ready = true
        scope.postMessage({
          kind: 'reply',
          id,
          result: {
            kind: 'opened',
            original: input.original,
            snapshotId: snapshot.snapshotId,
            generationId: snapshot.generationId,
            available: baseline !== null,
          },
        })
        try {
          await wait
        } finally {
          ready = false
          view = null
          release = undefined
        }
      },
    })
  try {
    stop.signal.throwIfAborted()
    selectDatabaseSchemaProvider(input.source.kind === 'sqlite-file' ? 'sqlite' : 'postgresql')
    if (input.source.kind === 'sqlite-file')
      await originalSqliteFileReportSnapshot(input.source).run(retain, stop.signal)
    else
      await retain({
        executor: reportReadonlyChannelClient(channel.read),
        workspace: channel.workspace,
        snapshotId: input.source.snapshotId,
        generationId: input.source.generationId,
        asOf: input.source.asOf,
      })
    if (!closeId) throw new Error('Native baseline snapshot ended without close')
    scope.postMessage({ kind: 'reply', id: closeId, result: { kind: 'closed' } })
  } catch (error) {
    scope.postMessage({
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    channel.close()
    // Bun exits naturally after the original channel closes and its message keepalive is released.
    scope.onmessage = null
  }
}
async function members(id: string, stepIds: readonly string[]) {
  if (!ready || !view || reading || closeId || stepIds.length > 1000)
    throw new Error('Native baseline membership request is not admitted')
  reading = true
  try {
    const found = await view.members(stepIds)
    stop.signal.throwIfAborted()
    scope.postMessage({ kind: 'reply', id, result: { kind: 'members', stepIds: [...found] } })
  } finally {
    reading = false
  }
}
function failed(error: unknown) {
  stop.abort(error)
  channel.close()
  release?.()
  if (!started) scope.onmessage = null
}
scope.onmessage = (event) => {
  try {
    const input = event.data
    if (input.kind === 'response') {
      channel.receive(input)
      return
    }
    if (input.kind === 'cancel') {
      failed(new Error(input.reason))
      return
    }
    if (input.request.kind === 'open') {
      if (started) throw new Error('Native baseline snapshot already started')
      started = true
      void run(input.id, input.request.input).catch(failed)
      return
    }
    if (input.request.kind === 'members') {
      void members(input.id, input.request.stepIds).catch(failed)
      return
    }
    if (!ready || reading || closeId) throw new Error('Native baseline close changed operation')
    closeId = input.id
    release?.()
  } catch (error) {
    failed(error)
  }
}
