// RFC-398 §7.3/A1: source daemon, real HTTP, migrated workflow execution, restart and doctor.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { REPO_ROOT } from '../../../../../scripts/release-upgrade/lib/io'
import type { ApiExpectation } from '../../../../../scripts/release-upgrade/lib/seed-model'
import type { BuiltRelease } from './build'
import { equal, invariant, type Row } from './data'

const main = join(REPO_ROOT, 'packages/backend/src/main.ts')
export function sourceCli(built: BuiltRelease, args: string[], cwd = REPO_ROOT) {
  const process = spawn(globalThis.process.execPath, ['run', main, ...args], {
    cwd,
    env: built.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  process.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  process.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    process.once('error', reject)
    process.once('close', resolve)
  })
  return {
    process,
    exited,
    get output() {
      return output
    },
  }
}
export async function installMockRuntime(
  built: BuiltRelease,
  snapshot?: Awaited<ReturnType<BuiltRelease['snapshotTarget']>>,
): Promise<string> {
  const entry = join(built.home, 'matrix-mock-entry.ts'),
    outfile = join(built.home, `matrix-opencode${process.platform === 'win32' ? '.exe' : ''}`)
  const fixture = join(REPO_ROOT, 'packages/backend/tests/fixtures/mock-opencode.ts')
  writeFileSync(
    entry,
    `if (process.argv.includes('--version')) { console.log('1.17.5'); } else { await import(${JSON.stringify(fixture)}); }\n`,
  )
  // Compile in a child whose cwd is the case home: the compiler writes its temporary
  // `.bun-build` file to the current directory, and every concurrently running test file
  // sharing the repository root would report it as a leak.
  const compile = Bun.spawn(
    [process.execPath, 'build', entry, '--compile', '--target', 'bun', '--outfile', outfile],
    { cwd: built.home, stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, compileOutput] = await Promise.all([
    compile.exited,
    new Response(compile.stderr).text(),
    new Response(compile.stdout).text(),
  ])
  invariant(code === 0, `compile mock runtime: ${compileOutput}`)
  built.env.AGENT_WORKFLOW_OPENCODE_BIN = outfile
  built.env.MOCK_OPENCODE_OUTPUTS = JSON.stringify({
    document: '# Matrix acceptance\nPreserved workflow completed.\n',
  })
  built.env.BROWSER = 'none'
  const configPath = join(built.home, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Row
  const runtimes = (snapshot ?? (await built.snapshotTarget())).get('runtimes') ?? []
  const runtime = runtimes.find((row) => row.protocol === 'opencode')
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      opencodePath: outfile,
      defaultRuntime: runtime?.name ?? 'opencode',
      defaultNodeRetries: 0,
      sessionRestartBudget: 0,
      defaultPerNodeTimeoutMs: 45_000,
      memoryDistillerEnabled: false,
      worktreeAutoGc: { enabled: false },
    }),
  )
  return outfile
}
export async function startSourceDaemon(
  built: BuiltRelease,
  options: {
    cwd?: string
    beforeReady?: (child: ReturnType<typeof sourceCli>) => Promise<void>
  } = {},
) {
  const child = sourceCli(built, ['start', '--host', '127.0.0.1', '--port', '0'], options.cwd)
  let stopped = false
  async function stop() {
    if (stopped) return
    stopped = true
    const controlPath = join(built.home, '.daemon.control')
    if (existsSync(controlPath)) {
      const control = JSON.parse(readFileSync(controlPath, 'utf8')) as {
        url: string
        nonce: string
      }
      const response = await fetch(`${control.url}/shutdown`, {
        method: 'POST',
        headers: { 'x-agent-workflow-control': control.nonce },
        signal: AbortSignal.timeout(10_000),
      })
      invariant(response.ok, `daemon shutdown: ${response.status}`)
    } else child.process.kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    const graceful = await Promise.race([
      child.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 30_000)
      }),
    ]).finally(() => clearTimeout(timer))
    if (!graceful) {
      child.process.kill('SIGKILL')
      await child.exited
      throw new Error(`daemon failed to stop\n${child.output}`)
    }
  }
  try {
    await options.beforeReady?.(child)
    const info = await new Promise<{ url: string; pid: number }>((resolve, reject) => {
      const watcher = watch(built.home, () => inspect()),
        timer = setTimeout(
          () => finish(new Error(`daemon readiness timeout\n${child.output}`)),
          60_000,
        )
      let settled = false
      function finish(error: Error | null, value?: { url: string; pid: number }) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        watcher.close()
        child.process.stdout.off('data', inspect)
        child.process.stderr.off('data', inspect)
        if (error) reject(error)
        else resolve(value!)
      }
      function inspect() {
        const path = join(built.home, '.daemon.info')
        if (!existsSync(path)) return
        try {
          const value = JSON.parse(readFileSync(path, 'utf8')) as { url: string; pid: number }
          if (value.pid === child.process.pid) finish(null, value)
        } catch {
          /* writer has not published a complete info file */
        }
      }
      void child.exited.then(
        (code) => finish(new Error(`daemon exited ${code}\n${child.output}`)),
        (error) => finish(error as Error),
      )
      // Directory creation notifications can precede the info-file write on
      // macOS. The daemon's subsequent ready output is another completion event.
      child.process.stdout.on('data', inspect)
      child.process.stderr.on('data', inspect)
      inspect()
    })
    let token = readFileSync(join(built.home, 'token'), 'utf8').trim()
    const request = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
      const response = await fetch(new URL(path, info.url), {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      })
      const text = await response.text()
      invariant(response.ok, `${method} ${path}: ${response.status} ${text}\n${child.output}`)
      return text ? JSON.parse(text) : null
    }
    const credentials = {
      username: 'upgrade_admin',
      displayName: 'Upgrade Administrator',
      password: 'rfc398-local-fixture-only',
    }
    const policies = (await built.snapshotTarget()).get('auth_login_policy') ?? []
    equal(policies.length, 1, 'A1 exactly one login policy')
    // RFC-221 retires daemon-token access when bootstrap completes. Existing
    // administrators log in directly; only a pre-user home needs this endpoint.
    if (policies[0]!.bootstrap_completed_at === null) {
      equal(
        ((await request('/api/auth/bootstrap/status')) as Row).required,
        true,
        'A1 bootstrap required',
      )
      await request('/api/auth/bootstrap/admin', 'POST', credentials)
    }
    const changed = join(built.home, 'matrix-password-changed')
    let password = existsSync(changed) ? 'Rfc398-Matrix-Current-973!' : credentials.password
    let login = (await request('/api/auth/login', 'POST', { ...credentials, password })) as Row
    token = String(login.sessionToken)
    if (login.mustChangePassword) {
      await request('/api/auth/change-password', 'POST', {
        oldPassword: password,
        newPassword: 'Rfc398-Matrix-Current-973!',
      })
      password = 'Rfc398-Matrix-Current-973!'
      writeFileSync(changed, '1')
      login = (await request('/api/auth/login', 'POST', { ...credentials, password })) as Row
      token = String(login.sessionToken)
    }
    return { request, stop, child }
  } catch (error) {
    // During start-mode checks the parent can still own a delegated auto child.
    // Let the production SIGTERM forwarding path reap it before deleting the home.
    try {
      await stop()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'daemon startup and cleanup failed')
    }
    throw error
  }
}
export type MatrixDaemon = Awaited<ReturnType<typeof startSourceDaemon>>
function pointer(value: unknown, path: string): unknown {
  if (path === '') return value
  invariant(path.startsWith('/'), `invalid JSON pointer ${path}`)
  return path
    .slice(1)
    .split('/')
    .reduce<unknown>((result, part) => {
      invariant(result !== null && typeof result === 'object', `missing API pointer ${path}`)
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
      invariant(Object.hasOwn(result, key), `missing API key ${path}`)
      return (result as Row)[key]
    }, value)
}
function expand(value: unknown, home: string): unknown {
  if (typeof value === 'string') return value.replaceAll('<AW_HOME>', home)
  if (Array.isArray(value)) return value.map((v) => expand(v, home))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, home)]))
  return value
}
export async function checkApiExpectations(
  built: BuiltRelease,
  daemon: MatrixDaemon,
): Promise<void> {
  const cache = new Map<string, unknown>()
  const expectations = built.seeds.flatMap((seed) =>
    seed.rows.flatMap((row) => row.expect?.api ?? []),
  )
  invariant(expectations.length > 0, `${built.release.tag} has no A1 expectations`)
  const failures: unknown[] = []
  for (const expectation of expectations) {
    try {
      const spec = expand(expectation, built.home) as ApiExpectation
      if (!cache.has(spec.path)) cache.set(spec.path, await daemon.request(spec.path))
      let value = pointer(cache.get(spec.path), spec.at)
      if (spec.match) {
        invariant(Array.isArray(value), `A1 expected collection ${spec.path}${spec.at}`)
        const matches = value.filter((row) =>
          Object.entries(spec.match!).every(
            ([key, expected]) => JSON.stringify((row as Row)[key]) === JSON.stringify(expected),
          ),
        )
        equal(matches.length, 1, `A1 exact identity ${spec.path} ${JSON.stringify(spec.match)}`)
        value = matches[0]
      }
      for (const [path, wanted] of Object.entries(spec.equals))
        equal(pointer(value, path), wanted, `A1 ${spec.path} ${spec.at}${path}`)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'RFC-398 A1 API expectations failed')
}
function collection(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[]
  invariant(value && typeof value === 'object', 'API collection absent')
  for (const key of ['items', 'rows', 'runs', 'runtimes'])
    if (Array.isArray((value as Row)[key])) return (value as Row)[key] as Row[]
  throw new Error(`Unexpected API collection ${JSON.stringify(value)}`)
}
export async function newTaskToDone(
  built: BuiltRelease,
  daemon: MatrixDaemon,
  mock: string,
): Promise<string> {
  await daemon.request('/api/auth/me/profile', 'PATCH', {
    displayName: 'Upgrade Administrator',
    gitName: 'Upgrade Matrix',
    email: 'upgrade-matrix@example.invalid',
  })
  const runtimes = collection(await daemon.request('/api/runtimes'))
  const runtime = runtimes.find((row) => row.protocol === 'opencode')
  invariant(runtime, 'migrated OpenCode runtime absent')
  await daemon.request(`/api/runtimes/${String(runtime.name)}`, 'PUT', { binaryPath: mock })
  const workflow = (await daemon.request('/api/workflows/01K398000045B34F16DB605A06')) as Row
  const task = (await daemon.request('/api/tasks', 'POST', {
    workflowId: workflow.id,
    expectedWorkflowVersion: workflow.version,
    name: `Release matrix ${built.release.tag}`,
    scratch: true,
    inputs: {},
  })) as Row
  invariant(typeof task.id === 'string', 'new task ID missing')
  const deadline = Date.now() + 90_000,
    approved = new Set<string>()
  while (Date.now() < deadline) {
    const current = (await daemon.request(`/api/tasks/${task.id}`)) as Row
    if (current.status === 'done') return task.id
    invariant(
      !['failed', 'canceled'].includes(String(current.status)),
      `new task failed: ${JSON.stringify(current)}\n${daemon.child.output}`,
    )
    if (current.status === 'awaiting_review') {
      const reviews = collection(await daemon.request('/api/reviews')).filter(
        (r) => r.taskId === task.id && r.awaitingReview,
      )
      for (const review of reviews) {
        const key = `${String(review.nodeRunId)}/${String(review.reviewIteration)}`
        if (!approved.has(key)) {
          await daemon.request(`/api/reviews/${String(review.nodeRunId)}/decision`, 'POST', {
            decision: 'approved',
            reviewIteration: review.reviewIteration,
          })
          approved.add(key)
        }
      }
    }
    await Promise.race([
      delay(500),
      daemon.child.exited.then((code) => {
        throw new Error(`daemon exited ${code} during task\n${daemon.child.output}`)
      }),
    ])
  }
  throw new Error(
    `new task did not finish: ${JSON.stringify(await daemon.request(`/api/tasks/${task.id}/node-runs`))}`,
  )
}
export async function checkDoctor(built: BuiltRelease): Promise<void> {
  const child = sourceCli(built, ['doctor'])
  const timer = setTimeout(() => child.process.kill('SIGKILL'), 45_000)
  try {
    equal(await child.exited, 0, `doctor exit\n${child.output}`)
    // The public doctor CLI emits formatDoctor text, and exits 1 for any failed
    // check. It has no JSON flag; require both its exit status and success footer.
    invariant(
      child.output.trimEnd().endsWith('all checks passed'),
      `doctor findings\n${child.output}`,
    )
    invariant(!child.output.includes('✗'), `doctor failed check\n${child.output}`)
  } finally {
    clearTimeout(timer)
  }
}
