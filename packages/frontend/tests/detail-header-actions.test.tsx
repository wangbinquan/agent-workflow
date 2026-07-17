// RFC-151 PR-4 — <DetailHeaderActions> shell contract.
//
// Editable resource detail pages route their header through this shell; the
// page-level tests keep covering each page's wiring. This file locks the
// shell's own guarantees:
//   1. structure: PageHeader title + page__actions cluster inside the flex
//      header; error banners are SIBLINGS AFTER the header (long errors must
//      not be squeezed into the header's flex row).
//   2. errors array: nullish entries filtered; each present channel renders
//      its own <ErrorBanner> block (RFC-203 T5a — the rich path renders the
//      principal-aware delete-reference lists the old span dropped).
//   3. save is caller-owned: label / disabled / testid / onClick pass
//      through; label falls back to common.save when omitted.
//   4. extra slot renders ahead of Save inside the cluster.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApiError } from '../src/api/client'
import { DetailHeaderActions } from '../src/components/DetailHeaderActions'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

const BASE = {
  acl: { resourceBaseUrl: '/api/agents/x', invalidateKey: ['agents'] as const },
  del: { label: 'Delete it', onConfirm: () => {} },
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  // /api/me stays unresolved → AclDialogButton renders null (its own
  // visibility rules are covered by the RFC-099 ACL component tests).
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DetailHeaderActions', () => {
  test('renders title children + actions cluster in the header, errors AFTER it', () => {
    wrap(
      <DetailHeaderActions
        {...BASE}
        title="My resource"
        headingLevel={2}
        save={{ label: 'Save now', onClick: () => {}, disabled: false }}
        errors={[new ApiError(500, 'boom-code', 'boom happened')]}
      />,
    )
    const header = document.querySelector('header.page__header.page__header--row')
    expect(header).not.toBeNull()
    expect(header!.querySelector('h2.page__title')?.textContent).toBe('My resource')
    expect(header!.querySelector('.page__heading')).not.toBeNull()
    expect(header!.querySelector('.page__actions')).not.toBeNull()
    // The error banner is NOT inside the flex header — it renders as a
    // sibling right after it, so long messages get their own full-width row.
    expect(header!.querySelector('.error-box')).toBeNull()
    const banner = document.querySelector('.error-box')
    expect(banner).not.toBeNull()
    expect(banner!.previousElementSibling).toBe(header)
    // Unmapped code → localized fallback title; the raw diagnostic survives
    // in the collapsible detail block instead of leaking as the title.
    expect(banner!.textContent).toContain('boom happened')
  })

  test('errors: nullish channels filtered, each present channel gets its own banner', () => {
    wrap(
      <DetailHeaderActions
        {...BASE}
        title="t"
        save={{ onClick: () => {}, disabled: false }}
        errors={[null, new Error('first failure'), undefined, new Error('second failure')]}
      />,
    )
    const banners = [...document.querySelectorAll('.error-box')]
    expect(banners.length).toBe(2)
    expect(banners[0]?.textContent).toContain('first failure')
    expect(banners[1]?.textContent).toContain('second failure')
  })

  test('no present errors → no error banner at all', () => {
    wrap(
      <DetailHeaderActions
        {...BASE}
        title="t"
        save={{ onClick: () => {}, disabled: false }}
        errors={[null, undefined]}
      />,
    )
    expect(document.querySelector('.error-box')).toBeNull()
  })

  // RFC-203 T5a — the reason this shell moved off the string shell: a
  // delete-refused error carrying the principal-aware reference list must
  // surface the names + hidden count through <ErrorDetails>.
  test('delete-refused reference details render names + hidden count', () => {
    wrap(
      <DetailHeaderActions
        {...BASE}
        title="t"
        save={{ onClick: () => {}, disabled: false }}
        errors={[
          new ApiError(409, 'agent-in-use', "agent 'x' is referenced by workflows", {
            visible: [{ id: 'wf1', name: 'nightly-audit' }],
            hiddenCount: 2,
          }),
        ]}
      />,
    )
    const banner = document.querySelector('.error-box')!
    expect(banner.textContent).toContain('nightly-audit')
    expect(banner.textContent).toContain('2')
  })

  test('save passthrough: label, disabled, testid, onClick are caller-owned', () => {
    const onClick = vi.fn()
    wrap(
      <DetailHeaderActions
        {...BASE}
        title="t"
        save={{ label: 'Saving…', onClick, disabled: true, testid: 'my-save' }}
        errors={[]}
      />,
    )
    const btn = screen.getByTestId('my-save') as HTMLButtonElement
    expect(btn.textContent).toBe('Saving…')
    expect(btn.disabled).toBe(true)
    expect(btn.className).toContain('btn--primary')
    fireEvent.click(btn)
    // Disabled buttons swallow clicks — the caller's gating holds.
    expect(onClick).not.toHaveBeenCalled()
  })

  test('extra slot renders ahead of Save inside the cluster; del label lands on the ConfirmButton', () => {
    wrap(
      <DetailHeaderActions
        {...BASE}
        title="t"
        save={{ label: 'Save', onClick: () => {}, disabled: false, testid: 'save-here' }}
        extra={
          <button type="button" data-testid="fuse-like-extra">
            Extra action
          </button>
        }
        errors={[]}
      />,
    )
    const cluster = document.querySelector('.page__actions')!
    const buttons = [...cluster.querySelectorAll('button')]
    const extraIdx = buttons.findIndex((b) => b.dataset.testid === 'fuse-like-extra')
    const saveIdx = buttons.findIndex((b) => b.dataset.testid === 'save-here')
    const delIdx = buttons.findIndex((b) => b.textContent === 'Delete it')
    expect(extraIdx).toBeGreaterThanOrEqual(0)
    expect(saveIdx).toBeGreaterThan(extraIdx)
    expect(delIdx).toBeGreaterThan(saveIdx)
  })

  test('defaults to h1 for non-split detail pages', () => {
    wrap(
      <DetailHeaderActions
        {...BASE}
        title="Top-level resource"
        save={{ onClick: () => {}, disabled: false }}
        errors={[]}
      />,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Top-level resource' })).not.toBeNull()
  })
})
