// RFC-615: optional failure evidence must finish before the original test deadline.
import type { RecordedStatement } from './statementRecorder'

export interface G1DiagnosticInput {
  readonly database: { readonly urlEnv: string; readonly databaseName?: string }
  readonly statements: readonly RecordedStatement[]
  readonly samplesMs: readonly number[]
  readonly deadline: number
}

export interface G1DiagnosticChild {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(): void
}

export interface G1DiagnosticResult {
  readonly status: 'complete' | 'failed' | 'timed-out' | 'no-budget'
  readonly records: readonly unknown[]
  readonly error?: string
}

/** Reserve one second for the original comparison/cleanup; diagnostics get at most ten. */
export function g1DiagnosticBudget(deadline: number, now: number): number {
  return Math.max(0, Math.min(10_000, Math.floor(deadline - now - 1_000)))
}

function safeError(error: unknown): string {
  return String(error)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<database URL>')
    .slice(0, 2_000)
}

function launchWorker(payload: string): G1DiagnosticChild {
  const child = Bun.spawn(
    [process.execPath, 'run', `${import.meta.dir}/rfc615G1DiagnosticWorker.ts`],
    {
      stdin: new Blob([payload]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    },
  )
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: () => child.kill('SIGKILL'),
  }
}

/** A separate, killable reader cannot strand a query in the fixture's own pool. */
export async function collectG1PerformanceDiagnostics(
  input: G1DiagnosticInput,
  ports: {
    readonly now?: () => number
    readonly launch?: (payload: string) => G1DiagnosticChild
  } = {},
): Promise<G1DiagnosticResult> {
  const budgetMs = g1DiagnosticBudget(
    input.deadline,
    (ports.now ?? performance.now.bind(performance))(),
  )
  if (budgetMs === 0) return { status: 'no-budget', records: [] }
  let child: G1DiagnosticChild | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stdout = ''
  let stderr = ''
  const read = async (stream: ReadableStream<Uint8Array>, append: (chunk: string) => void) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }))
    append(decoder.decode())
  }
  try {
    child = (ports.launch ?? launchWorker)(JSON.stringify({ ...input, budgetMs }))
    const output = read(child.stdout, (chunk) => {
      stdout += chunk
    })
    const errors = read(child.stderr, (chunk) => {
      stderr += chunk
    })
    const completed = Promise.all([child.exited, output, errors]).then(([code]) => code)
    const code = await Promise.race([
      completed,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs)
      }),
    ])
    if (code === null) child.kill()
    const records: unknown[] = []
    for (const line of stdout.split('\n').filter(Boolean)) {
      try {
        records.push(JSON.parse(line) as unknown)
      } catch {
        if (code !== null) throw new Error('Invalid diagnostic worker output')
        // SIGKILL can interrupt the last JSON record. Earlier records remain useful.
      }
    }
    return {
      status: code === null ? 'timed-out' : code === 0 ? 'complete' : 'failed',
      records,
      ...(stderr ? { error: safeError(stderr) } : {}),
    }
  } catch (error) {
    return { status: 'failed', records: [], error: safeError(error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try {
      child?.kill()
    } catch {
      /* Optional evidence never replaces the original assertion. */
    }
    if (child) {
      // The diagnostic child has no descendants; allow SIGKILL/pipe cleanup a bounded grace.
      let grace: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        child.exited.catch(() => undefined),
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, 250)
        }),
      ])
      if (grace !== undefined) clearTimeout(grace)
    }
  }
}
