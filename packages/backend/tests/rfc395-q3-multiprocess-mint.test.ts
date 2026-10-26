// Q-3: process death after committed facts and simultaneous independent native allocators.
import { expect, test } from 'bun:test'
import { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { describeR2Providers } from './helpers/rfc395R2Harness'
import { resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'

function child(env: Record<string, string | undefined>) {
  const process = Bun.spawn(
    [execPath, fileURLToPath(new URL('./helpers/rfc395Q3MintProcess.ts', import.meta.url))],
    {
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  let resolveReady!: (message: { taskId?: string; pid: number }) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<{ taskId?: string; pid: number }>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const timeout = setTimeout(() => {
    rejectReady(new Error('q3-child-timeout'))
    process.kill('SIGKILL')
  }, 60000)
  const stdout = (async () => {
    const reader = process.stdout.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) return text
        text += decoder.decode(next.value, { stream: true })
        const message = text.match(/^Q3_READY=(.+)$/m)
        if (message) resolveReady(JSON.parse(message[1]!))
      }
    } finally {
      reader.releaseLock()
    }
  })()
  const done = Promise.all([process.exited, stdout, new Response(process.stderr).text()]).then(
    ([code, out, err]) => {
      clearTimeout(timeout)
      rejectReady(new Error(`q3-child-exited:${code}:${err}`))
      return { code, out, err }
    },
  )
  return { process, ready, done }
}

describeR2Providers('Q-3 multi-process mint and durable first-write crash', (h) => {
  test('SIGKILL preserves first commit; four fresh writers never reuse IDs or seq allocations', async () => {
    await h.installHead(createHistoryVersion({ registry: persistenceSchema, slug: 'q3-process' }), {
      generationId: 'dbg_q3_multiprocess',
      metaTables: EPOCH2_META_TABLES,
    })
    const env = {
      ...process.env,
      Q3_PROVIDER: h.provider,
      Q3_SQLITE_PATH: h.provider === 'sqlite' ? h.sqlitePath : undefined,
    }
    if (h.provider === 'sqlite') await h.native.execute('PRAGMA journal_mode = WAL')
    else {
      const name = String((await h.native.execute('SELECT current_database() AS name'))[0]!.name)
      const selected = new URL(process.env[resolvePostgresqlTestUrlEnv(process.env)!]!)
      selected.pathname = `/${name}`
      Object.assign(env, { Q3_DATABASE_URL: selected.toString() })
    }
    const children: ReturnType<typeof child>[] = []
    const start = (values: Record<string, string>) => {
      const started = child({ ...env, ...values })
      children.push(started)
      return started
    }
    const rows = () => h.native.execute(`SELECT id, seq FROM ${h.table('node_runs')} ORDER BY seq`)
    const firstWrite = () =>
      h.native.execute(`SELECT * FROM ${metaTableName(h.provider, 'first_write')}`)
    try {
      const original = start({ Q3_MODE: 'seed' })
      const ready = await original.ready
      expect(ready.taskId).toBeDefined()
      const marker = await firstWrite()
      expect(marker[0]!.first_live_write_at).not.toBeNull()
      original.process.kill('SIGKILL')
      expect((await original.done).code).not.toBe(0)
      const persisted = await rows()
      expect(persisted).toHaveLength(1)
      expect(persisted[0]!.id).toBe('q3-before-kill')
      expect(await firstWrite()).toEqual(marker)
      const writers = [0, 1, 2, 3].map((index) =>
        start({ Q3_MODE: 'mint', Q3_TASK_ID: ready.taskId!, Q3_WRITER: String(index) }),
      )
      const running = await Promise.all(writers.map((writer) => writer.ready))
      expect(new Set(running.map((writer) => writer.pid)).size).toBe(4)
      for (const writer of writers) writer.process.stdin.end()
      for (const result of await Promise.all(writers.map((writer) => writer.done)))
        expect(result, result.err).toMatchObject({ code: 0 })
      const minted = await rows()
      expect(minted).toHaveLength(17)
      expect(new Set(minted.map((row) => row.id)).size).toBe(17)
      expect(new Set(minted.map((row) => String(row.seq))).size).toBe(17)
      expect(minted[0]).toEqual(persisted[0])
      const allocations = await h.native.execute(
        `SELECT * FROM ${h.table('node_run_seq_allocations')} ORDER BY seq`,
      )
      expect(allocations).toHaveLength(17)
      const duplicate = start({ Q3_MODE: 'mint', Q3_TASK_ID: ready.taskId!, Q3_WRITER: '0' })
      await duplicate.ready
      duplicate.process.stdin.end()
      expect((await duplicate.done).code).not.toBe(0)
      expect(await rows()).toEqual(minted)
      expect(
        await h.native.execute(`SELECT * FROM ${h.table('node_run_seq_allocations')} ORDER BY seq`),
      ).toEqual(allocations)
      expect(await firstWrite()).toEqual(marker)
    } finally {
      for (const started of children) started.process.kill('SIGKILL')
      await Promise.allSettled(children.map((started) => started.done))
    }
  }, 180000)
})
