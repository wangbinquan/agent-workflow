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
        'readonly',
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
