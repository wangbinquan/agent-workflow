// RFC-611 / RFC-398: CI takeover children observed a truncated barriers.json, exited with
// JSON Parse error, and left the fixture waiting 180 seconds. Keep atomic reader snapshots
// and immediate exit evidence without treating deliberate parent death or prior retries as failures.
import { expect, test } from 'bun:test'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  publishAutoUpgradeBarriers,
  waitForAutoUpgradeFixture,
  type AutoUpgradeWaitChild,
} from './helpers/rfc398AutoUpgrade'

async function withHooks(run: (hooks: string) => void | Promise<void>): Promise<void> {
  const hooks = mkdtempSync(join(tmpdir(), 'aw-rfc398-fixture-lifecycle-'))
  try {
    await run(hooks)
  } finally {
    rmSync(hooks, { recursive: true, force: true })
  }
}

function childFixture(pid: number) {
  let resolve!: (code: number) => void
  let exitCode: number | null = null
  let expectedExit = false
  const exited = new Promise<number>((accept) => {
    resolve = accept
  }).then((code) => {
    exitCode = code
    return code
  })
  const child: AutoUpgradeWaitChild = {
    process: { pid, exited },
    get exitCode() {
      return exitCode
    },
    get expectedExit() {
      return expectedExit
    },
    output: `child ${pid} checkpoint output`,
    error: `child ${pid} JSON Parse error`,
  }
  return {
    child,
    expectExit() {
      expectedExit = true
    },
    async exit(code: number) {
      resolve(code)
      await exited
    },
  }
}

test('publishing barriers preserves an already-open reader and exposes the complete replacement', async () => {
  await withHooks((hooks) => {
    const path = join(hooks, 'barriers.json')
    const previous = ['startup-before-lock', '完整的旧值']
    const next = ['startup-before-lock@123', 'delegated', 'takeover-acquired']
    publishAutoUpgradeBarriers(hooks, previous)
    const reader = openSync(path, 'r')
    try {
      publishAutoUpgradeBarriers(hooks, next)
      // An in-place truncate/write changes what this already-open reader sees.
      expect(JSON.parse(readFileSync(reader, 'utf8'))).toEqual(previous)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(next)
      expect(readdirSync(hooks)).toEqual(['barriers.json'])
    } finally {
      closeSync(reader)
    }
  })
})

test('a failed barrier publication preserves the destination and removes its temporary file', async () => {
  await withHooks((hooks) => {
    const destination = join(hooks, 'barriers.json')
    mkdirSync(destination)
    writeFileSync(join(destination, 'preserved'), 'original')
    expect(() => publishAutoUpgradeBarriers(hooks, ['delegated'])).toThrow()
    expect(readFileSync(join(destination, 'preserved'), 'utf8')).toBe('original')
    expect(readdirSync(hooks)).toEqual(['barriers.json'])
  })
})

test('an unexpected live child exit fails with its original output before the barrier timeout', async () => {
  await withHooks(async (hooks) => {
    const process = childFixture(123)
    const result = waitForAutoUpgradeFixture(hooks, () => null, [process.child], 2_000).catch(
      (error: unknown) => error,
    )
    await process.exit(1)
    const error = await result
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('child 123 exited unexpectedly with code 1')
    expect((error as Error).message).toContain(process.child.output)
    expect((error as Error).message).toContain(process.child.error)
    expect((error as Error).message).not.toContain('timed out')
  })
})

test('a durable checkpoint that already arrived takes precedence over the child exit', async () => {
  await withHooks(async (hooks) => {
    const process = childFixture(124)
    const checkpoint = { point: 'delegated', pid: 124 }
    let observed: typeof checkpoint | null = null
    const result = waitForAutoUpgradeFixture(hooks, () => observed, [process.child], 2_000)
    observed = checkpoint
    await process.exit(1)
    expect(await result).toBe(checkpoint)
  })
})

for (const exit of ['successful command', 'intentional parent death'] as const) {
  test(`${exit} does not reject a pending takeover wait`, async () => {
    await withHooks(async (hooks) => {
      const process = childFixture(125)
      let checkpoint: string | null = null
      let rejected = false
      const result = waitForAutoUpgradeFixture(hooks, () => checkpoint, [process.child], 2_000)
      void result.catch(() => {
        rejected = true
      })
      if (exit === 'intentional parent death') process.expectExit()
      await process.exit(exit === 'successful command' ? 0 : 137)
      await Promise.resolve()
      expect(rejected).toBe(false)
      checkpoint = 'takeover-acquired'
      writeFileSync(join(hooks, 'takeover-acquired.release'), '')
      expect(await result).toBe('takeover-acquired')
    })
  })
}

test('previous rejected starts do not poison the next retry wait', async () => {
  await withHooks(async (hooks) => {
    const previous = childFixture(126)
    await previous.exit(1)
    const retry = childFixture(127)
    let checkpoint: string | null = null
    let rejected = false
    const result = waitForAutoUpgradeFixture(
      hooks,
      () => checkpoint,
      [previous.child, retry.child],
      2_000,
    )
    void result.catch(() => {
      rejected = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(rejected).toBe(false)
    checkpoint = 'ready'
    await retry.exit(0)
    expect(await result).toBe('ready')
  })
})

test('a settled wait stops reading when a child exits later', async () => {
  await withHooks(async (hooks) => {
    const process = childFixture(128)
    let reads = 0
    expect(
      await waitForAutoUpgradeFixture(
        hooks,
        () => {
          reads += 1
          return 'ready'
        },
        [process.child],
        2_000,
      ),
    ).toBe('ready')
    await process.exit(1)
    expect(reads).toBe(1)
  })
})

test('wait preserves a reader exception and the timeout includes captured stderr', async () => {
  await withHooks(async (hooks) => {
    const original = new Error('invalid checkpoint evidence')
    const failed = waitForAutoUpgradeFixture(
      hooks,
      () => {
        throw original
      },
      [],
      2_000,
    ).catch((error: unknown) => error)
    expect(await failed).toBe(original)

    const process = childFixture(129)
    const timedOut = waitForAutoUpgradeFixture(hooks, () => null, [process.child], 1).catch(
      (error: unknown) => error,
    )
    const error = await timedOut
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('barrier/readiness timed out')
    expect((error as Error).message).toContain(process.child.error)
    await process.exit(1)
  })
})
