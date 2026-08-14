// RFC-287 T11（G5）—— `file://` 从此**不是可运行的来源**，按非法参数处理。
//
// 用户拍板：「从此再也不支持运行，直接非法参数」。要害在于**拒在哪**：
//
//   · 拒在 `startTask` / `resolveCachedRepo` 会连内部通道一起掐掉——那两处是内部
//     服务入口，HTTP 路由与大量夹具共用同一个函数；
//   · 拒在**公共面的解析点**（`refineRepoSourceFields`，RFC-204 定的「每仓来源规则
//     只写一次」的单点）正好落在内外通道的天然分界上：JSON 启动、multipart 启动、
//     定时任务 payload 都经它，而内部服务层直接构造 spec 天然绕开。
//
// 后台自动保鲜是**第二条独立通道**：它按 last_fetched_at 自己选行、不经任何启动
// 校验。漏掉它，一个再也不能被启动的 file:// 镜像仍会被 daemon 定时 fetch。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { StartTaskSchema } from '@agent-workflow/shared'
import { selectDueRepos } from '@/services/submoduleRefresh'
import { createInMemoryDb } from '@/db/client'
import { cachedRepos } from '@/db/schema'
import { ulid } from 'ulid'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function startBody(repoUrl: string): Record<string, unknown> {
  return { workflowId: '01JQZ0000000000000000000AA', name: 'probe', repoUrl }
}

describe('RFC-287 T11 ① — 启动面按非法参数拒 file://', () => {
  test('file:// 来源被拒，错误码是 repo-url-file-scheme-unsupported', () => {
    const parsed = StartTaskSchema.safeParse(startBody('file:///tmp/some/repo'))
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const codes = parsed.error.issues.map((i) => i.message)
    expect(codes).toContain('repo-url-file-scheme-unsupported')
  })

  test('大小写与前后空白都拦得住（不是只挡最规整的那一种写法）', () => {
    for (const url of ['FILE:///tmp/x', '  file:///tmp/x  ', 'File://localhost/tmp/x']) {
      const parsed = StartTaskSchema.safeParse(startBody(url))
      expect(parsed.success, url).toBe(false)
    }
  })

  test('http/https/ssh/scp 四种真实远端不受影响（别误伤）', () => {
    for (const url of [
      'https://example.com/a/b.git',
      'http://127.0.0.1:8080/a/b.git',
      'ssh://git@example.com/a/b.git',
      'git@example.com:a/b.git',
    ]) {
      const parsed = StartTaskSchema.safeParse(startBody(url))
      const codes = parsed.success ? [] : parsed.error.issues.map((i) => i.message)
      expect(codes, url).not.toContain('repo-url-file-scheme-unsupported')
    }
  })
})

describe('RFC-287 T11 ② — 后台自动保鲜也不再碰 file:// 存量镜像', () => {
  test('到期集合里 file:// 行被剔除，其余照常', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const now = 1_700_000_000_000
    const rows = [
      { url: 'file:///tmp/legacy-mirror', keep: false },
      { url: 'https://example.com/a.git', keep: true },
      { url: 'ssh://git@example.com/b.git', keep: true },
    ]
    const ids = new Map<string, boolean>()
    for (const [i, r] of rows.entries()) {
      const id = ulid()
      ids.set(id, r.keep)
      await db.insert(cachedRepos).values({
        id,
        // ULID 前 8 位在同一毫秒内相同——用序号做 url_hash，否则撞唯一约束。
        urlHash: `h${String(i)}`,
        urlRedacted: r.url,
        localPath: `/tmp/repos/${id}`,
        lastFetchedAt: now - 1_000,
        createdAt: now - 1_000,
      })
    }
    const due = await selectDueRepos(db, { now, intervalMs: 1, onlyRecentDays: 30 })
    const dueIds = new Set(due.map((d) => d.id))
    for (const [id, keep] of ids) {
      expect(dueIds.has(id), `${id} keep=${String(keep)}`).toBe(keep)
    }
  })
})

describe('RFC-287 T11 ③ — 内外通道源码锁', () => {
  // 二轮实现门纠正：这条锁原先**方向反了**——它断言 `services/task.ts` 不得含该
  // 错误码，理由写的是「在 startTask 上加判据会把内部夹具通道一起掐掉」。那个前提
  // 不成立，design §10.7「第三轮门修正」已核实：内部通道 `internalSource` 是
  // **local-path 面**（`'repoPath' in spec` 在 resolveRepoSourceSingle 开头就早
  // 返回），**根本不承载 `file://` URL**。
  //
  // 于是这条锁把 design 指定的收口点锁成了禁区，实际后果是：存量 `file://` 缓存行
  // 拿 cachedRepoId 启动、放进仓库组、被 sourceTaskId 重放，全部照跑——G5 对存量
  // 完全失效。断言随之翻面。
  test('拒绝落在服务层的来源汇流点（schema 只作早报错的附加层）', () => {
    const shared = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'schemas', 'task.ts'),
      'utf8',
    )
    // schema 层保留：直填 URL 时能早一步报错，体验更好。但它**不是**判据的所在，
    // 因为公开面自 RFC-204 起传的是 cachedRepoId 而不是 URL。
    expect(shared).toContain('repo-url-file-scheme-unsupported')

    // 真正的收口点：两条来源分支（id 反查解封 / 直填）汇流成 `sourceUrl` 之后、
    // `resolveCachedRepo` 之前。一处覆盖 URL 直填 / cachedRepoId 反查 / 仓库组成员 /
    // 多仓循环 / sourceTaskId 重放 / webhook 命中存量缓存。
    const taskSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'),
      'utf8',
    )
    const fnStart = taskSrc.indexOf('export async function resolveRepoSourceSingle')
    expect(fnStart, '收口点所在函数应存在').toBeGreaterThan(0)
    const body = taskSrc.slice(fnStart, taskSrc.indexOf('\nasync function ', fnStart + 10))
    const guard = body.indexOf('isFileSchemeUrl(sourceUrl)')
    const use = body.indexOf('resolveCachedRepo(')
    expect(guard, 'resolveRepoSourceSingle 必须拒 file:// 来源').toBeGreaterThan(-1)
    expect(use).toBeGreaterThan(-1)
    expect(guard, '判据必须在 resolveCachedRepo 之前').toBeLessThan(use)

    // 刷新是启动之外的第二条运行面，同拒。
    const cacheSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
      'utf8',
    )
    expect(cacheSrc).toMatch(/refreshCachedRepo[\s\S]{0,1200}isFileSchemeUrl\(row\.urlRedacted\)/)

    // 反向：**注册面刻意不拒**（design §10.7 划为不动面，存量可见不可运行）。
    // 在那里加拒绝会误伤允许面，并给人「已经堵住了」的错觉。
    const batch = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'schemas', 'repoBatchImport.ts'),
      'utf8',
    )
    expect(batch, '批量导入不得拒 file://（注册面不动）').not.toContain(
      'repo-url-file-scheme-unsupported',
    )
  })

  test('后台保鲜的过滤按 url_redacted 判（明文只以密文列存在）', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'submoduleRefresh.ts'),
      'utf8',
    )
    // T14 改锚：判据已收敛成共享谓词 `isFileSchemeUrl`（G5 第一版手抄了两份，实现门
    // 因此一口气找出三条没被抄到的入口）。锁的**意图**不变——过滤仍只看
    // `url_redacted`、不解密任何东西——但锚点从字面 `file:` 换成「读 urlRedacted 且
    // 走共享谓词」，否则收敛判据这个正确动作反而会把这条锁打红。
    expect(src).toMatch(/isFileSchemeUrl\(r\.urlRedacted\)/)
    // 反向：这里不得自己再写一遍 scheme 正则（那就是第四份手抄）。
    expect(src).not.toMatch(/\/\^file:/)
    // 且必须 fail-closed：url_redacted 为 NULL / 空白时不知 scheme，不能自动 fetch。
    // 行为断言在 rfc287-t14-file-scheme-bypasses.test.ts，这里只锁住判断确实存在。
    expect(src).toMatch(/urlRedacted !== 'string'[\s\S]{0,120}return false/)
  })
})
