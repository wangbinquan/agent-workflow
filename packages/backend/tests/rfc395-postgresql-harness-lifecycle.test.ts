// RFC-395 T18 PGF: a timed-out fixture must not reuse another file's database or retain its admin pool.
import { expect, test } from 'bun:test'
import {
  closePostgresqlFixtureDatabases,
  createPostgresqlFileDatabase,
} from './helpers/eachProvider'

const baseUrl = 'postgresql://localhost/pgf_fixture'

function connections(failure?: { statement: string; error: Error }) {
  const opened: { url: string | undefined; statements: string[]; closed: boolean }[] = []
  const connect: NonNullable<Parameters<typeof createPostgresqlFileDatabase>[2]> = (url) => {
    const record = { url, statements: [] as string[], closed: false }
    opened.push(record)
    return {
      async unsafe(statement) {
        record.statements.push(statement)
        if (statement.startsWith(failure?.statement ?? '\0')) throw failure!.error
        return []
      },
      async close(options) {
        expect(options.timeout).toBe(5)
        record.closed = true
      },
    }
  }
  return { opened, connect }
}

test('same pid and ordinal get disjoint databases; a late drop targets only its own database', async () => {
  const fixture = connections()
  const first = await createPostgresqlFileDatabase(baseUrl, 1, fixture.connect)
  const second = await createPostgresqlFileDatabase(baseUrl, 1, fixture.connect)
  expect(first.url).not.toBe(second.url)
  expect(fixture.opened.every((connection) => connection.closed)).toBe(true)
  expect(fixture.opened.map((connection) => connection.statements.length)).toEqual([1, 1])
  expect(fixture.opened.every((connection) => connection.statements[0]!.startsWith('create'))).toBe(
    true,
  )
  await first.drop()
  const drop = fixture.opened[2]!
  expect(drop.url).toBe(baseUrl)
  expect(drop.closed).toBe(true)
  expect(drop.statements.at(-1)).toBe(
    `drop database if exists "${new URL(first.url!).pathname.slice(1)}"`,
  )
  expect(drop.statements.join('\n')).not.toContain(new URL(second.url!).pathname.slice(1))
  await second.drop()
})

test('failed CREATE and DROP both close their administrative connection and preserve the failure', async () => {
  for (const statement of ['create database', 'drop database']) {
    const error = new Error(statement)
    const fixture = connections({ statement, error })
    const operation = async () => {
      const database = await createPostgresqlFileDatabase(baseUrl, 1, fixture.connect)
      await database.drop()
    }
    await expect(operation()).rejects.toBe(error)
    expect(fixture.opened.every((connection) => connection.closed)).toBe(true)
  }
})

test('a pool close or child database drop failure still cleans every other resource', async () => {
  const events: string[] = []
  const closeError = new Error('first pool close')
  const dropError = new Error('first database drop')
  const cleanup = closePostgresqlFixtureDatabases(
    [
      {
        async close() {
          events.push('close actual')
          throw closeError
        },
      },
      {
        async close() {
          events.push('close reference')
        },
      },
    ],
    [
      {
        async drop() {
          events.push('drop actual')
          throw dropError
        },
      },
      {
        async drop() {
          events.push('drop reference')
        },
      },
    ],
  )
  const failure = await cleanup.then(
    () => null,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([closeError, dropError])
  expect(events).toEqual(['close actual', 'close reference', 'drop actual', 'drop reference'])
})
