// RFC-395 I-b: native instr/strpos preserve search and recursive-path behavior in both provider lanes.
import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { rawFirst } from '@/platform/persistence/queryHelpers'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-395 I-b instr capability', (harness) => {
  test('one-based position, absent/empty needles, Unicode, and NULL are identical', async () => {
    for (const [value, needle, expected] of [
      ['abcd', 'bc', 2],
      ['abcd', 'x', 0],
      ['', '', 1],
      ['abcd', '', 1],
      ['零😀甲乙', '甲', 3],
      ['AbC', 'bc', 0],
      [null, 'x', null],
      ['abc', null, null],
      [',root,child,', ',child,', 6],
      [',root,child,', ',hil,', 0],
    ] as const) {
      const row = await rawFirst<{ position: number | null }>(
        harness.db,
        sql`select ${harness.capabilities.instr(value, needle)} as position`,
        { position: 'int' },
      )
      expect(row?.position, JSON.stringify([value, needle])).toBe(expected)
    }
  })
  test('the existing greatest capability remains the scalar maximum path', async () => {
    const row = await rawFirst<{ value: number }>(
      harness.db,
      sql`select ${harness.capabilities.greatest(sql`${-1}`, sql`${4}`)} as value`,
      { value: 'int' },
    )
    expect(row?.value).toBe(4)
  })
})
