import { readDaemonGraphSource } from './helpers/daemonGraphSource'
// RFC-370 §9.2 V9 — hosted assembly lives only in bootstrap and reaches only
// the PostgreSQL daemon root. A hosted deployment always runs on PostgreSQL, so
// the SQLite root composes the standalone owners directly and refuses any
// hosted-only selection instead of silently threading it through.
import { expect, test } from 'bun:test'

import { HOSTED_ONLY_SELECTIONS, standaloneSelectionsOf } from '@/bootstrap/daemonSessionAdapters'

type ComposeInput = Parameters<typeof standaloneSelectionsOf>[0]

test('the SQLite root refuses every hosted-only selection by name', () => {
  const base = { provider: { provider: 'sqlite' } } as unknown as ComposeInput
  expect(standaloneSelectionsOf(base)).toBe(base)
  for (const key of HOSTED_ONLY_SELECTIONS) {
    const withHosted = { ...base, [key]: {} } as ComposeInput
    expect(() => standaloneSelectionsOf(withHosted)).toThrow(
      `hosted-deployment-requires-postgresql: ${key}`,
    )
  }
})

test('the shared graph admits selections before composing owners', () => {
  const source = readDaemonGraphSource()
  const start = source.indexOf('async function composeDaemonApplication<')
  expect(start).toBeGreaterThan(0)
  const body = source.slice(start)
  expect(body.indexOf('adapter.admitSelections(input)')).toBeLessThan(
    body.indexOf('composeDevelopmentPurposeRoot({'),
  )
  expect(body).toContain('DAEMON_SESSION_ADAPTERS[input.provider.provider]')
})

test('RFC-380 treats credentials, run families and workspace presence as hosted-only', () => {
  for (const key of ['credentials', 'systemAgentRunFamily', 'workspacePresence'] as const)
    expect(HOSTED_ONLY_SELECTIONS).toContain(key)
})
