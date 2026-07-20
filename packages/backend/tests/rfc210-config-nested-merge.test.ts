// RFC-210 T8 — 嵌套 config 字段的深合并改为从 DEFAULT_CONFIG 推导。
//
// 为什么这条测试存在：
//
// `mergeDefaults` / `mergePatch` 过去用一对手写的 `if (k === 'worktreeAutoGc')
// … else if (k === 'eventsArchiveThresholds')` 分支列举要深合并的键。后果有二，
// 都是静默的：
//
//  a) **daemon 起不来**。给某个嵌套对象加内层字段后，用户磁盘上的旧 config.json
//     会被原样透传（不在列举里 ⟹ 不深合并 ⟹ 缺字段），`ConfigSchema.safeParse`
//     失败，`loadConfig` 抛错。这两个函数存在的唯一理由就是防这个。
//  b) **PATCH 丢兄弟字段**。`PATCH {x:{a:1}}` 对未登记的嵌套键是整体替换而非
//     部分更新，`x.b` 无声消失。
//
// 改为从 DEFAULT_CONFIG 推导之后，任何新嵌套字段自动获得这两项保护。这条测试
// 锁的正是"自动"——它用一个 DEFAULT_CONFIG 里**当前存在**的嵌套键做断言，
// 并额外验证 RFC-210 新加的 submoduleAutoRefresh 已经享受到同等待遇。
//
// 另：submoduleAutoRefresh 在 schema 上必须是 optional。把它写成必填会让所有
// 存量 config.json 解析失败——那正是 packages/shared 的 compat-config-versions
// 测试要抓的 footgun（本 RFC 实现时真的踩了一次，由该测试拦下）。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, DEFAULT_CONFIG } from '@agent-workflow/shared'
import { applyConfigPatch, loadConfig } from '@/config'

function withTempConfig<T>(raw: unknown, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc210-cfg-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(raw, null, 2))
  try {
    return fn(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('RFC-210 nested config deep-merge', () => {
  test('a config.json predating submoduleAutoRefresh still loads', () => {
    // Exactly the upgrade path: the file on disk has no idea this field exists.
    const cfg = withTempConfig({ $schema_version: 1, logLevel: 'debug' }, (p) => loadConfig(p))
    expect(cfg.logLevel).toBe('debug')
    expect(cfg.submoduleAutoRefresh?.enabled).toBe(true) // filled from DEFAULT_CONFIG
  })

  test('the schema keeps submoduleAutoRefresh optional (daemon-boot footgun)', () => {
    // A full, valid config that simply predates the field — i.e. exactly what an
    // upgrading user has on disk. Making the field required fails right here.
    const { submoduleAutoRefresh: _omitted, ...withoutIt } = DEFAULT_CONFIG
    expect(ConfigSchema.safeParse(withoutIt).success).toBe(true)
  })

  test('a partial nested object on disk is merged over its defaults, not replaced', () => {
    const cfg = withTempConfig(
      { $schema_version: 1, submoduleAutoRefresh: { enabled: false } },
      (p) => loadConfig(p),
    )
    expect(cfg.submoduleAutoRefresh?.enabled).toBe(false)
    // Sibling defaults survive rather than vanishing.
    expect(cfg.worktreeAutoGc.enabled).toBe(DEFAULT_CONFIG.worktreeAutoGc.enabled)
  })

  test('PATCH of one inner field preserves the others', () => {
    withTempConfig(
      { $schema_version: 1, worktreeAutoGc: { enabled: true, olderThanDays: 42 } },
      (p) => {
        const next = applyConfigPatch(p, { worktreeAutoGc: { enabled: false } })
        expect(next.worktreeAutoGc.enabled).toBe(false)
        // Would be lost under replace-semantics.
        expect(next.worktreeAutoGc.olderThanDays).toBe(42)
      },
    )
  })

  test('PATCH of submoduleAutoRefresh behaves the same as the legacy nested keys', () => {
    withTempConfig(
      { $schema_version: 1, submoduleAutoRefresh: { enabled: true, onlyRecentDays: 7 } },
      (p) => {
        const next = applyConfigPatch(p, { submoduleAutoRefresh: { enabled: false } })
        expect(next.submoduleAutoRefresh?.enabled).toBe(false)
        expect(next.submoduleAutoRefresh?.onlyRecentDays).toBe(7)
      },
    )
  })

  test('every nested default is deep-merged — no hand-maintained key list', () => {
    // The point of deriving the set: this assertion must hold for keys that do
    // not exist yet. Enumerating them here would recreate the very list the
    // production code stopped hard-coding, so instead we assert the property
    // over whatever DEFAULT_CONFIG currently declares.
    const nested = Object.entries(DEFAULT_CONFIG).filter(
      ([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v),
    )
    expect(nested.length).toBeGreaterThan(1)
    for (const [key, defaults] of nested) {
      const keys = Object.keys(defaults as Record<string, unknown>)
      if (keys.length === 0) continue // e.g. autoRepair: {}
      const cfg = withTempConfig({ $schema_version: 1, [key]: {} }, (p) => loadConfig(p))
      const merged = (cfg as unknown as Record<string, unknown>)[key] as Record<string, unknown>
      for (const inner of keys) {
        expect(merged).toHaveProperty(inner)
      }
    }
  })
})
