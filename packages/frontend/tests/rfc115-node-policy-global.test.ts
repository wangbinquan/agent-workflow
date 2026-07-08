// RFC-115 — the per-node retries/timeout overrides were removed and moved to
// global config (config.defaultNodeRetries / defaultPerNodeTimeoutMs). The
// interactive "controls are gone" assertion lives in node-inspector.test.tsx;
// this file is the source + i18n grep companion (the settings route is heavy to
// mount) locking:
//   (1) Settings → Limits persists + renders the new global defaultNodeRetries;
//   (2) NodeInspector no longer references the removed retries/timeout keys or
//       reads node.retries / node.timeoutMs;
//   (3) the new settingsForm.nodeRetries key exists in BOTH locales while the
//       dead inspector.fieldRetries / fieldTimeoutMs keys are gone — and the
//       unrelated mcps.fieldTimeoutMs key (same English label, different
//       namespace) is preserved.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (p: string): string => readFileSync(resolve(import.meta.dirname, '..', p), 'utf-8')
const SETTINGS = read('src/routes/settings.tsx')
// RFC-146 T3: the per-kind Edit branches live under inspector/ now — the
// absence lock must cover the agent Edit component (where the removed
// retries/timeout fields used to render) as well as the drawer shell.
const INSPECTOR =
  read('src/components/canvas/NodeInspector.tsx') +
  read('src/components/canvas/inspector/AgentSingleEdit.tsx')
const ZH = read('src/i18n/zh-CN.ts')
const EN = read('src/i18n/en-US.ts')
const AGENTS = read('src/routes/agents.tsx')

describe('RFC-115 settings — global defaultNodeRetries knob', () => {
  test('LimitsTab persists defaultNodeRetries in the draft slice', () => {
    expect(SETTINGS).toContain("'defaultNodeRetries'")
  })
  test('renders the field bound to state via the nodeRetries i18n key', () => {
    expect(SETTINGS).toMatch(/state\.defaultNodeRetries/)
    expect(SETTINGS).toContain("t('settingsForm.nodeRetries')")
  })
})

describe('RFC-115 NodeInspector — no per-node retries/timeout controls', () => {
  test('inspector no longer references the removed retries/timeout i18n keys', () => {
    expect(INSPECTOR).not.toContain('inspector.fieldRetries')
    expect(INSPECTOR).not.toContain('inspector.fieldTimeoutMs')
  })
  test('inspector no longer reads node.retries / node.timeoutMs', () => {
    expect(INSPECTOR).not.toMatch(/rec\.retries/)
    expect(INSPECTOR).not.toMatch(/rec\.timeoutMs/)
  })
})

describe('RFC-115 i18n — new key added, dead inspector keys removed, mcps kept', () => {
  test('settingsForm.nodeRetries present in both locales', () => {
    expect(EN).toContain("nodeRetries: 'Default node retries'")
    expect(ZH).toContain("nodeRetries: '默认节点重试次数'")
  })
  test('dead inspector.fieldRetries / fieldRetriesHint removed from both locales', () => {
    expect(EN).not.toContain("fieldRetries: 'Retries'")
    expect(ZH).not.toContain("fieldRetries: '重试次数'")
  })
  test('mcps.fieldTimeoutMs (a different key, same English label) is preserved', () => {
    expect(EN).toContain("fieldTimeoutMs: 'Timeout (ms)'")
  })
})

// ---------------------------------------------------------------------------
// PR-B — /agents runtime column (G3)
// ---------------------------------------------------------------------------

describe('RFC-115 PR-B — /agents runtime column', () => {
  test('agents list renders a runtime column header reading each agent runtime', () => {
    expect(AGENTS).toContain("t('agents.colRuntime')")
    expect(AGENTS).toMatch(/a\.runtime/)
  })
  test('unspecified runtime falls back to the global isDefault runtime + a default tag', () => {
    // Reuse the shared ['runtimes'] query key + public StatusChip primitive (no fork).
    expect(AGENTS).toContain('RUNTIMES_QUERY_KEY')
    expect(AGENTS).toMatch(/isDefault/)
    expect(AGENTS).toContain('defaultRuntimeName')
    expect(AGENTS).toContain('StatusChip')
    expect(AGENTS).toContain("t('agents.runtimeDefaultTag')")
  })
})

describe('RFC-115 PR-B i18n — runtime column keys in both locales', () => {
  test('agents.colRuntime + runtimeDefaultTag present in both locales', () => {
    expect(EN).toContain("colRuntime: 'Runtime'")
    expect(EN).toContain("runtimeDefaultTag: 'default'")
    expect(ZH).toContain("colRuntime: '运行时'")
    expect(ZH).toContain("runtimeDefaultTag: '默认'")
  })
})
