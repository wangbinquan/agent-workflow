import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sink = process.env.AW_ADAPTER_SINK
if (sink === undefined) process.exit(2)

const requestedExit = Number(process.env.RFC323_ADAPTER_EXIT_CODE ?? '0')
if (Number.isInteger(requestedExit) && requestedExit > 0) {
  process.stderr.write(
    process.env.RFC323_ADAPTER_STDERR ?? `fixture requested exit ${requestedExit}`,
  )
  process.exit(requestedExit)
}

const observedKeys = [
  'PATH',
  'HOME',
  'TMPDIR',
  'AW_ADAPTER_SINK',
  'AW_PIPELINE_HEAD',
  'AW_PIPELINE_TARGET',
  'AW_PIPELINE_GATES',
  'AW_ADAPTER_CONNECTION_REF',
  'RFC323_ALLOWED_SECRET',
  'RFC323_UNDECLARED_SECRET',
] as const
const observed = Object.fromEntries(observedKeys.map((key) => [key, process.env[key] ?? null]))
writeFileSync(join(sink, 'env.json'), JSON.stringify(observed))
process.stdout.write(
  JSON.stringify({
    protocol: 'aw-adapter@1',
    operation: 'pipeline.collect',
    providerKey: 'env-probe',
    providerHeadSha: process.env.AW_PIPELINE_HEAD ?? null,
    targetSha: process.env.AW_PIPELINE_TARGET ?? null,
    completeness: 'complete',
    gates: [],
    redaction: 'complete',
  }),
)
