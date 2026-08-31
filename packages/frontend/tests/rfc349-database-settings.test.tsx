import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_CONFIG,
  type DatabaseMigrationStatusView,
  type DatabaseRuntimeOverview,
} from '@agent-workflow/shared'
import {
  DatabaseMigrationSection,
  databaseMigrationFieldErrors,
  databaseMigrationTargetFromDraft,
} from '../src/components/settings/DatabaseMigrationSection'
import { SETTINGS_TABS, validateSettingsSearch } from '../src/routes/settings'

const overview: DatabaseRuntimeOverview = {
  provider: 'sqlite',
  generationId: 'dbg_legacy_sqlite',
  schemaDigest: `sha256:${'a'.repeat(64)}`,
  databaseFingerprint: 'sqlite:fixture',
  serverVersion: null,
  operationId: null,
  target: null,
  source: { databaseFingerprint: 'sqlite:fixture', fileBytes: 4096, totalRows: 12345 },
  tableCounts: { source: 184, active: 178, archiveOnly: 6 },
}

const operation: DatabaseMigrationStatusView = {
  operationId: 'dbm_settings_operation_1234',
  revision: 4,
  phase: 'copying',
  sourceGenerationId: 'dbg_legacy_sqlite',
  targetProvider: 'postgresql',
  targetUrlEnv: 'AGENT_WORKFLOW_DATABASE_URL',
  target: {
    provider: 'postgresql',
    urlEnv: 'AGENT_WORKFLOW_DATABASE_URL',
    poolMax: 16,
    connectTimeoutMs: 10_000,
    statementTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
  },
  targetDatabaseFingerprint: 'pg:fixture',
  tableCounts: overview.tableCounts,
  progress: {
    table: 'tasks',
    chunk: 2,
    tablesCompleted: 92,
    tablesTotal: 184,
    rowsCopied: 12345,
    bytesCopied: 4096,
    lastMigrationKey: ['task-1'],
  },
  failure: null,
  cancelEligible: true,
  resumeEligible: false,
  rollback: { eligible: false, reason: 'pointer-not-switched' },
  firstLiveWriteAt: null,
  rolledBackAt: null,
  rollbackReceiptDigest: null,
  createdAt: 1,
  updatedAt: 2,
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData(['database-runtime-overview'], overview)
  client.setQueryData(['database-migrations'], { operations: [operation] })
  return render(
    <QueryClientProvider client={client}>
      <DatabaseMigrationSection config={DEFAULT_CONFIG} />
    </QueryClientProvider>,
  )
}

describe('RFC-349 database Settings', () => {
  test('database is a stable URL-backed reliability section', () => {
    expect(SETTINGS_TABS).toContain('database')
    expect(validateSettingsSearch({ tab: 'database' })).toEqual({ tab: 'database' })
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
      'utf8',
    )
    expect(source).toContain("key: 'database'")
    expect(source).toContain('<DatabaseMigrationSection config={config.data} />')
  })

  test('all target constraints are modeled before submission and raw URLs are rejected', () => {
    expect(
      databaseMigrationTargetFromDraft({
        urlEnv: 'AW_DATABASE_URL',
        poolMax: 8,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        idleTimeoutMs: 15_000,
      }),
    ).toMatchObject({ provider: 'postgresql', urlEnv: 'AW_DATABASE_URL' })
    const errors = databaseMigrationFieldErrors({
      urlEnv: 'postgresql://user:secret@db/app',
      poolMax: 0,
      connectTimeoutMs: 999,
      statementTimeoutMs: 3_600_001,
      idleTimeoutMs: undefined,
    })
    expect(Object.keys(errors).sort()).toEqual([
      'connectTimeoutMs',
      'idleTimeoutMs',
      'poolMax',
      'statementTimeoutMs',
      'urlEnv',
    ])
  })

  test('renders live generation, 184 to 178 plus 6 plan, progress and field-level errors', () => {
    const view = renderSection()
    expect(view.getByTestId('database-migration-settings').textContent).toContain(
      'dbg_legacy_sqlite',
    )
    expect(view.getByTestId('database-migration-operation').textContent).toContain('184')
    expect(view.getByTestId('database-migration-operation').textContent).toContain('178')
    expect(view.getByTestId('database-migration-operation').textContent).toContain('6')
    expect(view.container.querySelector('progress')?.getAttribute('value')).toBe('50')

    fireEvent.change(view.getByTestId('database-url-env'), {
      target: { value: 'postgresql://user:secret@db/app' },
    })
    expect(view.getByTestId('database-url-env').getAttribute('aria-invalid')).toBe('true')
    expect(view.container.textContent).not.toContain('user:secret')
  })
})
