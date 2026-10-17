import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { HostedBackupCatalog, HostedBackupVerification } from '@agent-workflow/shared'
import { HostedBackupCard } from '../src/components/settings/HostedBackupCard'
import { meQueryOptions, type MeResponse } from '../src/hooks/useActor'
import { ExecutionStatusContext } from '../src/hooks/useExecutionAvailability'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

const actor: MeResponse = {
  user: { id: 'admin', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
  profile: {
    displayName: 'Admin',
    gitName: 'Admin',
    email: '',
    gitCommitIdentity: { name: 'Admin', email: 'admin@example.test' },
  },
  source: 'session',
  permissions: ['backup:run'],
  linkedIdentities: [],
  pats: [],
}
const backupId = '01a13e6d-3e00-7000-9e3c-000000000001'
const catalog: HostedBackupCatalog = {
  backups: [
    {
      id: backupId,
      kind: 'manual',
      state: 'ready',
      createdAt: 1,
      sizeBytes: 1024,
      protected: true,
    },
  ],
  hasMore: false,
}
const verification: HostedBackupVerification = {
  backupId,
  verifiedAt: 2,
  reference: 'aw-object:v2:database-backup:verified-reference',
  schemaDigest: `sha256:${'a'.repeat(64)}`,
  sourceGenerationId: 'dbg_hosted',
  sizeBytes: 2 * 1024 * 1024,
  workflows: 2,
  skills: 1,
}
let client: QueryClient
let currentActor: MeResponse
let calls: { path: string; method: string; body: unknown }[]
let failVerification = false
beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://backup-${crypto.randomUUID()}.test`)
  setToken('backup-token')
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  currentActor = actor
  client.setQueryData(meQueryOptions('backup-token').queryKey, actor)
  calls = []
  failVerification = false
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/me') return Response.json(currentActor)
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path === '/api/backup')
      return Response.json(method === 'POST' ? { path: 'new-reference', sizeBytes: 1 } : catalog)
    if (path === `/api/backup/${backupId}/verify`)
      return failVerification
        ? Response.json(
            { ok: false, code: 'backup-archive-unavailable', message: 'object digest mismatch' },
            { status: 409 },
          )
        : Response.json(verification)
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})
async function show(standby = false, canRun = true, expectContent = true) {
  render(
    <QueryClientProvider client={client}>
      <ExecutionStatusContext.Provider
        value={{ mode: 'crewstation', state: standby ? 'standby' : 'active', reason: null }}
      >
        <HostedBackupCard canRun={canRun} />
      </ExecutionStatusContext.Provider>
    </QueryClientProvider>,
  )
  if (canRun && expectContent) await screen.findByText(i18n.t('hostedBackup.protected'))
}

// RFC-370 v3 V5: a hosted backup is a database archive; workspaces are not part
// of it (C10), and verification is the catalog plus an archive existence check.
test.each(['en-US', 'zh-CN'])(
  'verified details show the restore reference, archive size and platform restore steps (%s)',
  async (language) => {
    await i18n.changeLanguage(language)
    await show()
    expect(screen.getByText(i18n.t('hostedBackup.databaseOnly'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: i18n.t('hostedBackup.verify') }))
    await screen.findByText(i18n.t('hostedBackup.verified'))
    expect(screen.getByRole('textbox', { name: i18n.t('hostedBackup.reference') })).toHaveProperty(
      'value',
      verification.reference,
    )
    expect(
      screen.getByText(i18n.t('hostedBackup.counts', { workflows: 2, skills: 1, size: '2.00 MB' })),
    ).toBeTruthy()
    expect(screen.getByText(i18n.t('hostedBackup.restoreStep3'))).toBeTruthy()
    expect(calls.some((call) => call.path.startsWith('/api/restore'))).toBe(false)
  },
)

test('standby disables creation but allows verification, and failed verification exposes no restore reference', async () => {
  failVerification = true
  await show(true)
  expect(screen.getByRole('button', { name: i18n.t('hostedBackup.create') })).toHaveProperty(
    'disabled',
    true,
  )
  fireEvent.click(screen.getByRole('button', { name: i18n.t('hostedBackup.verify') }))
  await screen.findByText(i18n.t('errors.backup-archive-unavailable'))
  expect(screen.queryByRole('textbox', { name: i18n.t('hostedBackup.reference') })).toBeNull()
  expect(calls.some((call) => call.path === '/api/backup' && call.method === 'POST')).toBe(false)
})

test('a hosted backup never asks for workspace files', async () => {
  await show()
  expect(screen.queryByRole('checkbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: i18n.t('hostedBackup.create') }))
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({
      path: '/api/backup',
      body: { includeWorktrees: false },
    }),
  )
})

test('missing backup permission prevents queries and all actions', async () => {
  currentActor = { ...actor, permissions: [] }
  client.setQueryData(meQueryOptions('backup-token').queryKey, currentActor)
  await show(false, true, false)
  expect(screen.queryByText(i18n.t('hostedBackup.title'))).toBeNull()
  expect(calls).toEqual([])
})
