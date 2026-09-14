// RFC-359 AC-11 —— PAT 的 `last_used_at` 触摸节流：与会话侧同一条窗口。
//
// # 为什么这条判据存在
//
// `d275618a5`（2026-08-28，"bound session activity writes"）给**会话**解析加了
// `SESSION_LAST_USED_WRITE_INTERVAL_MS` 窗口，理由是每请求一次 `last_used_at` 写把
// 100-client 维护档压垮。那一刀只改了会话，**PAT 侧没跟上**——同一个文件里两条同构路径
// 就此分叉：`resolveSessionByHash` 带窗口，`resolvePatByHash` 每请求无条件写。
//
// 这条分叉在 PostgreSQL 上的代价是 SQLite 的四倍。实测九个 HTTP 端点的语句画像
//（`tests/zzscratch` 一次性诊断，口径同 `scripts/perf-query-profile.ts`）：
//
//   端点              SQLite  PostgreSQL
//   reviews-pending      5        11
//   clarify-pending      5        11
//   overview            14        20
//
// 恒定 +6 的来源被钉死：PG 的每笔**非事务写**都要 `BEGIN` + 世代围栏 `SELECT` +
// 写 + `COMMIT` 四个往返（`postgresqlDatabaseClient.ts` 的 `withWriteFence`），
// 而每个认证请求固定带两笔这样的写——`token_audit` 插入与 PAT 的 `last_used_at` 更新。
// 于是 `reviews-pending` 这种只读端点 11 条语句里有 8 条是认证记账，真正的业务查询只有 1 条。
// 把 PAT 触摸纳入与会话同一条窗口，就在**两个引擎上**都从只读路径上摘掉一笔每请求写。
//
// # 锁三件事
//
// ① **首次使用必写**——PAT 的 `last_used_at` 可空（`schema.ts` 无 `.notNull()`）。
//    照抄会话侧的 `now - lastUsedAt >= interval` 会算出 `NaN`，`NaN >= 1000` 恒假，
//    于是**从未使用过的 PAT 永远不记录首次使用**。空值必须单独放行。
// ② **窗口内不写**——节流本身。
// ③ **跨窗口恢复写**——别把节流写成"只写一次"。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createAuthRuntimeFor } from '@/auth/composition'
import { AUTH_LAST_USED_WRITE_INTERVAL_MS } from '@/auth/application/authRuntime'
import { userPats } from '@/db/schema'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_800_000_000_000

describeEachProvider(
  'RFC-359 AC-11 · PAT 触摸节流（双引擎）',
  (harness) => {
    async function patFixture() {
      const auth = createAuthRuntimeFor({ db: harness.db, onCredentialRevoked: () => undefined })
      const admin = await auth.completeBootstrap(
        { username: `admin_${ulid()}`, displayName: 'A', passwordHash: 'h' },
        NOW,
      )
      const pat = await auth.createPat({
        userId: admin.id,
        name: 'automation',
        scopes: ['tasks:execute'],
        purpose: 'general',
        now: NOW + 1,
        expiresAt: NOW + 10_000_000,
      })
      const lastUsed = async () =>
        (
          await harness.db
            .select({ lastUsedAt: userPats.lastUsedAt })
            .from(userPats)
            .where(eq(userPats.id, pat.meta.id))
        )[0]!.lastUsedAt
      return { auth, pat, lastUsed }
    }

    test('① 首次使用必写：last_used_at 为空时不受窗口约束', async () => {
      const { auth, pat, lastUsed } = await patFixture()
      expect(await lastUsed()).toBeNull()
      // 首次解析距签发只有 1ms，远在窗口内——空值必须照写，否则首次使用永不落库。
      expect(await auth.lookupActivePat(pat.token, NOW + 2)).toMatchObject({ patId: pat.meta.id })
      expect(await lastUsed()).toBe(NOW + 2)
    })

    test('② 窗口内不再写，且不再开写事务', async () => {
      const { auth, pat, lastUsed } = await patFixture()
      await auth.lookupActivePat(pat.token, NOW + 2)
      expect(await lastUsed()).toBe(NOW + 2)

      const recording = harness.recordStatements()
      const inWindow = NOW + 2 + AUTH_LAST_USED_WRITE_INTERVAL_MS - 1
      expect(await auth.lookupActivePat(pat.token, inWindow)).toMatchObject({ patId: pat.meta.id })
      const statements = recording.statements.map((row) => String(row.sql))
      recording.stop()

      expect(await lastUsed()).toBe(NOW + 2)
      // 既锁"没写值"，也锁"没发写语句"——只锁值的话，改成写回同一个值也能骗过判据，
      // 而这条判据存在的唯一理由（PG 上那四个往返）就悄悄没了。
      expect(statements.filter((sql) => /update\s+.*user_pats/i.test(sql))).toEqual([])
      expect(statements.filter((sql) => /^\s*(BEGIN|COMMIT)\s*$/i.test(sql))).toEqual([])
    })

    test('③ 跨过窗口恢复写', async () => {
      const { auth, pat, lastUsed } = await patFixture()
      await auth.lookupActivePat(pat.token, NOW + 2)
      const after = NOW + 2 + AUTH_LAST_USED_WRITE_INTERVAL_MS
      expect(await auth.lookupActivePat(pat.token, after)).toMatchObject({ patId: pat.meta.id })
      expect(await lastUsed()).toBe(after)
    })
  },
  { bootstrap: 'required' },
)
