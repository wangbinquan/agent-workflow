// RFC-203 T4 — describeTaskFailure oracle locks (audit P1 F-2).
//
// LOCKS: failureCode beats summary-token beats generic; every RFC-145 code
// has copy; the known errorSummary machine tokens (exact + prefix families,
// incl. dw-generate-exhausted — the previously-dead workgroups.dw.exhausted
// path) localize; unknown summaries keep raw for the detail block and never
// leak the machine token as the title.

import { beforeAll, describe, expect, test } from 'vitest'
import i18n, { setLanguage } from '../src/i18n'
import { describeTaskFailure } from '../src/lib/task-failure'
import { FAILURE_CODES } from '@agent-workflow/shared'

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    if (i18n.isInitialized) resolve()
    else i18n.on('initialized', () => resolve())
  })
  setLanguage('zh-CN')
})

describe('describeTaskFailure', () => {
  test('every RFC-145 failure code has localized copy (no machine tokens)', () => {
    for (const code of FAILURE_CODES) {
      const r = describeTaskFailure({ failureCode: code, errorSummary: 'raw-token' })
      expect(r.matched).toBe('failure-code')
      expect(r.title).not.toContain(code)
      expect(r.title.length).toBeGreaterThan(4)
    }
  })

  test('failureCode outranks a known summary token', () => {
    const r = describeTaskFailure({
      failureCode: 'envelope-missing',
      errorSummary: 'snapshot-lost',
    })
    expect(r.matched).toBe('failure-code')
    expect(r.raw).toBe('snapshot-lost')
  })

  test('exact summary tokens localize', () => {
    for (const summary of [
      'snapshot-lost',
      'canceled by user',
      'scheduler error',
      'dw-generate-exhausted',
    ]) {
      const r = describeTaskFailure({ errorSummary: summary })
      expect(r.matched).toBe('summary-token')
      expect(r.title).not.toBe(summary)
    }
  })

  test('prefix summary tokens localize (timeout / stalled / max_rounds / exit code)', () => {
    const cases: Array<[string, string]> = [
      ['node-timeout: exceeded 600000ms', '超时'],
      ['scheduler stalled — blocked nodes: nd-x', '停滞'],
      ['workgroup hit max_rounds (10)', '轮次上限'],
      ['opencode exited with code 1', '异常退出'],
      ['worktree creation failed: fatal x', '工作区'],
    ]
    for (const [summary, fragment] of cases) {
      const r = describeTaskFailure({ errorSummary: summary })
      expect(r.matched).toBe('summary-token')
      expect(r.title).toContain(fragment)
      expect(r.raw).toBe(summary)
    }
  })

  test('unknown summary → generic title, raw preserved, token never leaks into title', () => {
    const r = describeTaskFailure({ errorSummary: 'iso-setup-failed: weird' })
    expect(r.matched).toBe('generic')
    expect(r.title).not.toContain('iso-setup-failed')
    expect(r.raw).toBe('iso-setup-failed: weird')
  })

  test('no summary at all → generic with message as raw', () => {
    const r = describeTaskFailure({ errorMessage: 'boom' })
    expect(r.matched).toBe('generic')
    expect(r.raw).toBe('boom')
  })
})
