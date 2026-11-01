// RFC-398 §7.6: real start/auto children, durable barriers and real process death.
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import {
  createFrozenSqliteJournal,
  applyFrozenSqliteMigrations,
} from '@/platform/persistence/migration/epoch1/sqliteChain'
import { parseEpochSwitchJournal } from '@/modules/system-operations/domain/epochSwitch/model'
import { readAutoUpgradeSessions } from '@/modules/system-operations/infrastructure/local/autoUpgradeState'
import { isProcessAlive } from '@/util/process'
import { frozenValues } from './rfc395V2/contentFixtures'

export const rfc398Main = resolve(import.meta.dir, '../../src/main.ts')
export async function autoUpgradeFixture(
  options: {
    blocked?: boolean
    manual?: boolean
    home?: string
    env?: Record<string, string>
  } = {},
) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'aw-rfc398-auto-'))
  const hooks = join(home, 'test-hooks')
  mkdirSync(hooks, { recursive: true })
  if (!options.home) {
    const db = new Database(join(home, 'db.sqlite'))
    try {
      db.exec('PRAGMA journal_mode = WAL')
      createFrozenSqliteJournal(db)
      applyFrozenSqliteMigrations(db, (await loadFrozenEpoch1History()).sqlite)
      if (options.blocked) {
        const row = frozenValues('code_work_items', {
          id: 'rfc398-stranded-work',
          status: 'running',
        })
        const columns = Object.keys(row)
        db.query(
          `INSERT INTO code_work_items (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        ).run(
          ...Object.values(row).map(
            (v) => (typeof v === 'boolean' ? Number(v) : v) as SQLQueryBindings,
          ),
        )
      }
    } finally {
      db.close()
    }
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ autoEpochMigration: !options.manual, defaultRuntime: 'opencode' }),
    )
  }
  const env = {
    ...process.env,
    ...options.env,
    AGENT_WORKFLOW_HOME: home,
    AGENT_WORKFLOW_TEST_EPOCH_UPGRADE: hooks,
    AW_DEPLOYMENT_MODE: 'standalone',
    AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS: '0',
    NO_COLOR: '1',
  }
  interface Child {
    readonly process: Pick<ReturnType<typeof Bun.spawn>, 'pid' | 'kill' | 'exited'>
    readonly output: string
    readonly error: string
    readonly exited: Promise<number>
  }
  const processes: Child[] = []
  function spawn(args: string[], extra: Record<string, string | undefined> = {}): Child {
    const process = Bun.spawn([globalThis.process.execPath, 'run', rfc398Main, ...args], {
      env: { ...env, ...extra },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let output = '',
      error = ''
    const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }))
      append(decoder.decode())
    }
    const stdout = drain(process.stdout, (text) => {
      output += text
    })
    const stderr = drain(process.stderr, (text) => {
      error += text
    })
    const result = {
      process,
      get output() {
        return output
      },
      get error() {
        return error
      },
      exited: Promise.all([process.exited, stdout, stderr]).then(([code]) => code),
    }
    processes.push(result)
    return result
  }
  const events = () =>
    existsSync(join(hooks, 'events.jsonl'))
      ? readFileSync(join(hooks, 'events.jsonl'), 'utf8')
          .split('\n')
          .slice(0, -1) // A writer publishes a complete event by appending its newline.
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { point: string; pid: number; parent: number })
      : []
  const wait = async <T>(read: () => T | null, timeout = 180_000): Promise<T> => {
    return new Promise<T>((accept, reject) => {
      const watcher = watch(hooks, () => inspect())
      const fallback = setInterval(() => inspect(), 200) // readiness may write only outside the hook directory
      const timer = setTimeout(
        () =>
          done(
            new Error(`barrier/readiness timed out\n${processes.map((p) => p.error).join('\n')}`),
          ),
        timeout,
      )
      const done = (error: Error | null, value?: T) => {
        watcher.close()
        clearInterval(fallback)
        clearTimeout(timer)
        if (error) reject(error)
        else accept(value!)
      }
      function inspect() {
        try {
          const value = read()
          if (value !== null) done(null, value)
        } catch (error) {
          done(error as Error)
        }
      }
      inspect()
    })
  }
  const kill = (pid: number) => {
    if (!isProcessAlive(pid)) return
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      // The child can exit between the liveness probe and the signal (seen in close()).
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  return {
    home,
    hooks,
    env,
    events,
    spawn,
    wait,
    kill,
    start: (extra: Record<string, string | undefined> = {}) =>
      spawn(['start', '--host', '127.0.0.1', '--port', '0'], extra),
    barriers(points: string[]) {
      writeFileSync(join(hooks, 'barriers.json'), JSON.stringify(points))
    },
    release(point: string) {
      writeFileSync(join(hooks, `${point}.release`), '')
    },
    flag(name: string, enabled = true) {
      if (enabled) writeFileSync(join(hooks, name), '1')
      else rmSync(join(hooks, name), { force: true })
    },
    reached(point: string, pid?: number) {
      return wait(
        () =>
          events().find((e) => e.point === point && (pid === undefined || e.pid === pid)) ?? null,
      )
    },
    sessions: () => readAutoUpgradeSessions(home),
    journals: () => {
      const root = join(home, 'database-migrations')
      return existsSync(root)
        ? readdirSync(root)
            .filter(
              (name) => /^dbm_e2_/.test(name) && existsSync(join(root, name, 'epoch-switch.json')),
            )
            .map((name) =>
              parseEpochSwitchJournal(readFileSync(join(root, name, 'epoch-switch.json'), 'utf8')),
            )
        : []
    },
    async ready() {
      const info = await wait(() =>
        existsSync(join(home, '.daemon.info'))
          ? (JSON.parse(readFileSync(join(home, '.daemon.info'), 'utf8')) as {
              url: string
              pid: number
            })
          : null,
      )
      return info
    },
    async close() {
      const pids = new Set([...events().map((e) => e.pid), ...processes.map((p) => p.process.pid)])
      for (const pid of pids) if (pid !== process.pid) kill(pid)
      await Promise.all(processes.map((p) => p.exited))
      if (!options.home) rmSync(home, { recursive: true, force: true })
    },
  }
}
export type AutoUpgradeFixture = Awaited<ReturnType<typeof autoUpgradeFixture>>

export async function acknowledgeFixture(f: AutoUpgradeFixture) {
  const journal = f.journals()[0]!
  const bytes = readFileSync(
    join(
      f.home,
      'database-migrations',
      journal.payload.operationId,
      `plans/${journal.payload.plan!.digest}.json`,
    ),
    'utf8',
  )
  const plan = JSON.parse(bytes) as {
    payload: { blocks: { id: string; block: { acknowledgeable?: boolean } }[] }
  }
  const items = plan.payload.blocks.filter((b) => b.block.acknowledgeable).map((b) => b.id)
  if (!items.length) throw new Error('expected real acknowledgeable legacy work')
  const child = f.spawn([
    'db',
    'migration',
    'acknowledge',
    journal.payload.operationId,
    ...items.flatMap((id) => ['--item', id]),
    '--reason',
    'archive stranded fixture work',
    '--json',
  ])
  if ((await child.exited) !== 0) throw new Error(child.output + child.error)
}

export async function businessRoundTrip(f: AutoUpgradeFixture) {
  const info = await f.ready()
  let token = readFileSync(join(f.home, 'token'), 'utf8').trim()
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(path, info.url), {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${path}: ${response.status}: ${text}`)
    return JSON.parse(text) as Record<string, unknown>
  }
  const credentials = {
    username: 'rfc398-admin',
    displayName: 'Upgrade test',
    password: 'Rfc398-Fixture-Password-837!',
  }
  if ((await request('/api/auth/bootstrap/status')).required)
    await request('/api/auth/bootstrap/admin', 'POST', credentials)
  const login = await request('/api/auth/login', 'POST', credentials)
  token = String(login.sessionToken)
  if (login.mustChangePassword) {
    const password = 'Rfc398-Upgraded-Password-982!'
    await request('/api/auth/change-password', 'POST', {
      oldPassword: credentials.password,
      newPassword: password,
    })
    token = String(
      (await request('/api/auth/login', 'POST', { ...credentials, password })).sessionToken,
    )
  }
  const created = await request('/api/agents', 'POST', {
    name: 'rfc398-round-trip',
    bodyMd: 'upgraded database',
    description: 'RFC-398',
  })
  const read = await request(`/api/agents/${String(created.id)}`)
  if (read.name !== 'rfc398-round-trip') throw new Error('upgraded business read/write mismatch')
  return read
}
