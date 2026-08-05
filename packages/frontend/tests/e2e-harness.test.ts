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
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'vitest'

import { harnessTestApi, type DaemonHandle, type SpawnOptions } from '../../../e2e/harness'

const fixtureRoots: string[] = []

// RFC-254 T28b — the harness now resolves ONE compiled stub instead of taking a
// path per call, and it refuses to start when that artifact is missing OR is
// not executable. These tests never launch a real daemon, so rather than
// requiring `bun run build:binary:e2e` before `bun run test` they point the
// override at a throwaway file that is BOTH — pointing it at a source file
// satisfied the old existence-only check and stopped satisfying the real one.
// Created ONCE at module load, before any test swaps TMPDIR: `withHarnessTmp`
// repoints TMPDIR at the fixture's `homes` directory and a sibling assertion
// requires that directory to end up empty, so minting this inside a test would
// leave a stray entry there.
const stubRoot = mkdtempSync(join(tmpdir(), 'aw-harness-stub-'))
const stubOverride = (() => {
  const dir = stubRoot
  const path = join(dir, 'stub-opencode')
  writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(path, 0o755)
  return path
})()

// RFC-254 T32: the fake daemon is handed over as a COMMAND ARRAY
// (`[process.execPath, script]`) rather than as a fake executable. A
// `#!/usr/bin/env node` file is only runnable where a shebang is honoured, so
// on Windows this fixture used to die with `spawn EFTYPE` and three tests
// reported a harness bug that did not exist. Passing argv means no shebang, no
// execute bit, no shell — and it exercises the same harness code path on every
// platform. See SpawnOptions.binary in e2e/harness.ts.
function createFixture(binaryBody: string): {
  root: string
  homes: string
  binary: string[]
} {
  const root = mkdtempSync(join(tmpdir(), 'aw-harness-vitest-'))
  fixtureRoots.push(root)
  const homes = join(root, 'homes')
  const script = join(root, 'fake-daemon.cjs')
  mkdirSync(homes)
  writeFileSync(script, binaryBody, 'utf8')
  return { root, homes, binary: [process.execPath, script] }
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

async function startDaemonForTest(opts: SpawnOptions): Promise<DaemonHandle> {
  let nextPort = 45_000
  const previous = process.env.AGENT_WORKFLOW_E2E_STUB
  process.env.AGENT_WORKFLOW_E2E_STUB = stubOverride
  try {
    return await harnessTestApi.startDaemonWithPortAllocator(
      { ...opts, authMode: opts.authMode ?? 'bootstrap' },
      async () => nextPort++,
    )
  } finally {
    if (previous === undefined) delete process.env.AGENT_WORKFLOW_E2E_STUB
    else process.env.AGENT_WORKFLOW_E2E_STUB = previous
  }
}

afterAll(() => {
  rmSync(stubRoot, { recursive: true, force: true })
})

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

    await expect(withHarnessTmp(homes, () => startDaemonForTest({ binary }))).rejects.toThrow(
      'intentional startup failure',
    )
    expect(readdirSync(homes)).toEqual([])
  })

  test('preserves a caller-owned recovery home when startup fails', async () => {
    const { root, binary } = createFixture(`
process.stderr.write('intentional recovery startup failure\\n')
process.exit(1)
`)
    const externalHome = join(root, 'existing-home')
    mkdirSync(externalHome)

    await expect(startDaemonForTest({ binary, home: externalHome })).rejects.toThrow(
      'intentional recovery startup failure',
    )
    expect(existsSync(externalHome)).toBe(true)
  })
})
