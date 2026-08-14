// RFC-287 G5 / T14 实现门 —— `file://` 的三条绕过通道。
//
// G5 的意图是「本机路径不得伪装成远端仓库被平台跑起来」。第一版只在两处落了判据
// （启动 schema + 后台保鲜），实现门一口气找出三条没被覆盖的通道。三条的形态各不
// 相同，但根因是同一个：**判据被手抄了两份**，于是每新增一条入口就多一次遗漏机会。
// 修法除了堵住这三条，还把判据收敛成 `isFileSchemeUrl` 单点，三处入口一律引它。
//
// 这个文件按「通道」而不是按「函数」组织：将来加第四条入口时，这里该多一个 describe。

import { describe, expect, test } from 'bun:test'
import {
  StartBatchImportRequestSchema,
  RetryBatchImportRowRequestSchema,
  StartTaskSchema,
  isFileSchemeUrl,
} from '@agent-workflow/shared'
import { selectDueRepos } from '@/services/submoduleRefresh'
import { createInMemoryDb } from '@/db/client'
import { cachedRepos } from '@/db/schema'
import { MIGRATIONS } from './migration-freeze'

const FILE_URL = 'file:///srv/private/repo'

describe('RFC-287 G5 — 判据单点化', () => {
  test('isFileSchemeUrl 认 scheme 且大小写/空白无关', () => {
    for (const s of [FILE_URL, '  file:///x  ', 'FILE:///x', 'File://host/x']) {
      expect(isFileSchemeUrl(s), s).toBe(true)
    }
    for (const s of [
      'https://e.com/x.git',
      'git@e.com:x.git',
      'ssh://e.com/x',
      '',
      'notfile://x',
    ]) {
      expect(isFileSchemeUrl(s), s).toBe(false)
    }
  })
})

describe('RFC-287 G5 绕过① — 批量导入 → cachedRepoId', () => {
  // 这条最要命：导入是**公共**接口，而它原先对 scheme 零检查。`file:///srv/private/repo`
  // 会被真的克隆进缓存，拿到 cachedRepoId 后再 POST /api/tasks 走 cachedRepoId 分支
  // ——启动面那道 refine 只看 repoUrl，根本不会被触发。两步就绕过去了。同一个
  // cachedRepoId 放进仓库组、或被 sourceTaskId 重放，同样会在启动时被转回 cache spec。
  test('POST /api/cached-repos/batch-import 拒 file://', () => {
    const r = StartBatchImportRequestSchema.safeParse({ urls: [FILE_URL] })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('repo-url-file-scheme-unsupported')
  })

  test('混在合法 URL 里也拒（逐项校验，不是只看第一个）', () => {
    const r = StartBatchImportRequestSchema.safeParse({
      urls: ['https://e.com/ok.git', FILE_URL],
    })
    expect(r.success).toBe(false)
  })

  test('单行重试的 URL 覆盖同样拒（否则导入拒了、重试又放进来）', () => {
    const r = RetryBatchImportRowRequestSchema.safeParse({ url: FILE_URL })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('repo-url-file-scheme-unsupported')
  })

  test('合法远端照常通过（别把正常导入一起拒了）', () => {
    expect(StartBatchImportRequestSchema.safeParse({ urls: ['https://e.com/x.git'] }).success).toBe(
      true,
    )
    expect(RetryBatchImportRowRequestSchema.safeParse({ url: 'https://e.com/x.git' }).success).toBe(
      true,
    )
  })
})

describe('RFC-287 G5 绕过③ — 后台保鲜对 url_redacted=NULL 的存量行', () => {
  // 过滤器原先只排除「非空字符串且匹配 file」，于是 NULL 行 fail-open 照旧保鲜。
  // NULL 不是理论情形：repairCachedRepoRedaction 在密钥丢失/轮换导致解封失败时会
  // continue，把 url_redacted 原样留在 NULL。
  function seed(
    db: ReturnType<typeof createInMemoryDb>,
    rows: Array<{ id: string; urlRedacted: string | null }>,
  ): void {
    const now = Date.now()
    for (const r of rows) {
      db.insert(cachedRepos)
        .values({
          id: r.id,
          urlHash: `h-${r.id}`,
          urlRedacted: r.urlRedacted,
          urlEnc: 'enc',
          localPath: `/tmp/${r.id}`,
          lastFetchedAt: now,
          lastAutoRefreshAt: null,
          createdAt: now,
        })
        .run()
    }
  }

  test('NULL 的 url_redacted 必须 fail-closed（不知 scheme 就不自动 fetch）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seed(db, [
      { id: 'ok', urlRedacted: 'https://e.com/x.git' },
      { id: 'file', urlRedacted: FILE_URL },
      { id: 'unknown', urlRedacted: null },
      { id: 'blank', urlRedacted: '   ' },
    ])
    const due = await selectDueRepos(db, {
      now: Date.now(),
      intervalMs: 1,
      onlyRecentDays: 3650,
    })
    expect(due.map((r) => r.id)).toEqual(['ok'])
  })
})

describe('RFC-287 G5 — 启动面回归（判据换成共享谓词后行为不变）', () => {
  test('repoUrl=file:// 仍被 StartTaskSchema 拒', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf',
      name: 'x',
      repoUrl: FILE_URL,
      inputs: {},
    })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('repo-url-file-scheme-unsupported')
  })
})
