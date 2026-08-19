// RFC-311 T19 — 设置页「最小写入白名单」的自动对账。
//
// 背景(真事故):`SETTINGS_CONFIG_SCOPE_KEYS` 是每个设置分区**允许写回**的键集合,
// 漏登记的键在保存时被静默丢掉——界面照常改、点保存没有任何报错、值却没落盘。
// RFC-311 一次性给 GC 分区加了 4 个键(三个保留旋钮 + taskArchive),4 个全漏了,
// 而当时既有的测试(bounds parity / card surfaces / 各 tab 的渲染测试)一条都没红:
// 它们各自只看「控件在不在」「边界对不对」,没有人看「这个键能不能存下去」。
//
// 这条守卫把两边直接对上:每个 tab 源码里真正读写的 config 键,必须出现在该 tab 的
// 白名单里。源码扫描是刻意的——它对「新加一个字段忘了登记」这一种遗漏免疫,而这
// 正是会静默丢数据的那一种。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import { SETTINGS_CONFIG_SCOPE_IDS, SETTINGS_CONFIG_SCOPE_KEYS } from '../src/lib/settings-drafts'

const SOURCE = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
  'utf8',
)

/** 每个 `useTabState(SETTINGS_CONFIG_SCOPE_IDS.x)` 到下一个之间的源码片段。 */
function tabSlices(): Array<{ scope: string; body: string }> {
  const anchor = /useTabState\(SETTINGS_CONFIG_SCOPE_IDS\.(\w+)/g
  const hits: Array<{ scope: string; index: number }> = []
  for (const m of SOURCE.matchAll(anchor)) {
    hits.push({ scope: m[1]!, index: m.index! })
  }
  // 失败关闭:扫描面必须**恰好**覆盖全部已声明的 scope。只断言 `> 0` 的话,
  // 某个 tab 挪进 components/settings/*.tsx 之类的新文件后,这条守卫会静默地
  // 少覆盖一个分区而依旧全绿——枚举式守卫最常见的空洞绿形态。
  expect([...new Set(hits.map((h) => h.scope))].sort()).toEqual(
    Object.keys(SETTINGS_CONFIG_SCOPE_IDS).sort(),
  )
  return hits.map((hit, i) => ({
    scope: hit.scope,
    body: SOURCE.slice(hit.index, hits[i + 1]?.index ?? SOURCE.length),
  }))
}

/** 片段里被当作 config 字段读写的顶层键。 */
function configKeysIn(body: string): string[] {
  const keys = new Set<string>()
  for (const m of body.matchAll(/\bstate\.([A-Za-z][A-Za-z0-9_]*)/g)) keys.add(m[1]!)
  for (const m of body.matchAll(/\.\.\.state,\s*([A-Za-z][A-Za-z0-9_]*)\s*:/g)) keys.add(m[1]!)
  return [...keys]
}

describe('settings tabs only touch keys their scope may write', () => {
  test.each(tabSlices())('$scope tab keys are all registered', ({ scope, body }) => {
    const allowed = SETTINGS_CONFIG_SCOPE_KEYS[
      scope as keyof typeof SETTINGS_CONFIG_SCOPE_KEYS
    ] as readonly string[]
    expect(allowed, `${scope} has no key allowlist`).toBeDefined()
    for (const key of configKeysIn(body)) {
      expect(
        allowed.includes(key),
        `settings.tsx ${scope} tab reads/writes config.${key}, but SETTINGS_CONFIG_SCOPE_KEYS.${scope} does not list it — saves would silently drop it`,
      ).toBe(true)
    }
  })

  test('the GC scope carries every RFC-311 knob that deletes data', () => {
    // 这四个键各自对应一个「会删东西」的旋钮,值丢了 = 用户以为配了、其实没配。
    for (const key of [
      'backupProtectedKeepCount',
      'eventStreamRetentionDays',
      'webhookTriggerFiresRetentionDays',
      'taskArchive',
    ]) {
      expect(SETTINGS_CONFIG_SCOPE_KEYS.gc as readonly string[]).toContain(key)
    }
  })
})
