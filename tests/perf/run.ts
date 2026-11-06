// RFC-054 W3-2 — perf microbenchmark runner.
//
// Times 5 hot-path operations the daemon hits per request / per task /
// per WS frame, runs each in a tight loop, and emits a JSON sample file.
// `diff.ts` then compares two samples and fails the build if any
// operation regressed by more than 20% from the committed baseline.
//
// Run:
//   bun run tests/perf/run.ts                 # prints JSON to stdout
//   bun run tests/perf/run.ts --out /tmp/p.json    # write to file
//
// Refresh baseline:
//   bun run tests/perf/run.ts --out tests/perf/baseline.json
//   (then commit the resulting baseline.json in a dedicated PR)
//
// The 5 microbenchmarks are deliberately small + deterministic — they
// don't spawn subprocesses, don't hit disk beyond mem-fs migrations, and
// don't depend on the network. That keeps shot-to-shot variance below
// the 20% regression gate at the cost of not measuring end-to-end
// latency. End-to-end measurement lives in
// `packages/backend/scripts/perf-sweep.ts` (P-5-12) — kept separate so
// the heavy sweep can run on a release cadence while baseline diffs run
// per-PR.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  detectEnvelopeKind,
  extractLastEnvelope,
  parseEnvelope,
} from '../../packages/shared/src/workflowOutputEnvelope'
import { redactSensitiveString } from '../../packages/backend/src/util/redact'
import { safeJoin } from '../../packages/backend/src/util/safePath'
import { WorkflowDefinitionSchema } from '../../packages/shared/src/schemas/workflow'

interface SampleStats {
  median_ms: number
  p50_ms: number
  p95_ms: number
  iterations: number
}

interface PerfReport {
  schemaVersion: 1
  capturedAt: string
  platform: string
  runtime: string
  samples: Record<string, SampleStats>
}

function nowMs(): number {
  return performance.now()
}

function stats(samplesMs: number[]): SampleStats {
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const p50 = median
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted.at(-1) ?? 0
  return {
    median_ms: round(median),
    p50_ms: round(p50),
    p95_ms: round(p95),
    iterations: samplesMs.length,
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function bench(
  name: string,
  iterations: number,
  fn: () => void,
): { name: string; stats: SampleStats } {
  // Warmup — JIT, cache lines, V8 inlining. 10 iterations is enough for
  // these tight operations on bun's JSC.
  for (let i = 0; i < 10; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = nowMs()
    fn()
    samples.push(nowMs() - t0)
  }
  return { name, stats: stats(samples) }
}

// ---------------------------------------------------------------------------
// Benchmark fixtures
// ---------------------------------------------------------------------------

const SAMPLE_WORKFLOW = {
  $schema_version: 3,
  inputs: [{ kind: 'text' as const, key: 'topic', label: 'Topic', required: true }],
  nodes: [
    { id: 'in_1', kind: 'input' as const, inputKey: 'topic' },
    {
      id: 'agent_1',
      kind: 'agent-single' as const,
      agentName: 'bench-agent',
      promptTemplate: 'Describe {{topic}}.',
    },
    {
      id: 'review_1',
      kind: 'review' as const,
      title: 'Bench review',
    },
    {
      id: 'clarify_1',
      kind: 'clarify' as const,
      title: 'Bench clarify',
    },
    {
      id: 'out_1',
      kind: 'output' as const,
      ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
    },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'in_1', portName: 'topic' },
      target: { nodeId: 'agent_1', portName: 'topic' },
    },
    {
      id: 'e2',
      source: { nodeId: 'agent_1', portName: 'answer' },
      target: { nodeId: 'out_1', portName: 'answer' },
    },
  ],
  outputs: [],
}

const SAMPLE_STDOUT_WITH_ENVELOPE = `
some llm chatter about the task...
<workflow-output>
  <port name="answer">forty-two</port>
  <port name="summary">A concise wrap up of the analysis.</port>
</workflow-output>
trailing whitespace
`

const SAMPLE_NOISY_TEXT = `
2024-05-21 stderr:
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.long-token-string.signature-bytes-here
connecting via postgresql://admin:s3cr3t@db.internal:5432/app — failed
key=ANTHROPIC_API_KEY: sk-ant-api-asdfasdfasdfasdfasdfasdfasdfasdf
secret=hunter2 token=GHU_thelongpattokenhere api_key=zzZZzzZZ
note: redacted authority should NOT appear in the output, but other
content like timestamps and IDs (01H8K… 01H9M…) should pass through.
`

const PERF_ROOT = '/tmp/aw-perf-root'

async function main(): Promise<void> {
  // Pre-create the safeJoin root once — benchmarking the fs check, not
  // the directory creation.
  try {
    mkdirSync(PERF_ROOT, { recursive: true })
  } catch {
    /* exists */
  }

  const results: Array<{ name: string; stats: SampleStats }> = []

  results.push(
    bench('workflow-parse-v3', 200, () => {
      const r = WorkflowDefinitionSchema.safeParse(SAMPLE_WORKFLOW)
      if (!r.success) throw new Error('workflow parse failed')
    }),
  )

  results.push(
    bench('envelope-extract-and-parse', 200, () => {
      const xml = extractLastEnvelope(SAMPLE_STDOUT_WITH_ENVELOPE)
      if (xml === null) throw new Error('envelope not found')
      const kind = detectEnvelopeKind(SAMPLE_STDOUT_WITH_ENVELOPE)
      if (kind !== 'output') throw new Error('wrong envelope kind')
      const parsed = parseEnvelope(xml, ['answer', 'summary'])
      if (parsed.missingDeclared.length !== 0) throw new Error('missing declared port')
    }),
  )

  results.push(
    bench('secret-redact-long-text', 500, () => {
      const out = redactSensitiveString(SAMPLE_NOISY_TEXT)
      if (out.length === 0) throw new Error('redact returned empty')
    }),
  )

  results.push(
    bench('safe-join-clean-path', 1000, () => {
      const r = safeJoin(PERF_ROOT, 'sub/dir/file.txt')
      if (!r.startsWith(PERF_ROOT)) throw new Error('safeJoin escaped root')
    }),
  )

  results.push(
    bench('safe-join-traversal-reject', 1000, () => {
      try {
        safeJoin(PERF_ROOT, '../../etc/passwd')
        throw new Error('expected ValidationError')
      } catch (err) {
        // ValidationError expected — keep loop tight by re-checking
        // by name, not by importing the class (avoids cycle).
        if (!(err instanceof Error) || !err.message.includes('escapes')) {
          throw err
        }
      }
    }),
  )

  const report: PerfReport = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    runtime: `bun-${typeof Bun !== 'undefined' ? Bun.version : 'unknown'}`,
    samples: Object.fromEntries(results.map((r) => [r.name, r.stats])),
  }

  const outArg = process.argv.indexOf('--out')
  if (outArg !== -1 && process.argv[outArg + 1]) {
    const outPath = resolve(process.cwd(), process.argv[outArg + 1]!)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf-8')
    process.stderr.write(`wrote ${outPath}\n`)
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  }
}

await main()
