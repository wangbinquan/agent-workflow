// RFC-029 T10 — i18n completeness for the Runtime Inventory section.
//
// 1. Every key path RFC-029 added (title / pending / chip / subtitle /
//    col / source / status / reason) is present in BOTH locales.
// 2. Reason codes match the InventoryReasonCodeSchema enum (any new code
//    that lands without a matching translation will fail this test).

import { describe, expect, it } from 'vitest'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

const REASON_CODES = [
  'file-missing',
  'parse-failed',
  'opencode-pure-mode',
  'plugin-load-failed',
  'dump-plugin-internal-error',
  'non-agent-kind',
  // RFC-062: shown for running runs whose inventory.json hasn't been
  // persisted to the DB column yet (between dump-plugin write and runner
  // post-exit read).
  'in-flight',
  // RFC-297: 跨运行时统一后新增的归因。前三条属「本来就不会有」，不是故障——
  // 尤其 `runtime-has-no-inventory` 就是替掉那句对 Claude Code 甩锅的
  // 「插件可能加载失败」的。
  'runtime-has-no-inventory',
  'no-observation-recorded',
  'no-init-event',
  'inventory-not-read',
  'session-reused',
] as const

const SOURCE_KINDS = ['inline', 'project', 'global', 'native', 'unknown'] as const

const STATUS_KEYS = [
  'connected',
  'disabled',
  'needs_auth',
  'needs_client_registration',
  'failed',
  'not_initialized',
] as const

describe('RFC-029 i18n — inventory keys', () => {
  it('zh-CN: title / pending / empty exist with non-empty values', () => {
    expect(zhCN.nodeDrawer.inventory.title.length).toBeGreaterThan(0)
    expect(zhCN.nodeDrawer.inventory.pending.length).toBeGreaterThan(0)
    expect(zhCN.nodeDrawer.inventory.empty.length).toBeGreaterThan(0)
  })

  it('en-US: title / pending / empty exist with non-empty values', () => {
    expect(enUS.nodeDrawer.inventory.title.length).toBeGreaterThan(0)
    expect(enUS.nodeDrawer.inventory.pending.length).toBeGreaterThan(0)
    expect(enUS.nodeDrawer.inventory.empty.length).toBeGreaterThan(0)
  })

  it('chip / subtitle / col groups exist in both locales', () => {
    for (const locale of [zhCN, enUS]) {
      const inv = locale.nodeDrawer.inventory
      for (const k of ['agents', 'skills', 'mcps', 'plugins'] as const) {
        expect(inv.chip[k].length).toBeGreaterThan(0)
        expect(inv.subtitle[k].length).toBeGreaterThan(0)
      }
      const cols = inv.col
      for (const c of [
        'name',
        'mode',
        'model',
        'source',
        'path',
        'desc',
        'status',
        'type',
        'hint',
        'specifier',
      ] as const) {
        expect(cols[c].length).toBeGreaterThan(0)
      }
    }
  })

  it('every InventoryReasonCode has a translated message in both locales', () => {
    for (const reason of REASON_CODES) {
      expect(zhCN.nodeDrawer.inventory.reason[reason].length).toBeGreaterThan(0)
      expect(enUS.nodeDrawer.inventory.reason[reason].length).toBeGreaterThan(0)
    }
  })

  it('every source kind has a translated label in both locales', () => {
    for (const k of SOURCE_KINDS) {
      expect(zhCN.nodeDrawer.inventory.source[k].length).toBeGreaterThan(0)
      expect(enUS.nodeDrawer.inventory.source[k].length).toBeGreaterThan(0)
    }
  })

  it('every MCP status enum has a translated label in both locales', () => {
    for (const k of STATUS_KEYS) {
      expect(zhCN.nodeDrawer.inventory.status[k].length).toBeGreaterThan(0)
      expect(enUS.nodeDrawer.inventory.status[k].length).toBeGreaterThan(0)
    }
  })
})

describe('RFC-297 i18n — 跨运行时统一后新增的键', () => {
  const FACES = ['agents', 'skills', 'mcps', 'plugins', 'tools'] as const
  const PROVENANCE = ['injected', 'ambient', 'declaredMissing'] as const

  it('五个面的 chip / subtitle 双语齐全（含新增的 tools 面）', () => {
    for (const face of FACES) {
      expect(zhCN.nodeDrawer.inventory.chip[face].length).toBeGreaterThan(0)
      expect(enUS.nodeDrawer.inventory.chip[face].length).toBeGreaterThan(0)
      expect(zhCN.nodeDrawer.inventory.subtitle[face].length).toBeGreaterThan(0)
      expect(enUS.nodeDrawer.inventory.subtitle[face].length).toBeGreaterThan(0)
    }
  })

  it('来源对账三态双语齐全', () => {
    for (const key of PROVENANCE) {
      expect(zhCN.nodeDrawer.inventory.provenance[key].length).toBeGreaterThan(0)
      expect(enUS.nodeDrawer.inventory.provenance[key].length).toBeGreaterThan(0)
    }
  })

  it('新增的说明性文案双语齐全（列名 / 不可观测 / 加载失败）', () => {
    for (const bundle of [zhCN, enUS]) {
      expect(bundle.nodeDrawer.inventory.col.provenance.length).toBeGreaterThan(0)
      expect(bundle.nodeDrawer.inventory.col.description.length).toBeGreaterThan(0)
      expect(bundle.nodeDrawer.inventory.faceUnobservable.length).toBeGreaterThan(0)
      expect(bundle.nodeDrawer.inventory.fieldUnobservable.length).toBeGreaterThan(0)
      expect(bundle.nodeDrawer.inventory.loadFailed.length).toBeGreaterThan(0)
    }
  })

  it('产品意图锁：新归因文案不得再赖插件（用户实证 bug 的回归防护）', () => {
    // 旧文案「未生成清单文件（插件可能加载失败）」被甩给了一个 Claude Code 根本
    // 没有的插件。这几条是替代它的，任何一条重新提到插件都是走回头路。
    for (const code of [
      'runtime-has-no-inventory',
      'no-observation-recorded',
      'no-init-event',
      'session-reused',
    ] as const) {
      expect(zhCN.nodeDrawer.inventory.reason[code]).not.toContain('插件')
      expect(enUS.nodeDrawer.inventory.reason[code].toLowerCase()).not.toContain('plugin')
    }
  })
})
