// RFC-075 — source-layer wiring guards for the launcher's working branch +
// auto commit&push controls and the task-detail display rows. The launch
// route DOM is expensive to mount (TanStack Router + Query + i18n), so —
// matching launch-git-identity.test.ts — we grep the source for the wiring
// invariants plus assert i18n parity. A regression that drops the validation
// gate would let Start enable on an illegal branch name and eat a 422; one
// that drops the body spread would silently never send the two new fields.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  AUTO_COMMIT_PUSH_LS_KEY,
  loadAutoCommitPushPref,
  saveAutoCommitPushPref,
} from '../src/lib/task-wizard'

const LAUNCH_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.new.tsx'),
  'utf-8',
)
const DETAIL_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('tasks.new.tsx — RFC-075 working branch + auto commit&push wiring', () => {
  test('declares workingBranch + autoCommitPush state (toggle seeded from pref)', () => {
    expect(LAUNCH_SRC).toMatch(/const \[workingBranch, setWorkingBranch\] = useState\(['"]['"]\)/)
    expect(LAUNCH_SRC).toMatch(
      /const \[autoCommitPush, setAutoCommitPush\] = useState\(loadAutoCommitPushPref\(\)\)/,
    )
  })

  test('renders the working-branch input + auto commit&push switch', () => {
    expect(LAUNCH_SRC).toContain('data-testid="wizard-working-branch"')
    expect(LAUNCH_SRC).toContain("t('launch.workingBranch.label')")
    expect(LAUNCH_SRC).toContain("t('launch.autoCommitPush.label')")
    // Uses the shared Switch primitive, not a hand-rolled checkbox.
    expect(LAUNCH_SRC).toMatch(/<Switch\b/)
  })

  test('validates the branch name with the shared loose validator', () => {
    expect(LAUNCH_SRC).toContain('isLooseValidBranchName')
    expect(LAUNCH_SRC).toMatch(/const workingBranchError\s*=/)
  })

  test('canSubmit consults the branch validity gate', () => {
    expect(LAUNCH_SRC).toMatch(/stepContentReady\s*=[\s\S]*?!workingBranchError/)
    expect(LAUNCH_SRC).toMatch(/canSubmit\s*=[\s\S]*?stepContentReady/)
  })

  test('submit payload spreads workingBranch only when non-empty + autoCommitPush only when true', () => {
    expect(LAUNCH_SRC).toMatch(/workingBranchTrim !== ['"]['"]\s*\?\s*\{ workingBranch:/)
    expect(LAUNCH_SRC).toMatch(/autoCommitPush\s*\?\s*\{ autoCommitPush: true \}/)
  })

  test('invalid-branch node carries role="alert" + data-testid', () => {
    expect(LAUNCH_SRC).toContain('data-testid="wizard-branch-error"')
    expect(LAUNCH_SRC).toMatch(
      /role="alert"[\s\S]*wizard-branch-error|wizard-branch-error[\s\S]*role="alert"/,
    )
  })

  test('toggle persists to localStorage via saveAutoCommitPushPref', () => {
    expect(LAUNCH_SRC).toContain('saveAutoCommitPushPref')
    expect(LAUNCH_SRC).toContain('loadAutoCommitPushPref')
  })
})

// Behavioral lock for the 2026-07 change: the auto commit&push toggle now
// defaults ON for a fresh launcher (no stored preference), while an explicit
// opt-out ('0') must still survive reloads. Seeding the <Switch> from
// loadAutoCommitPushPref() (asserted above) means these semantics decide the
// initial checked state, so if the default silently flips back to OFF the
// user's requested "on by default" regresses without any DOM change.
describe('loadAutoCommitPushPref — default ON with sticky opt-out (RFC-075)', () => {
  beforeEach(() => window.localStorage.clear())

  test('unset preference defaults to ON', () => {
    expect(window.localStorage.getItem(AUTO_COMMIT_PUSH_LS_KEY)).toBeNull()
    expect(loadAutoCommitPushPref()).toBe(true)
  })

  test('explicit opt-out persists as OFF across reloads', () => {
    saveAutoCommitPushPref(false)
    expect(window.localStorage.getItem(AUTO_COMMIT_PUSH_LS_KEY)).toBe('0')
    expect(loadAutoCommitPushPref()).toBe(false)
  })

  test('explicit opt-in reads back as ON', () => {
    saveAutoCommitPushPref(true)
    expect(window.localStorage.getItem(AUTO_COMMIT_PUSH_LS_KEY)).toBe('1')
    expect(loadAutoCommitPushPref()).toBe(true)
  })
})

describe('tasks.detail.tsx — RFC-075 working/base branch display', () => {
  test('renders base branch + working branch meta rows', () => {
    expect(DETAIL_SRC).toContain('data-testid="task-detail-base-branch"')
    expect(DETAIL_SRC).toContain('data-testid="task-detail-working-branch"')
    expect(DETAIL_SRC).toContain("t('tasks.metaBaseBranch')")
    expect(DETAIL_SRC).toContain("t('tasks.metaWorkingBranch')")
  })

  test('working branch falls back to the isolation-branch label when null', () => {
    expect(DETAIL_SRC).toMatch(/tk\.workingBranch !== null/)
    expect(DETAIL_SRC).toContain("t('tasks.metaWorkingBranchNone')")
  })
})

describe('i18n — RFC-075 keys present and parity-aligned', () => {
  test('zh-CN type declaration lists workingBranch + autoCommitPush sub-keys', () => {
    expect(ZH).toMatch(/workingBranch:\s*\{[\s\S]*?label: string[\s\S]*?invalid: string[\s\S]*?\}/)
    expect(ZH).toMatch(/autoCommitPush:\s*\{[\s\S]*?label: string[\s\S]*?hint: string[\s\S]*?\}/)
  })

  test('zh-CN launch values present', () => {
    expect(ZH).toContain("label: '工作分支（可选）'")
    expect(ZH).toContain("label: '完成后自动提交并推送'")
  })

  test('en-US launch values present', () => {
    expect(EN).toContain("label: 'Working branch (optional)'")
    expect(EN).toContain("label: 'Auto commit & push on completion'")
  })

  test('detail meta keys present in both locales', () => {
    expect(ZH).toContain("metaBaseBranch: '基线分支'")
    expect(ZH).toContain("metaWorkingBranch: '工作分支'")
    expect(EN).toContain("metaBaseBranch: 'Base branch'")
    expect(EN).toContain("metaWorkingBranch: 'Working branch'")
  })
})
