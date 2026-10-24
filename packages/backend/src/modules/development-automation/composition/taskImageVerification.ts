import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { utf16MaxLength } from '@agent-workflow/shared'
import { runManagedProcess } from '@/platform/execution/local/managedProcess'
import {
  releaseCompletedWorkVolumeWriter,
  retainWorkVolumeWriter,
} from '@/platform/crewstation/workVolumeWriters'
import { createRepoScriptResolver } from '../infrastructure/local/verificationCommandEffects'
import { requireEvidenceWorkPath } from './taskImageEvidence'
import { verificationStepSchema } from '../domain/verificationProfile'
import { assertEvidenceRelativePath } from '../infrastructure/crewstation/evidenceArtifacts'
import { sha256Hex } from '@/util/hash'
import { readVerificationEnvironment } from '../infrastructure/local/verificationEnvironment'

const Request = z.discriminatedUnion('method', [
  z.object({ method: z.literal('environment'), path: z.string() }),
  z.object({
    method: z.literal('behavior'),
    path: z.string(),
    id: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
    programRef: z.string(),
    inputJson: z.string().check(utf16MaxLength(1024 * 1024)),
    timeoutMs: z.number().int().positive().max(300_000),
  }),
  z.object({
    method: z.literal('resolve'),
    path: z.string(),
    programRef: z.string(),
    argsRef: z.string().nullable(),
  }),
  z.object({
    method: z.literal('run'),
    path: z.string(),
    id: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
    step: verificationStepSchema,
  }),
  z.object({
    method: z.literal('collect'),
    path: z.string(),
    pattern: z.string().check(utf16MaxLength(500)),
  }),
  z.object({
    method: z.literal('dispose'),
    id: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
  }),
])
export interface HostedVerificationReceipt {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly outputFile: string | null
}

export async function executeTaskImageVerification(
  value: unknown,
  signal: AbortSignal | undefined,
  root: string,
): Promise<unknown> {
  const input = Request.parse(value)
  const resolver = createRepoScriptResolver()
  const directory =
    'id' in input
      ? requireEvidenceWorkPath(join(root, 'verification-runs', input.id), root)
      : undefined
  if (input.method === 'dispose') {
    // An incomplete command never has a final receipt and must be retained.
    readFileSync(join(directory!, 'result.json'))
    rmSync(directory!, { recursive: true, force: true })
    return
  }
  const path = requireEvidenceWorkPath(input.path, root)
  if (input.method === 'environment') return await readVerificationEnvironment(path)
  if (input.method === 'behavior') {
    const program = resolver.resolve({
      programRef: input.programRef,
      argsRef: null,
      workspacePath: path,
    })
    if (!program)
      return { exitCode: -1, timedOut: false, outputJson: '', error: 'behavior-adapter-missing' }
    requireEvidenceWorkPath(program.argv[0]!, root)
    const writer = retainWorkVolumeWriter(root, `behavior:${input.id}`, path)
    const result = await runManagedProcess({
      argv: program.argv,
      cwd: path,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stdin: { mode: 'pipe', data: input.inputJson },
      timeoutMs: input.timeoutMs,
      signal,
      captureRawStdout: true,
      requireSpawnReceipt: true,
      onSpawned: (receipt) => writer.spawned(receipt),
    })
    if (result.outcome === 'child-unkillable') throw new Error('hosted-behavior-writer-unreaped')
    writer.release()
    return {
      exitCode: result.exitCode ?? -1,
      timedOut: result.outcome === 'timeout',
      outputJson: result.rawStdout ?? '',
      error: result.spawnError ?? result.stderrTail,
    }
  }
  if (input.method === 'collect') {
    assertEvidenceRelativePath(input.pattern)
    const result: string[] = []
    for await (const file of new Bun.Glob(input.pattern).scan({
      cwd: path,
      onlyFiles: true,
      dot: false,
    })) {
      if (file.startsWith('.git/') || file.startsWith('.agent-workflow/')) continue
      assertEvidenceRelativePath(file)
      requireEvidenceWorkPath(join(path, file), root)
      result.push(file)
      if (result.length >= 64) break
    }
    return result.sort()
  }
  const digest = sha256Hex(JSON.stringify(input))
  const completed = (): HostedVerificationReceipt | null => {
    if (input.method !== 'run') return null
    try {
      const saved = JSON.parse(readFileSync(join(directory!, 'result.json'), 'utf8')) as {
        digest: string
        receipt: HostedVerificationReceipt
      }
      if (saved.digest !== digest) throw new Error('hosted-verification-request-changed')
      return saved.receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return null
    }
  }
  const saved = completed()
  if (saved !== null && input.method === 'run') {
    releaseCompletedWorkVolumeWriter(root, `verification:${input.id}`)
    return saved
  }
  const spec = input.method === 'resolve' ? input : input.step
  const program = resolver.resolve({
    programRef: spec.programRef,
    argsRef: spec.argsRef,
    workspacePath: path,
  })
  if (program !== null) requireEvidenceWorkPath(program.argv[0]!, root)
  if (input.method === 'resolve') return program !== null
  if (program === null) throw new Error('hosted-verification-program-missing')
  mkdirSync(directory!, { recursive: true })
  const writer = retainWorkVolumeWriter(root, `verification:${input.id}`, path)
  // A prior helper may have committed between our first read and this claim.
  const committed = completed()
  if (committed !== null) {
    writer.release()
    return committed
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const result = await runManagedProcess({
    argv: program.argv,
    cwd: path,
    env,
    timeoutMs: input.step.timeoutMs,
    captureRawStdout: true,
    signal,
    requireSpawnReceipt: true,
    onSpawned: (receipt) => writer.spawned(receipt),
  })
  if (result.outcome === 'child-unkillable') throw new Error('hosted-verification-writer-unreaped')
  if (result.outcome === 'aborted') {
    writer.release()
    throw new Error('hosted-verification-aborted')
  }
  if (result.outcome === 'spawn-failed') {
    writer.release()
    throw new Error(`hosted-verification-spawn-failed: ${result.spawnError ?? 'unknown'}`)
  }
  const tail = Buffer.concat(
    [result.rawStdout, result.stderrTail].map((text) => Buffer.from(text).subarray(-64 * 1024)),
  )
  const outputFile = tail.length ? join(directory!, 'output.log') : null
  const durableWrite = (file: string, bytes: string | Uint8Array) => {
    const fd = openSync(file, 'w', 0o600)
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  if (outputFile !== null) durableWrite(outputFile, tail)
  const receipt: HostedVerificationReceipt = {
    exitCode: result.exitCode ?? -1,
    timedOut: result.outcome === 'timeout',
    outputFile,
  }
  durableWrite(join(directory!, 'result.json.tmp'), JSON.stringify({ digest, receipt }))
  renameSync(join(directory!, 'result.json.tmp'), join(directory!, 'result.json'))
  if (process.platform !== 'win32') {
    const fd = openSync(directory!, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  writer.release()
  return receipt
}
