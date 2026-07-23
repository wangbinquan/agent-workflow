// RFC-198 — the browser harness must not turn a rare loopback-port race into a
// leaked daemon/home or a flaky CI shard. These tests use a short-lived fake
// binary, so they exercise the Node harness lifecycle without starting the real
// agent-workflow daemon or touching a developer's existing process.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

import { harnessTestApi, type DaemonHandle, type SpawnOptions } from '../../../e2e/harness'

const here = dirname(fileURLToPath(import.meta.url))
const stubOpencode = resolve(here, '../../../e2e/fixtures/stub-opencode.sh')
const fixtureRoots: string[] = []

function createFixture(binaryBody: string): {
  root: string
  homes: string
  binary: string
} {
  const root = mkdtempSync(join(tmpdir(), 'aw-harness-vitest-'))
  fixtureRoots.push(root)
  const homes = join(root, 'homes')
  const binary = join(root, 'fake-daemon.cjs')
  mkdirSync(homes)
  writeFileSync(binary, `#!/usr/bin/env node\n${binaryBody}`, 'utf8')
  chmodSync(binary, 0o755)
  return { root, homes, binary }
}

async function withHarnessTmp<T>(homes: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR
  process.env.TMPDIR = homes
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
}

function startDaemonForTest(opts: SpawnOptions): Promise<DaemonHandle> {
  let nextPort = 45_000
  return harnessTestApi.startDaemonWithPortAllocator(
    { ...opts, authMode: opts.authMode ?? 'bootstrap' },
    async () => nextPort++,
  )
}

afterEach(() => {
  while (fixtureRoots.length > 0) {
    rmSync(fixtureRoots.pop()!, { recursive: true, force: true })
  }
})

describe('e2e harness startup lifecycle', () => {
  test('retries two EADDRINUSE starts, then removes its owned home on stop', async () => {
    const { root, homes, binary } = createFixture(`
const fs = require('node:fs')
const stateFile = process.env.HARNESS_ATTEMPT_FILE
const attempt = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, 'utf8')) + 1 : 1
fs.writeFileSync(stateFile, String(attempt))
if (attempt < 3) {
  process.stderr.write('listen EADDRINUSE: address already in use\\n')
  process.exit(1)
}
const port = process.argv.at(-1)
process.stdout.write('agent-workflow ready — open this URL in your browser:\\n')
process.stdout.write('  http://127.0.0.1:' + port + '/?token=ABC123\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1_000)
`)
    const attemptFile = join(root, 'attempts.txt')
    let handle: DaemonHandle | undefined

    try {
      handle = await withHarnessTmp(homes, () =>
        startDaemonForTest({
          binary,
          stubOpencode,
          extraEnv: { HARNESS_ATTEMPT_FILE: attemptFile },
        }),
      )

      expect(readFileSync(attemptFile, 'utf8')).toBe('3')
      expect(existsSync(handle.home)).toBe(true)
      expect(handle.token).toBe('ABC123')
      expect(handle.bootstrapToken).toBe('ABC123')
      await handle.stop()
      expect(existsSync(handle.home)).toBe(false)
      handle = undefined
    } finally {
      if (handle !== undefined) await handle.stop()
    }
  })

  test('removes a self-created home when the child closes before ready', async () => {
    const { homes, binary } = createFixture(`
process.stderr.write('intentional startup failure\\n')
process.exit(1)
`)

    await expect(
      withHarnessTmp(homes, () => startDaemonForTest({ binary, stubOpencode })),
    ).rejects.toThrow('intentional startup failure')
    expect(readdirSync(homes)).toEqual([])
  })

  test('preserves a caller-owned recovery home when startup fails', async () => {
    const { root, binary } = createFixture(`
process.stderr.write('intentional recovery startup failure\\n')
process.exit(1)
`)
    const externalHome = join(root, 'existing-home')
    mkdirSync(externalHome)

    await expect(startDaemonForTest({ binary, stubOpencode, home: externalHome })).rejects.toThrow(
      'intentional recovery startup failure',
    )
    expect(existsSync(externalHome)).toBe(true)
  })
})
