// RFC-311 T19 —— `POST /api/tasks/archive` 必须真的到得了它自己的权限门。
//
// 由来：`e2e-full-nightly` / `e2e-webkit-nightly` 的 OPS-038 自 2026-09-06 起连红十三晚，
// 报的是「POST /api/tasks/archive 没挡住 ⇒ 只读账号能把全库终态任务批量删掉，
// Expected 403 / Received 404」。404 不是「没挡住」，是**这条路由根本没被走到**：
//
//   routes/tasks.ts 给任务子资源装了一道可见性中间件 `'/api/tasks/:id/*'`，而 **Hono 的 `*`
//   能匹配零个段**——实测 `app.use('/api/tasks/:id/*')` 会命中 `POST /api/tasks/archive`
//   并把 `id` 解成字符串 `'archive'`。中间件于是去查一个叫 `archive` 的任务，查不到就
//   `task-not-found` 404，路由自己的 `settings:write` 门永远轮不到执行。
//
// 为什么两周没人看见：`assertTaskVisibleProjection` 第一句是
// `if (actor.permissions.has('tasks:read:all')) return`——**管理员直接短路**。既有的
// `rfc311-task-archive.test.ts` 全程用管理员 token，于是一路 200；而任何**非管理员**
// （包括被授了 `settings:write` 的普通账号）打这条端点都只会拿到 404：设置页维护区的
// 「按条件批量归档」对他们**整个不可用**，且报的是一个无从解释的 404。
//
// 处置是挂载次序：把 `taskArchive` 的字面路由挂在 `tasks` **之前**。Hono 的中间件与处理器
// 按注册顺序组链，先注册的终结处理器会在中间件之前收口（实测：archive-first 时中间件
// 一次都不跑，而 `/api/tasks/:id` 与 `/api/tasks/:id/diff` 照旧命中中间件）。
//
// 这条测试钉的是**结果**而不是次序本身：非管理员打到的必须是它自己的权限门（403），
// 不是 404。次序写错、中间件 pattern 改回吞掉兄弟字面量，这条都会红。

import { expect, test } from 'bun:test'

import { createUser } from '@/services/users'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { createSession } from './helpers/auth/sessionStore'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const ARCHIVE_BODY = { retentionDays: 90, dryRun: false } as const

async function tokenFor(
  db: ProviderNeutralDatabase,
  username: string,
  additionalPermissions: readonly string[],
): Promise<string> {
  const user = await createUser(db, {
    username,
    displayName: username,
    role: 'user',
    password: 'longEnoughPassword',
    additionalPermissions: additionalPermissions as never,
  })
  return (await createSession({ db, userId: user.id })).token
}

describeEachProviderHttpApplication(
  'RFC-311 —— /api/tasks/archive 的可达性（非管理员打到的是权限门，不是 404）',
  {
    token: 'a'.repeat(64),
    opencodeVersion: '1.14.25',
    dbVersion: 17,
    tempPrefix: 'aw-rfc311-archive-reach-',
  },
  (scope) => {
    const post = async (token: string): Promise<number> => {
      const { app } = await scope.open()
      return (
        await app.request('/api/tasks/archive', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(ARCHIVE_BODY),
        })
      ).status
    }

    test('没有 settings:write 的普通账号被这条路由自己的权限门挡住（403，不是 404）', async () => {
      const token = await tokenFor(scope.harness.db, 'archive-readonly', ['settings:read'])
      expect(await post(token)).toBe(403)
    })

    test('被授了 settings:write 的普通账号真的到得了这条路由（不是 404）', async () => {
      const token = await tokenFor(scope.harness.db, 'archive-writer', [
        'settings:read',
        'settings:write',
      ])
      // 到不到得了看的是「不是 404」：库里没有可归档的树，路由自己会以 200 回执或按
      // retentionDays 校验作答，两者都证明它被执行了；404 才说明中间件把它吞了。
      expect(await post(token)).not.toBe(404)
    })
  },
)
