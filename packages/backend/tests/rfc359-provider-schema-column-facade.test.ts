// RFC-359 —— 列 facade 的双引擎锁。表 facade 在访问时解析到当前 provider 的具体表，但业务模块常在模块加载期就把
// 列对象捕获进常量（`const COLUMNS = { createdAt: table.createdAt }`），那时进程还没选 provider（默认 sqlite）。
// 修复前，捕获到的 SQLite 列在 PostgreSQL 上解码绕开了 pg 投影的 `bigint → number` 映射：mission 列表页的游标
// `createdAt` 在 PG 上回成字符串（2026-09-05 W4-D10 实撞）。这里故意在模块加载期捕获列，再在两个引擎上各跑一遍
// 解码 / 编码 / 行值比较 / 原型与身份，锁住「列的 provider 只在客户端」这一条。

import { expect, test } from 'bun:test'
import { desc, eq, getTableName, is, sql } from 'drizzle-orm'
import { PgColumn } from 'drizzle-orm/pg-core'
import { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'

import { missionInputUploads } from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

// 故意在模块加载期捕获：此刻进程级 provider 还是默认的 sqlite。
const CAPTURED = {
  id: missionInputUploads.id,
  bytes: missionInputUploads.bytes,
  createdAt: missionInputUploads.createdAt,
} as const

describeEachProvider('RFC-359 —— 模块加载期捕获的列按当前 provider 解析', (harness) => {
  test('解码走当前 provider 的映射：整数列回 number，不因捕获时机退化成字符串', async () => {
    const id = ulid()
    await harness.db.insert(missionInputUploads).values({
      id,
      actorUserId: 'actor-1',
      originalName: 'spec.md',
      bytes: 3,
      sha256: 'b'.repeat(64),
      blobRef: 'blob-1',
      expiresAt: NOW + 60_000,
      createdAt: NOW,
    })
    const row = (
      await harness.db
        .select({ bytes: CAPTURED.bytes, createdAt: CAPTURED.createdAt })
        .from(missionInputUploads)
        .where(eq(CAPTURED.id, id))
    )[0]
    expect(row).toEqual({ bytes: 3, createdAt: NOW })
    expect(typeof row?.createdAt).toBe('number')

    // 编码 / 行值比较 / 排序也走捕获列。
    const page = await harness.db
      .select({ id: CAPTURED.id })
      .from(missionInputUploads)
      .where(sql`(${CAPTURED.createdAt}, ${CAPTURED.id}) <= (${NOW}, ${id})`)
      .orderBy(desc(CAPTURED.createdAt), desc(CAPTURED.id))
      .limit(1)
    expect(page).toEqual([{ id }])
    await harness.db
      .update(missionInputUploads)
      .set({ bytes: 4 })
      .where(eq(CAPTURED.createdAt, NOW))
    expect(
      (
        await harness.db
          .select({ bytes: CAPTURED.bytes })
          .from(missionInputUploads)
          .where(eq(CAPTURED.id, id))
      )[0],
    ).toEqual({ bytes: 4 })
  })

  test('身份稳定，原型与所属表随当前 provider', () => {
    expect(missionInputUploads.createdAt).toBe(CAPTURED.createdAt)
    const engine = harness.capabilities.provider
    expect(is(CAPTURED.createdAt, engine === 'postgresql' ? PgColumn : SQLiteColumn)).toBe(true)
    expect(is(CAPTURED.createdAt, engine === 'postgresql' ? SQLiteColumn : PgColumn)).toBe(false)
    expect(getTableName(CAPTURED.createdAt.table)).toBe('mission_input_uploads')
    expect(CAPTURED.createdAt.name).toBe('created_at')
  })
})
