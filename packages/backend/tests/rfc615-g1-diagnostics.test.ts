import { describe, expect, test } from 'bun:test'
import {
  collectG1PerformanceDiagnostics,
  g1DiagnosticBudget,
  type G1DiagnosticChild,
  type G1DiagnosticInput,
} from './helpers/rfc615G1Diagnostics'

const input: G1DiagnosticInput = {
  database: { urlEnv: 'G1_DIAGNOSTIC_TEST_URL' },
  samplesMs: [1, 2, 3, 4, 5, 6, 7, 8, 900],
  statements: [{ sql: 'SELECT $1', values: [123], params: 1, rows: 1 }],
  deadline: 180_000,
}
const stream = (text: string): ReadableStream<Uint8Array> =>
  new Blob([text]).stream() as ReadableStream<Uint8Array>

describe('RFC-615 G1 optional diagnostics keep the original performance deadline', () => {
  test('the child only receives the remaining bounded budget and exact SQL inputs', async () => {
    let payload: Record<string, unknown> | undefined
    const result = await collectG1PerformanceDiagnostics(input, {
      now: () => 175_000,
      launch: (text) => {
        payload = JSON.parse(text) as Record<string, unknown>
        return {
          stdout: stream('{"kind":"settings"}\n{"kind":"plan"}\n'),
          stderr: stream(''),
          exited: Promise.resolve(0),
          kill() {},
        }
      },
    })
    expect(payload).toMatchObject({
      budgetMs: 4_000,
      database: input.database,
      samplesMs: input.samplesMs,
      statements: input.statements,
    })
    expect(result).toEqual({
      status: 'complete',
      records: [{ kind: 'settings' }, { kind: 'plan' }],
    })
    expect(g1DiagnosticBudget(180_000, 1)).toBe(10_000)
  })

  test('an almost exhausted test does not launch diagnostic work', async () => {
    let launched = false
    const result = await collectG1PerformanceDiagnostics(input, {
      now: () => 179_001,
      launch: () => {
        launched = true
        throw new Error('must not launch')
      },
    })
    expect(launched).toBe(false)
    expect(result).toEqual({ status: 'no-budget', records: [] })
  })

  test('hung children are killed and partial evidence survives a truncated final record', async () => {
    let stopped = false
    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const child: G1DiagnosticChild = {
      stdout: stream('{"kind":"settings","jit":"on"}\n{"kind":'),
      stderr: stream(''),
      exited,
      kill() {
        stopped = true
        resolveExit(137)
      },
    }
    const result = await collectG1PerformanceDiagnostics(input, {
      now: () => 178_980,
      launch: () => child,
    })
    expect(stopped).toBe(true)
    expect(result.status).toBe('timed-out')
    expect(result.records).toEqual([{ kind: 'settings', jit: 'on' }])
  })

  test('launch, worker and decoding failures are evidence, not replacement exceptions', async () => {
    expect(
      (
        await collectG1PerformanceDiagnostics(input, {
          now: () => 0,
          launch: () => {
            throw new Error('spawn unavailable')
          },
        })
      ).status,
    ).toBe('failed')
    for (const [stdout, stderr, code] of [
      ['{"kind":"error"}\n', 'cannot connect postgresql://secret@example/db', 1],
      ['malformed output', '', 0],
    ] as const) {
      const result = await collectG1PerformanceDiagnostics(input, {
        now: () => 0,
        launch: () => ({
          stdout: stream(stdout),
          stderr: stream(stderr),
          exited: Promise.resolve(code),
          kill() {},
        }),
      })
      expect(result.status).toBe('failed')
      expect(JSON.stringify(result)).not.toContain('secret@example')
    }
  })
})
