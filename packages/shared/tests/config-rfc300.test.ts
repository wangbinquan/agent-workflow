// RFC-300 — direct Webhook terminal workspace cleanup is an explicit,
// default-off setting. It is a top-level scalar so old config files are
// backfilled by ConfigSchema/default merge without a schema migration.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config.js'

describe('RFC-300 · Webhook terminal workspace cleanup config', () => {
  test('defaults false for old config snapshots and DEFAULT_CONFIG', () => {
    const { webhookTaskWorkspaceAutoCleanup: _omitted, ...oldConfig } = DEFAULT_CONFIG
    const parsed = ConfigSchema.parse(oldConfig)

    expect(parsed.webhookTaskWorkspaceAutoCleanup).toBe(false)
    expect(DEFAULT_CONFIG.webhookTaskWorkspaceAutoCleanup).toBe(false)
  })

  test('PATCH accepts true and false but rejects non-booleans', () => {
    expect(
      ConfigPatchSchema.parse({ webhookTaskWorkspaceAutoCleanup: true })
        .webhookTaskWorkspaceAutoCleanup,
    ).toBe(true)
    expect(
      ConfigPatchSchema.parse({ webhookTaskWorkspaceAutoCleanup: false })
        .webhookTaskWorkspaceAutoCleanup,
    ).toBe(false)
    expect(ConfigPatchSchema.safeParse({ webhookTaskWorkspaceAutoCleanup: 'true' }).success).toBe(
      false,
    )
  })

  test('operator guide records scope, exclusions, and irreversible capability loss', () => {
    const guide = readFileSync(
      new URL('../../../docs/webhook-triggers.md', import.meta.url),
      'utf8',
    )
    expect(guide).toContain('终态工作区即时清理（RFC-300，默认关闭）')
    expect(guide).toContain('`done` / `canceled`')
    expect(guide).toContain('`failed` / `interrupted`')
    expect(guide).toContain('linked worktree 与 snapshot refs')
    expect(guide).toContain('递归删除整座 scratch Git 仓库')
    expect(guide).toContain('节点 retry 与 workflow sync 不再可用')
  })
})
