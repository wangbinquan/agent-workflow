import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { requireWorkPathWithoutSymlinks } from '@/platform/crewstation/workVolumePath'
import { retainWorkVolumeWriter } from '@/platform/crewstation/workVolumeWriters'
import { runManagedProcess } from '@/platform/execution/local/managedProcess'
import type {
  EvidenceStagingNamespace,
  EvidenceStagingReference,
} from '@/modules/development-automation/public/types'
import { createLocalDevelopmentAdapterEffects } from '../infrastructure/local/developmentAdapterProgram'
import { developmentAdapterContentSchema } from '../domain/developmentAdapterDefinition'
import type { AdapterProcessObservation } from '../application/ports/developmentAdapterEffects'
import { sha256Hex } from '@/util/hash'

const text = z.string()
const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('acquire'), externalId: text }),
  z.object({ kind: z.literal('questions.writeback'), externalId: text, questionsJson: text }),
  z.object({ kind: z.literal('answers.collect'), externalId: text, correlationRef: text }),
  z.object({
    kind: z.literal('pipeline.collect'),
    headSha: text,
    targetSha: text,
    gateKeysCsv: text,
  }),
  z.object({
    kind: z.literal('pipeline.trigger'),
    headSha: text,
    gateKeysCsv: text,
    idempotencyKey: text,
  }),
  z.object({
    kind: z.literal('pipeline.rerun'),
    runRef: text,
    gateKey: text,
    headSha: text,
    idempotencyKey: text,
  }),
  z.object({
    kind: z.literal('approval.submit'),
    stepRunRef: text,
    draftRef: text,
    deadlineAt: text,
    idempotencyKey: text,
    intentDigest: text,
  }),
  z.object({ kind: z.literal('approval.lookup'), idempotencyKey: text }),
  z.object({ kind: z.literal('approval.observe'), correlationRef: text }),
])
const Request = z.discriminatedUnion('method', [
  z.object({ method: z.literal('prepare'), configuration: developmentAdapterContentSchema }),
  z.object({
    method: z.literal('run'),
    configuration: developmentAdapterContentSchema,
    path: text,
    id: z.string().regex(/^[a-f0-9]{64}$/),
    operation,
  }),
])

/** Frozen environment secrets are resolved inside the platform task image,
 * never serialized into an AW command request or returned to the control plane. */
export async function executeTaskImageDevelopmentAdapter(
  value: unknown,
  signal: AbortSignal | undefined,
  root: string,
): Promise<unknown> {
  const input = Request.parse(value)
  const namespace: EvidenceStagingNamespace = { kind: 'evidence-staging-namespace', reference: {} }
  const stage: EvidenceStagingReference = { kind: 'evidence-staging', namespace, reference: {} }
  const path = input.method === 'run' ? requireWorkPathWithoutSymlinks(input.path, root) : root
  const runRoot =
    input.method === 'run'
      ? requireWorkPathWithoutSymlinks(join(root, 'adapter-runs', input.id), root)
      : undefined
  const digest = sha256Hex(JSON.stringify(input))
  if (runRoot !== undefined) {
    try {
      const result = JSON.parse(readFileSync(join(runRoot, 'result.json'), 'utf8')) as {
        digest: string
        result: AdapterProcessObservation
      }
      if (result.digest !== digest) throw new Error('hosted-adapter-retry-request-changed')
      return result.result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const native = createLocalDevelopmentAdapterEffects({
    namespace,
    resolveStaging: (ref) => {
      if (ref !== stage) throw new Error('hosted-adapter-stage-owner-mismatch')
      return path
    },
    async execute(request) {
      if (input.method !== 'run') throw new Error('hosted-adapter-prepare-cannot-execute')
      const writer = retainWorkVolumeWriter(root, `adapter:${input.id}`, path)
      // The compiled AW executable cannot interpret a separate JS/TS program.
      // The platform's Bun task base provides the actual interpreter.
      const argv =
        request.argv[0] === process.execPath &&
        /\.(?:ts|js|mjs|cjs)$/.test(input.configuration.executableRef)
          ? ['bun', ...request.argv.slice(1)]
          : request.argv
      const result = await runManagedProcess({
        argv,
        cwd: request.cwd,
        env: { ...request.env },
        timeoutMs: request.timeoutMs,
        signal,
        captureRawStdout: true,
        requireSpawnReceipt: true,
        onSpawned: (receipt) => writer.spawned(receipt),
      })
      if (result.outcome === 'child-unkillable') throw new Error('hosted-adapter-writer-unreaped')
      writer.release()
      if (result.outcome === 'aborted') throw new Error('hosted-adapter-aborted')
      if (result.outcome === 'spawn-failed') return { kind: 'unavailable' }
      if (result.outcome === 'timeout') return { kind: 'expired' }
      // Preserve the existing 256 KiB overflow signal (the policy rejects > cap).
      const stdout = Buffer.from(result.rawStdout)
        .subarray(0, 256 * 1024 + 1)
        .toString('utf8')
      return { kind: 'completed', stdout, exitCode: result.exitCode ?? -1 }
    },
  })
  const configuration = native.configurationFor({
    adapterContent: input.configuration,
    secretSource: process.env,
  })
  const bound = await native.requirement.programs.bind(configuration)
  if (input.method === 'prepare') return bound.ok ? { ok: true } : bound
  if (!bound.ok) throw new Error(bound.failure.code)
  mkdirSync(path, { recursive: true })
  const common = { program: bound.program, staging: stage }
  const op = input.operation
  let result: AdapterProcessObservation
  switch (op.kind) {
    case 'acquire':
      result = await native.requirement.acquire({ ...common, ...op })
      break
    case 'questions.writeback':
      result = await native.requirement.questionsWriteback({ ...common, ...op })
      break
    case 'answers.collect':
      result = await native.requirement.answersCollect({ ...common, ...op })
      break
    case 'pipeline.collect':
      result = await native.pipeline.collect({ ...common, ...op })
      break
    case 'pipeline.trigger':
      result = await native.pipeline.trigger({ ...common, ...op })
      break
    case 'pipeline.rerun':
      result = await native.pipeline.rerun({ ...common, ...op })
      break
    case 'approval.submit':
      result = await native.approval.submit({ ...common, ...op })
      break
    case 'approval.lookup':
      result = await native.approval.lookup({ ...common, ...op })
      break
    case 'approval.observe':
      result = await native.approval.observe({ ...common, ...op })
      break
  }
  mkdirSync(runRoot!, { recursive: true })
  writeFileSync(join(runRoot!, 'result.json.tmp'), JSON.stringify({ digest, result }))
  renameSync(join(runRoot!, 'result.json.tmp'), join(runRoot!, 'result.json'))
  return result
}
