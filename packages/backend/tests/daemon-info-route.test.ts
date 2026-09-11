// GET /api/daemon surfaces the daemon's EFFECTIVE binding (the host:port it is
// actually listening on right now), read from the run-info file — deliberately
// distinct from the PERSISTED bindHost/bindPort returned by GET /api/config
// (which is blank for an ephemeral port and is overridden, without being written
// back, by the --host/--port launch flags). Regression guard for the Network
// settings tab "current actual binding" readout: locks the endpoint's presence,
// its null-on-absent behaviour, auth gating, and the shared readDaemonInfo parse.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { readDaemonInfo, type DaemonInfo } from '../src/util/daemonInfo'

const DAEMON_TOKEN = 'a'.repeat(64)

const SAMPLE: DaemonInfo = {
  pid: 4321,
  host: '127.0.0.1',
  port: 52341,
  url: 'http://127.0.0.1:52341/',
  startedAt: '2026-07-08T00:00:00.000Z',
}

const tmpDirs: string[] = []
function tmpInfoFile(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-daemoninfo-'))
  tmpDirs.push(dir)
  const path = join(dir, '.daemon.info')
  if (contents !== null) writeFileSync(path, contents, 'utf-8')
  return path
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

/**
 * 作用域把 `daemonInfoPath` 固定成 `<appHome>/.daemon.info`，而路由是在**请求时**才读这个文件
 * （`routes/daemon.ts` 的 `readDaemonInfo(deps.daemonInfoPath ?? Paths.daemonInfo)`）。
 * 所以「文件在 / 文件不在」两种被测状态，装配完之后写不写这个文件即可，不需要各建一个应用。
 */
async function makeApp(
  scope: ProviderHttpApplicationScope,
  contents: string | null,
): Promise<Hono> {
  const { app, appHome } = await scope.open()
  if (contents !== null) writeFileSync(join(appHome, '.daemon.info'), contents, 'utf-8')
  return app
}

function authedGet(app: Hono, path: string) {
  return app.fetch(
    new Request(`http://d.test${path}`, {
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    }),
  )
}

describe('readDaemonInfo util', () => {
  test('parses a present run-info file', () => {
    expect(readDaemonInfo(tmpInfoFile(JSON.stringify(SAMPLE)))).toEqual(SAMPLE)
  })

  test('returns null when the file is absent', () => {
    expect(readDaemonInfo(join(tmpdir(), 'aw-nope-does-not-exist.info'))).toBeNull()
  })

  test('returns null on garbled JSON rather than throwing', () => {
    expect(readDaemonInfo(tmpInfoFile('{ not json'))).toBeNull()
  })
})

// RFC-359 AC-6：HTTP 面两个引擎各跑一遍（上面那个 describe 是纯函数，保持单跑）。
describeEachProviderHttpApplication(
  'GET /api/daemon',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-daemon-info-',
  },
  (scope) => {
    test('returns the effective binding when the run-info file exists', async () => {
      const app = await makeApp(scope, JSON.stringify(SAMPLE))
      const res = await authedGet(app, '/api/daemon')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(SAMPLE)
    })

    test('returns null (not 500) when the run-info file is absent', async () => {
      const app = await makeApp(scope, null)
      const res = await authedGet(app, '/api/daemon')
      expect(res.status).toBe(200)
      expect(await res.json()).toBeNull()
    })

    test('requires authentication', async () => {
      const app = await makeApp(scope, JSON.stringify(SAMPLE))
      const res = await app.fetch(new Request('http://d.test/api/daemon'))
      expect(res.status).toBe(401)
    })
  },
)
