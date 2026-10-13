// RFC-371: materialized scope/visibility arrays need the same full JSON value
// in both providers; string-only identity extraction would silently drop them.
import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { jsonPathArray } from '@/platform/persistence/jsonPathArray'
import { jsonPathText } from '@/platform/persistence/jsonPathText'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 original nested JSON identities and scope arrays', (h) => {
  test('array order, duplicates, objects and decimal strings survive without scalar coercion', async () => {
    const scopes = [{ task: 'a', count: '9007199254740993' }, { task: 'b' }, { task: 'a' }]
    const document = JSON.stringify({
      detail: { scopes, visibility: [] },
      request: { reportId: 'report-7' },
    })
    const row = (
      await h.db.all<{
        scopes: string | null
        empty: string | null
        identity: string | null
        wrongIdentity: string | null
      }>(sql`SELECT
      ${jsonPathArray(h.db, sql`${document}`, ['detail', 'scopes'])} AS scopes,
      ${jsonPathArray(h.db, sql`${document}`, ['detail', 'visibility'])} AS empty,
      ${jsonPathText(h.db, sql`${document}`, ['request', 'reportId'])} AS identity,
      ${jsonPathText(h.db, sql`${document}`, ['detail', 'scopes'])} AS "wrongIdentity"`)
    )[0]
    expect(engineOf(h.db)).toBe(h.session.engine)
    expect(JSON.parse(row!.scopes!)).toEqual(scopes)
    expect(JSON.parse(row!.empty!)).toEqual([])
    expect(row!.identity).toBe('report-7')
    expect(row!.wrongIdentity).toBeNull()
  })
  // The client has no resultKind, while its real transaction does. Both must
  // render the original nested path rather than PG's top-level SQLite shim.
  test('plain client and transaction retain the same original nested arrays and strings', async () => {
    const document = JSON.stringify({
      detail: { scopes: [{ task: 'original', count: '9007199254740993' }, { task: 'original' }] },
      request: { reportId: 'nested-original' },
    })
    const query = (handle: Parameters<typeof jsonPathArray>[0]) =>
      sql`SELECT ${jsonPathArray(handle, sql`${document}`, ['detail', 'scopes'])} AS scopes, ${jsonPathText(handle, sql`${document}`, ['request', 'reportId'])} AS identity`
    const direct = await h.db.all<{ scopes: string; identity: string }>(query(h.db))
    const retained = await h.session.snapshotRead(async (tx) => {
      expect(engineOf(tx)).toBe(h.session.engine)
      return await tx.all<{ scopes: string; identity: string }>(query(tx))
    })
    expect(retained).toEqual(direct)
    expect(JSON.parse(direct[0]!.scopes)).toEqual([
      { task: 'original', count: '9007199254740993' },
      { task: 'original' },
    ])
    expect(direct[0]!.identity).toBe('nested-original')
  })
  test('missing, malformed and scalar members cannot become an array', async () => {
    for (const document of [
      '{',
      '{}',
      '{"detail":{"scopes":null}}',
      '{"detail":{"scopes":"[]"}}',
      '{"detail":{"scopes":17}}',
      '{"detail":{"scopes":{}}}',
    ]) {
      const row = (
        await h.db.all<{ value: string | null }>(
          sql`SELECT ${jsonPathArray(h.db, sql`${document}`, ['detail', 'scopes'])} AS value`,
        )
      )[0]
      expect(row!.value).toBeNull()
    }
    expect(() => jsonPathArray(h.db, sql`'{}'`, [])).toThrow(RangeError)
    expect(() => jsonPathArray(h.db, sql`'{}'`, ['detail.scopes'])).toThrow(RangeError)
  })
})
