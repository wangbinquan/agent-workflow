import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createQ1Epoch1Fixture, resolveQ1BaselineCommit } from './fixture'
import {
  assertQ1ResponseParity,
  assertQ1CaptureContent,
  Q1_SURFACES,
  type Q1Surface,
  type Q1CaptureWindow,
} from './compare'
import { q1ResponseDifferences } from './differences'

interface Options {
  readonly repository: string
  readonly oldBinary: string
  readonly newBinary: string
  readonly oldArtifact: string
  readonly target: 'sqlite' | 'postgresql'
  readonly targetUrlEnv?: string
}
async function binaryDigest(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
async function command(binary: string, args: string[], home: string): Promise<unknown> {
  const child = Bun.spawn([binary, ...args], {
    env: { ...process.env, AGENT_WORKFLOW_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 300000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await writeFile(join(home, `q1-command-${args[2] ?? args[0]}.log`), stdout + stderr)
    if (code !== 0) throw new Error(`q1-command-failed:${args.join(' ')}:${code}`)
    return JSON.parse(stdout)
  } finally {
    clearTimeout(timer)
  }
}
export function q1ReadyUrl(output: string): string | null {
  return (
    output.match(
      /agent-workflow ready — open this URL in your browser:\r?\n\s+(http:\/\/[0-9.]+:\d+\/)(?:\?token=[0-9a-f]+)?\r?\n/,
    )?.[1] ?? null
  )
}
async function withQ1Daemon<T>(
  binary: string,
  home: string,
  label: string,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const child = Bun.spawn([binary, 'start', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, AGENT_WORKFLOW_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let resolveReady!: (url: string) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const timer = setTimeout(() => rejectReady(new Error('q1-daemon-ready-timeout')), 60000)
  const drain = async (stream: ReadableStream<Uint8Array>, channel: string) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let log = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        log += decoder.decode(value, { stream: true })
        const url = q1ReadyUrl(log)
        if (url !== null) resolveReady(url)
      }
      log += decoder.decode()
    } finally {
      reader.releaseLock()
      await writeFile(join(home, `q1-${label}-${channel}.log`), log)
    }
  }
  const logs = Promise.all([drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr')])
  void child.exited.then((code) => rejectReady(new Error(`q1-daemon-exited:${code}`)))
  try {
    const url = await ready
    clearTimeout(timer)
    return await run(url)
  } finally {
    clearTimeout(timer)
    child.kill('SIGTERM')
    const stopTimer = setTimeout(() => child.kill('SIGKILL'), 30000)
    try {
      await child.exited
      await logs
    } finally {
      clearTimeout(stopTimer)
    }
  }
}

interface Capture {
  readonly text: string
  readonly window: Q1CaptureWindow
  readonly status: number
  readonly errors: string[]
}
async function capture(binary: string, home: string, token: string, label: string) {
  return withQ1Daemon(binary, home, label, async (url) => {
    const captures = new Map<Q1Surface, Capture>()
    for (const surface of Q1_SURFACES) {
      const startedAt = Date.now()
      let text = ''
      let status = 0
      let finishedAt = startedAt
      const errors: string[] = []
      try {
        const response = await fetch(new URL(surface.path, url), {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30000),
        })
        status = response.status
        text = await response.text()
        finishedAt = Date.now()
        if (status !== 200) throw new Error(`q1-http-status:${label}:${surface.name}:${status}`)
        const value: unknown = JSON.parse(text)
        if (label === 'target') surface.schema.parse(value)
        assertQ1CaptureContent(surface.name, value)
        if (surface.name === 'reviews' && (!Array.isArray(value) || value.length === 0))
          throw new Error('q1-empty-review-oracle')
        if (
          surface.name === 'directory' &&
          z.object({ items: z.array(z.unknown()) }).parse(value).items.length === 0
        )
          throw new Error('q1-empty-directory-oracle')
      } catch (error) {
        errors.push(String(error))
      }
      const window = { startedAt, finishedAt }
      await writeFile(join(home, `q1-${label}-${surface.name}.json`), text)
      await writeFile(join(home, `q1-${label}-${surface.name}-window.json`), JSON.stringify(window))
      const result = { text, window, status, errors }
      await writeFile(
        join(home, `q1-${label}-${surface.name}-capture.json`),
        JSON.stringify(result),
      )
      captures.set(surface.name, result)
    }
    return captures
  })
}

/** T18-only: fresh synthetic home, exact old artifact, real CLI conversion, then exact response bytes. */
export async function runQ1BinaryParity(options: Options): Promise<string> {
  const sourceCommit = resolveQ1BaselineCommit(options.repository)
  const artifact = z
    .object({ commit: z.literal(sourceCommit), sha256: z.string() })
    .parse(JSON.parse(await readFile(options.oldArtifact, 'utf8')))
  if (artifact.sha256 !== (await binaryDigest(options.oldBinary)))
    throw new Error('q1-old-binary-artifact-mismatch')
  const home = await mkdtemp(join(tmpdir(), `rfc395-q1-parity-${options.target}-`))
  console.info(`Q-1 parity artifacts: ${home}`)
  // Retain the fixture and both captures, including failures, for T18 evidence.
  await writeFile(
    join(home, 'q1-binaries.json'),
    JSON.stringify(
      {
        sourceCommit,
        oldSha256: artifact.sha256,
        newSha256: await binaryDigest(options.newBinary),
        target: options.target,
      },
      null,
      2,
    ),
  )
  // Installation must use the released daemon: its migrator fingerprints the
  // receipt table's CREATE SQL, and boot also installs real seed/content rows.
  await withQ1Daemon(options.oldBinary, home, 'install', async () => undefined)
  const fixture = await createQ1Epoch1Fixture(options.repository, home, sourceCommit, true)
  const source = await capture(options.oldBinary, home, fixture.token, 'source')
  const sourceErrors = [...source.values()].flatMap((value) => value.errors)
  if (sourceErrors.length)
    throw new Error(`q1-source-capture-invalid:${JSON.stringify(sourceErrors)}`)
  const planArgs = ['db', 'migration', 'plan', '--target', options.target, '--json']
  if (options.target === 'postgresql') {
    if (!options.targetUrlEnv || !process.env[options.targetUrlEnv])
      throw new Error('q1-disposable-postgresql-target-required')
    planArgs.push('--target-url-env', options.targetUrlEnv)
  }
  const plan = z
    .object({
      operationId: z.string(),
      plan: z.object({
        approvalDigest: z.string(),
        payload: z.object({ blocks: z.array(z.unknown()) }),
      }),
    })
    .parse(await command(options.newBinary, planArgs, home))
  if (plan.plan.payload.blocks.length) throw new Error(`q1-fixture-conversion-blocked:${home}`)
  await command(
    options.newBinary,
    ['db', 'migration', 'run', plan.operationId, '--approve', plan.plan.approvalDigest, '--json'],
    home,
  )
  await command(options.newBinary, ['db', 'migration', 'verify', plan.operationId, '--json'], home)
  await command(
    options.newBinary,
    ['db', 'migration', 'complete', plan.operationId, '--json'],
    home,
  )
  const target = await capture(options.newBinary, home, fixture.token, 'target')
  const results = []
  for (const surface of Q1_SURFACES) {
    const before = source.get(surface.name)!
    const after = target.get(surface.name)!
    const windows = { before: before.window, after: after.window }
    const errors = [...before.errors, ...after.errors]
    try {
      assertQ1ResponseParity(surface.name, before.text, after.text, windows)
    } catch (error) {
      errors.push(String(error))
    }
    results.push({
      surface: surface.name,
      path: surface.path,
      sourceStatus: before.status,
      targetStatus: after.status,
      rawBytesEqual: before.text === after.text,
      errors,
      differences: q1ResponseDifferences(surface.name, before.text, after.text, windows),
    })
  }
  const status = results.some((result) => result.errors.length > 0) ? 'failed' : 'passed'
  await writeFile(
    join(home, 'q1-result.json'),
    JSON.stringify({ status, surfaces: results }, null, 2),
  )
  if (status === 'failed') throw new Error(`q1-parity-failed:${join(home, 'q1-result.json')}`)
  return home
}
if (import.meta.main) {
  const required = (key: string) => {
    const value = process.env[key]
    if (!value) throw new Error(`Missing ${key}`)
    return value
  }
  const target = z.enum(['sqlite', 'postgresql']).parse(process.env.RFC395_Q1_TARGET ?? 'sqlite')
  console.log(
    await runQ1BinaryParity({
      repository: required('RFC395_Q1_REPOSITORY'),
      oldBinary: required('RFC395_Q1_OLD_BINARY'),
      newBinary: required('RFC395_Q1_NEW_BINARY'),
      oldArtifact: required('RFC395_Q1_OLD_ARTIFACT'),
      target,
      targetUrlEnv: process.env.RFC395_Q1_TARGET_URL_ENV,
    }),
  )
}
