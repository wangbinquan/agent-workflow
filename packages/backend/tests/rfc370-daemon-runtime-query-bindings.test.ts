// RFC-370 A1: every real HTTP root reads the selected host binding on demand.
import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DaemonRuntimeQueries } from '../src/modules/system-operations/public/queries'
import type { DaemonRuntimeInfo } from '../src/modules/system-operations/public/types'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const token = 'd'.repeat(64)
const initial: DaemonRuntimeInfo = {
  pid: 818,
  host: 'host.example',
  port: 4100,
  url: 'http://host.example:4100/',
  startedAt: '2026-10-03T00:00:00.000Z',
}

describeEachProviderHttpApplication(
  'RFC-370 selected daemon runtime query',
  { token, dbVersion: 17, opencodeVersion: null, tempPrefix: 'aw-rfc370-host-query-' },
  (scope) => {
    for (const representation of ['own', 'inherited'] as const) {
      test(`${representation} current host query waits for ACK and preserves receiver, null and failure`, async () => {
        const entered = Promise.withResolvers<void>()
        const ack = Promise.withResolvers<void>()
        let current: DaemonRuntimeInfo | null = initial
        let failure: Error | undefined
        let reads = 0
        const read = async (receiver: DaemonRuntimeQueries): Promise<DaemonRuntimeInfo | null> => {
          expect(receiver).toBe(queries)
          reads += 1
          entered.resolve()
          await ack.promise
          if (failure) throw failure
          return current
        }
        class Selection implements DaemonRuntimeQueries {
          get readCurrent() {
            expect<DaemonRuntimeQueries>(this).toBe(queries)
            return async () => read(this)
          }
        }
        const queries: DaemonRuntimeQueries =
          representation === 'own'
            ? {
                readCurrent() {
                  return read(this)
                },
              }
            : Object.freeze(new Selection())
        if (representation === 'inherited') expect(Object.keys(queries)).toEqual([])
        const { app, appHome } = await scope.open({ daemonRuntime: queries })
        writeFileSync(join(appHome, '.daemon.info'), JSON.stringify({ ...initial, pid: 999 }))
        const request = () =>
          Promise.resolve(
            app.request('/api/daemon', {
              headers: { Authorization: `Bearer ${token}` },
            }),
          )
        let settled = false
        const first = request().finally(() => {
          settled = true
        })
        try {
          await Promise.race([
            entered.promise,
            first.then(async (response) => {
              throw new Error(
                `query returned before read ACK: ${response.status} ${await response.clone().text()}`,
              )
            }),
          ])
          expect(settled).toBe(false)
          ack.resolve()
          const response = await first
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual(initial)
          current = { ...initial, port: 4200, url: 'http://host.example:4200/' }
          expect(await (await request()).json()).toEqual(current)
          current = null
          expect(await (await request()).json()).toBeNull()
          failure = new Error('selected host unavailable')
          expect((await request()).status).toBe(500)
          expect(reads).toBe(4)
        } finally {
          ack.resolve()
          await first
        }
      }, 20_000)
    }
  },
)
