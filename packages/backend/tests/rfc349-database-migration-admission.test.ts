import { describe, expect, test } from 'bun:test'
import { createDatabaseMigrationDaemonAdmission } from '@/modules/system-operations/infrastructure/databaseMigrationDaemonAdmission'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RFC-349 daemon database admission', () => {
  test('fences new business requests, drains the old generation and keeps migration status live', async () => {
    const calls: string[] = []
    const controller = createDatabaseMigrationDaemonAdmission({
      initialProvider: 'sqlite',
      initialGenerationId: 'dbg_sqlite_01',
      pauseBackgroundWriters: async ({ provider }) => {
        calls.push(`pause:${provider}`)
      },
      switchProviderComposition: async ({ provider, generationId }) => {
        calls.push(`switch:${provider}:${generationId}`)
      },
      resumeBackgroundWriters: async ({ provider }) => {
        calls.push(`resume:${provider}`)
      },
    })
    const active = deferred<Response>()
    const activeRequest = controller.runBusinessRequest(
      new Request('http://localhost/api/tasks'),
      async () => await active.promise,
    )
    expect(controller.live().activeBusinessRequests).toBe(1)

    const freezing = controller.migration.freezeAndDrain({
      operationId: 'dbm_admission_01',
      sourceGenerationId: 'dbg_sqlite_01',
      timeoutMs: 1_000,
    })
    await Promise.resolve()
    expect(controller.live()).toMatchObject({ phase: 'draining', operationId: 'dbm_admission_01' })
    expect(
      await controller.runBusinessRequest(
        new Request('http://localhost/api/tasks/new', { method: 'POST' }),
        async () => new Response('unexpected'),
      ),
    ).toMatchObject({ status: 503 })
    expect(
      await controller
        .runBusinessRequest(
          new Request('http://localhost/api/database/migrations/dbm_admission_01'),
          async () => new Response('status-live'),
        )
        .then((response) => response.text()),
    ).toBe('status-live')

    active.resolve(new Response('complete'))
    expect((await activeRequest).status).toBe(200)
    await freezing
    expect(controller.live()).toMatchObject({ phase: 'frozen', activeBusinessRequests: 0 })

    await controller.migration.activatePostgresql({
      operationId: 'dbm_admission_01',
      generationId: 'dbg_postgresql_01',
    })
    await controller.migration.openPostgresqlAdmission({
      operationId: 'dbm_admission_01',
      generationId: 'dbg_postgresql_01',
    })
    expect(controller.live()).toMatchObject({
      phase: 'open',
      provider: 'postgresql',
      generationId: 'dbg_postgresql_01',
      operationId: null,
    })
    expect(calls).toEqual([
      'pause:sqlite',
      'switch:postgresql:dbg_postgresql_01',
      'resume:postgresql',
    ])
  })

  test('instant rollback drains PostgreSQL and rebuilds the retained SQLite generation', async () => {
    const calls: string[] = []
    const controller = createDatabaseMigrationDaemonAdmission({
      initialProvider: 'postgresql',
      initialGenerationId: 'dbg_postgresql_02',
      pauseBackgroundWriters: async ({ provider }) => {
        calls.push(`pause:${provider}`)
      },
      switchProviderComposition: async ({ provider, generationId }) => {
        calls.push(`switch:${provider}:${generationId}`)
      },
      resumeBackgroundWriters: async ({ provider }) => {
        calls.push(`resume:${provider}`)
      },
    })

    await controller.migration.freezeAndDrain({
      operationId: 'dbm_admission_02',
      sourceGenerationId: 'dbg_sqlite_02',
      timeoutMs: 1_000,
    })
    await controller.migration.reopenSqlite({
      operationId: 'dbm_admission_02',
      sourceGenerationId: 'dbg_sqlite_02',
    })
    expect(controller.live()).toMatchObject({
      phase: 'open',
      provider: 'sqlite',
      generationId: 'dbg_sqlite_02',
    })
    expect(calls).toEqual(['pause:postgresql', 'switch:sqlite:dbg_sqlite_02', 'resume:sqlite'])
  })

  test('a partially successful provider switch is conservatively rebuilt as SQLite', async () => {
    const calls: string[] = []
    let failPostgresqlSwitch = true
    const controller = createDatabaseMigrationDaemonAdmission({
      initialProvider: 'sqlite',
      initialGenerationId: 'dbg_sqlite_partial_01',
      pauseBackgroundWriters: async ({ provider }) => {
        calls.push(`pause:${provider}`)
      },
      switchProviderComposition: async ({ provider, generationId }) => {
        calls.push(`switch:${provider}:${generationId}`)
        if (provider === 'postgresql' && failPostgresqlSwitch) {
          failPostgresqlSwitch = false
          throw new Error('composition switched before callback failure')
        }
      },
      resumeBackgroundWriters: async ({ provider }) => {
        calls.push(`resume:${provider}`)
      },
    })

    await controller.migration.freezeAndDrain({
      operationId: 'dbm_admission_partial_01',
      sourceGenerationId: 'dbg_sqlite_partial_01',
      timeoutMs: 1_000,
    })
    await expect(
      controller.migration.activatePostgresql({
        operationId: 'dbm_admission_partial_01',
        generationId: 'dbg_postgresql_partial_01',
      }),
    ).rejects.toThrow('composition switched before callback failure')
    expect(controller.live()).toMatchObject({
      phase: 'switching',
      provider: 'postgresql',
      generationId: 'dbg_postgresql_partial_01',
    })

    await controller.migration.reopenSqlite({
      operationId: 'dbm_admission_partial_01',
      sourceGenerationId: 'dbg_sqlite_partial_01',
    })
    expect(controller.live()).toMatchObject({
      phase: 'open',
      provider: 'sqlite',
      generationId: 'dbg_sqlite_partial_01',
    })
    expect(calls).toEqual([
      'pause:sqlite',
      'switch:postgresql:dbg_postgresql_partial_01',
      'switch:sqlite:dbg_sqlite_partial_01',
      'resume:sqlite',
    ])
  })

  test('a bounded drain timeout reopens the same provider instead of copying concurrently', async () => {
    const calls: string[] = []
    const controller = createDatabaseMigrationDaemonAdmission({
      initialProvider: 'sqlite',
      initialGenerationId: 'dbg_sqlite_03',
      pauseBackgroundWriters: async () => {
        calls.push('pause')
      },
      switchProviderComposition: async () => {
        calls.push('switch')
      },
      resumeBackgroundWriters: async () => {
        calls.push('resume')
      },
    })
    const active = deferred<Response>()
    const request = controller.runBusinessRequest(
      new Request('http://localhost/api/tasks'),
      async () => await active.promise,
    )

    await expect(
      controller.migration.freezeAndDrain({
        operationId: 'dbm_admission_03',
        sourceGenerationId: 'dbg_sqlite_03',
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'database-admission-drain-timeout' })
    expect(controller.live()).toMatchObject({ phase: 'open', provider: 'sqlite' })
    expect(calls).toEqual(['pause', 'resume'])
    active.resolve(new Response('complete'))
    await request
  })

  test('different operations and invalid provider generations fail closed', async () => {
    const controller = createDatabaseMigrationDaemonAdmission({
      initialProvider: 'sqlite',
      initialGenerationId: 'dbg_sqlite_04',
      pauseBackgroundWriters: async () => undefined,
      switchProviderComposition: async () => undefined,
      resumeBackgroundWriters: async () => undefined,
    })
    await controller.migration.freezeAndDrain({
      operationId: 'dbm_admission_04',
      sourceGenerationId: 'dbg_sqlite_04',
      timeoutMs: 1_000,
    })
    await expect(
      controller.migration.freezeAndDrain({
        operationId: 'dbm_admission_other',
        sourceGenerationId: 'dbg_sqlite_04',
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'database-admission-operation-conflict' })
    await expect(
      controller.migration.openPostgresqlAdmission({
        operationId: 'dbm_admission_04',
        generationId: 'dbg_postgresql_wrong',
      }),
    ).rejects.toMatchObject({ code: 'database-admission-state' })
  })

  test('shutdown aborts an in-flight drain without reopening writers', async () => {
    const calls: string[] = []
    const controller = createDatabaseMigrationDaemonAdmission({
      initialProvider: 'sqlite',
      initialGenerationId: 'dbg_sqlite_05',
      pauseBackgroundWriters: async () => {
        calls.push('pause')
      },
      switchProviderComposition: async () => {
        calls.push('switch')
      },
      resumeBackgroundWriters: async () => {
        calls.push('resume')
      },
    })
    const active = deferred<Response>()
    const request = controller.runBusinessRequest(
      new Request('http://localhost/api/tasks'),
      async () => await active.promise,
    )
    const freezing = controller.migration.freezeAndDrain({
      operationId: 'dbm_admission_05',
      sourceGenerationId: 'dbg_sqlite_05',
      timeoutMs: 1_000,
    })
    await Promise.resolve()
    controller.stop()
    await expect(freezing).rejects.toMatchObject({ code: 'database-admission-stopped' })
    expect(controller.live().phase).toBe('stopped')
    expect(calls).toEqual(['pause'])
    active.resolve(new Response('complete'))
    await request
  })
})
