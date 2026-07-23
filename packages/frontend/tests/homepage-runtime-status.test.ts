// RFC-135 — homepage hero multi-runtime status line (describeRuntimes oracle).
//
// Locks the severity mapping that replaced the hardcoded single-opencode
// probe, most importantly the two user decisions:
//   - availability is VERSION-GATE FREE: an ok row with an unparseable
//     version string (version: null) still renders green ("<name> ok"),
//     never as a fault (2026-07-02 decision — custom binaries own their
//     version scheme);
//   - missing DEFAULT runtime = fault (red) vs missing non-default = soft
//     (grey/muted), so opencode-only installs don't show a standing red dot
//     for the unused claude-code builtin (RFC-111 D10 generalized);
//   - the >threshold aggregate names the WORST failure (fault before soft),
//     not the first one (Codex gate F5).
// Plus a source-text guard: the hero must never regress to the legacy
// /api/runtime/opencode endpoint.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { __test__ } from '../src/components/home/HomepageGreeting'
import type { RuntimesStatusResponse } from '@agent-workflow/shared'
import i18n from '../src/i18n'

const { describeRuntimes, itemSeverity, AGGREGATE_THRESHOLD } = __test__

/** Echo-style t(): returns "key{json}" so assertions see key + interpolation. */
function t(key: string, opts?: Record<string, unknown>): string {
  return opts === undefined ? key : `${key}${JSON.stringify(opts)}`
}

function row(
  name: string,
  over: Partial<RuntimesStatusResponse['runtimes'][number]> = {},
): RuntimesStatusResponse['runtimes'][number] {
  return {
    name,
    protocol: 'opencode',
    binary: `/bin/${name}`,
    ok: true,
    version: '1.0.0',
    isDefault: false,
    ...over,
  }
}

function loaded(rows: RuntimesStatusResponse['runtimes']) {
  return { isLoading: false, data: { runtimes: rows } }
}

describe('RFC-135 describeRuntimes', () => {
  test('loading → single checking view', () => {
    const view = describeRuntimes(t, { isLoading: true })
    expect(view).toEqual({ kind: 'single', severity: 'checking', text: 'home.runtime.checking' })
  })

  test('two healthy runtimes → per-item green dots with versions', () => {
    const view = describeRuntimes(
      t,
      loaded([row('opencode', { isDefault: true }), row('claude-code', { version: '2.1.193' })]),
    )
    expect(view.kind).toBe('items')
    if (view.kind !== 'items') return
    expect(view.items.map((i) => i.severity)).toEqual(['ok', 'ok'])
    expect(view.items[0]!.text).toContain('home.runtime.item.ready')
    expect(view.items[0]!.text).toContain('"version":"1.0.0"')
    expect(view.items.every((i) => !i.muted)).toBe(true)
  })

  test('ok with unparseable version → still green, readyNoVersion copy (version-gate-free)', () => {
    const view = describeRuntimes(t, loaded([row('weird-fork', { version: null })]))
    if (view.kind !== 'items') throw new Error('expected items')
    expect(view.items[0]!.severity).toBe('ok')
    expect(view.items[0]!.text).toContain('home.runtime.item.readyNoVersion')
  })

  test('missing non-default → soft grey + muted; missing default → fault red', () => {
    const view = describeRuntimes(
      t,
      loaded([
        row('opencode', { isDefault: true, ok: false, version: null }),
        row('claude-code', { ok: false, version: null }),
      ]),
    )
    if (view.kind !== 'items') throw new Error('expected items')
    const [def, nonDef] = view.items
    expect(def!.severity).toBe('fault')
    expect(def!.muted).toBe(false)
    expect(nonDef!.severity).toBe('soft')
    expect(nonDef!.muted).toBe(true)
    expect(def!.text).toContain('home.runtime.item.missing')
    expect(def!.failure).toBeUndefined()
    expect(nonDef!.failure).toBeUndefined()
  })

  test('three-or-fewer rows render localized English identity title + hint without the code', async () => {
    await i18n.changeLanguage('en-US')
    const view = describeRuntimes(
      t,
      loaded([
        row('opencode', {
          isDefault: true,
          ok: false,
          version: null,
          failureCode: 'execution-identity-untrusted-binary',
        }),
      ]),
    )
    if (view.kind !== 'items') throw new Error('expected items')
    expect(view.items[0]!.failure).toEqual({
      title: 'The selected OpenCode executable is not a trusted official build.',
      hint: 'Install the supported official OpenCode build or select its verified executable.',
    })
    expect(JSON.stringify(view)).not.toContain('execution-identity-untrusted-binary')
  })

  test('empty (all disabled) → noneEnabled soft view', () => {
    const view = describeRuntimes(t, loaded([]))
    expect(view).toEqual({
      kind: 'single',
      severity: 'soft',
      text: 'home.runtime.noneEnabled',
    })
  })

  test('above threshold, all ok → aggregate count', () => {
    const rows = ['a', 'b', 'c', 'd'].map((n) => row(n))
    expect(rows.length).toBeGreaterThan(AGGREGATE_THRESHOLD)
    const view = describeRuntimes(t, loaded(rows))
    expect(view.kind).toBe('single')
    if (view.kind !== 'single') return
    expect(view.severity).toBe('ok')
    expect(view.text).toContain('home.runtime.aggregate')
    expect(view.text).toContain('"ok":4,"total":4')
  })

  test('above threshold names the WORST failure — soft first must not shadow the fault (F5)', () => {
    // soft failure sorted BEFORE the fault row: naming "the first abnormal"
    // would pick soft-fork and hide the red default failure.
    const rows = [
      row('soft-fork', { ok: false, version: null }),
      row('b'),
      row('c'),
      row('the-default', { isDefault: true, ok: false, version: null }),
    ]
    const view = describeRuntimes(t, loaded(rows))
    if (view.kind !== 'single') throw new Error('expected aggregate')
    expect(view.severity).toBe('fault')
    expect(view.text).toContain('home.runtime.aggregateWorst')
    expect(view.text).toContain('"name":"the-default"')
  })

  test('above threshold renders the worst failure in localized Chinese without the code', async () => {
    await i18n.changeLanguage('zh-CN')
    const rows = [
      row('soft-fork', {
        ok: false,
        version: null,
        failureCode: 'execution-identity-untrusted-binary',
      }),
      row('b'),
      row('c'),
      row('the-default', {
        isDefault: true,
        ok: false,
        version: null,
        failureCode: 'execution-identity-source-changed',
      }),
    ]
    const view = describeRuntimes(t, loaded(rows))
    if (view.kind !== 'single') throw new Error('expected aggregate')
    expect(view.failure).toEqual({
      title: '启动期间工作区的执行身份来源发生了变化。',
      hint: '请停止并发配置修改，再重新发起新运行。',
    })
    expect(JSON.stringify(view)).not.toContain('execution-identity-source-changed')
    expect(JSON.stringify(view)).not.toContain('execution-identity-untrusted-binary')
  })

  test('above threshold with only soft failures → soft aggregate naming the soft row', () => {
    const rows = [row('a'), row('b'), row('c'), row('soft-fork', { ok: false, version: null })]
    const view = describeRuntimes(t, loaded(rows))
    if (view.kind !== 'single') throw new Error('expected aggregate')
    expect(view.severity).toBe('soft')
    expect(view.text).toContain('"name":"soft-fork"')
  })

  test('itemSeverity mapping table', () => {
    expect(itemSeverity({ ok: true, isDefault: true })).toBe('ok')
    expect(itemSeverity({ ok: true, isDefault: false })).toBe('ok')
    expect(itemSeverity({ ok: false, isDefault: true })).toBe('fault')
    expect(itemSeverity({ ok: false, isDefault: false })).toBe('soft')
  })
})

describe('RFC-135 source-text guards', () => {
  test('HomepageGreeting no longer references the legacy single-runtime probe', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'components', 'home', 'HomepageGreeting.tsx'),
      'utf8',
    )
    expect(src.includes('/api/runtime/opencode')).toBe(false)
    expect(src.includes('/api/runtimes/status')).toBe(true)
  })
})
