// RFC-349 — one-click SQLite -> PostgreSQL migration surface. This component
// only calls the shared system-operations DTOs; it never sees a connection URL
// or assembles migration phases in the browser.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  databaseMigrationListViewSchema,
  databaseMigrationPreflightViewSchema,
  databaseMigrationStartIdempotencyKeyFromHash,
  databaseMigrationStartIdentityFromOverview,
  databaseMigrationStatusViewSchema,
  databaseMigrationTargetSchema,
  serializeDatabaseMigrationStartIdentityV1,
  databaseRuntimeOverviewSchema,
  type Config,
  type DatabaseMigrationArtifactKind,
  type DatabaseMigrationPreflightView,
  type DatabaseMigrationStartIdentity,
  type DatabaseMigrationStatusView,
  type DatabaseMigrationTargetView,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, NumberInput, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { DOWNLOAD_DEADLINE_MS, saveBlobAs } from '@/lib/download'
import { sha256Hex } from '@/lib/sha256'

const OVERVIEW_QUERY = ['database-runtime-overview'] as const
const MIGRATIONS_QUERY = ['database-migrations'] as const

export interface MigrationDraft {
  readonly urlEnv: string
  readonly poolMax: number | undefined
  readonly connectTimeoutMs: number | undefined
  readonly statementTimeoutMs: number | undefined
  readonly idleTimeoutMs: number | undefined
}

const DEFAULT_DRAFT: MigrationDraft = {
  urlEnv: 'AGENT_WORKFLOW_DATABASE_URL',
  poolMax: 16,
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 60_000,
  idleTimeoutMs: 30_000,
}

export function databaseMigrationTargetFromDraft(
  draft: MigrationDraft,
): DatabaseMigrationTargetView | null {
  const parsed = databaseMigrationTargetSchema.safeParse({
    provider: 'postgresql',
    ...draft,
  })
  return parsed.success ? parsed.data : null
}

export function databaseMigrationFieldErrors(
  draft: MigrationDraft,
): Readonly<Partial<Record<keyof MigrationDraft, string>>> {
  const parsed = databaseMigrationTargetSchema.safeParse({ provider: 'postgresql', ...draft })
  if (parsed.success) return Object.freeze({})
  const errors: Partial<Record<keyof MigrationDraft, string>> = {}
  for (const issue of parsed.error.issues) {
    const key = issue.path[0]
    if (
      typeof key === 'string' &&
      key in draft &&
      errors[key as keyof MigrationDraft] === undefined
    ) {
      errors[key as keyof MigrationDraft] = issue.message
    }
  }
  return Object.freeze(errors)
}

function targetKey(target: DatabaseMigrationTargetView): string {
  return [
    target.urlEnv,
    target.poolMax,
    target.connectTimeoutMs,
    target.statementTimeoutMs,
    target.idleTimeoutMs,
  ].join(':')
}

export async function databaseMigrationStartIdempotencyKey(
  identity: DatabaseMigrationStartIdentity,
): Promise<string> {
  const digest = await sha256Hex(
    new TextEncoder().encode(serializeDatabaseMigrationStartIdentityV1(identity)),
  )
  return databaseMigrationStartIdempotencyKeyFromHash(digest)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function phaseKind(status: DatabaseMigrationStatusView): StatusChipKind {
  if (status.rolledBackAt !== null) return 'neutral'
  if (status.failure !== null) return 'danger'
  if (status.phase === 'finalized') return 'success'
  if (status.phase === 'accepting-writes') return 'info'
  return 'warn'
}

function statusPercent(status: DatabaseMigrationStatusView): number {
  if (status.phase === 'finalized' || status.phase === 'accepting-writes') return 100
  if (status.progress.tablesTotal === 0) return 0
  return Math.min(
    99,
    Math.floor((status.progress.tablesCompleted / status.progress.tablesTotal) * 100),
  )
}

const MIGRATION_PHASE_ORDER: readonly DatabaseMigrationStatusView['phase'][] = [
  'planned',
  'preflighted',
  'source-frozen',
  'backed-up',
  'target-prepared',
  'copying',
  'verifying',
  'cutover-prepared',
  'switched',
  'health-checked',
  'accepting-writes',
  'finalized',
]

export function availableDatabaseMigrationArtifacts(
  status: DatabaseMigrationStatusView,
): readonly DatabaseMigrationArtifactKind[] {
  const phase = MIGRATION_PHASE_ORDER.indexOf(status.phase)
  const kinds: DatabaseMigrationArtifactKind[] = []
  if (phase >= MIGRATION_PHASE_ORDER.indexOf('verifying')) {
    kinds.push('logical-backup', 'legacy-archive')
  }
  if (phase >= MIGRATION_PHASE_ORDER.indexOf('cutover-prepared')) kinds.push('verification')
  if (status.phase === 'finalized') kinds.push('receipt')
  if (status.rolledBackAt !== null) kinds.push('rollback-receipt')
  return Object.freeze(kinds)
}

type Confirmation =
  | { readonly kind: 'start'; readonly identity: DatabaseMigrationStartIdentity }
  | {
      readonly kind: 'cancel' | 'rollback' | 'finalize'
      readonly operationId: string
    }
  | null

export function DatabaseMigrationSection({ config }: { readonly config: Config }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [draft, setDraft] = useState<MigrationDraft>(DEFAULT_DRAFT)
  const [confirmation, setConfirmation] = useState<Confirmation>(null)
  const [preflight, setPreflight] = useState<DatabaseMigrationPreflightView | null>(null)
  const [preflightTargetKey, setPreflightTargetKey] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [downloadingArtifact, setDownloadingArtifact] =
    useState<DatabaseMigrationArtifactKind | null>(null)
  const [artifactError, setArtifactError] = useState<unknown>(null)
  const fieldErrors = useMemo(() => databaseMigrationFieldErrors(draft), [draft])
  const target = databaseMigrationTargetFromDraft(draft)

  const overview = useQuery({
    queryKey: OVERVIEW_QUERY,
    queryFn: async ({ signal }) =>
      databaseRuntimeOverviewSchema.parse(await api.get('/api/database', undefined, signal)),
    refetchInterval: 15_000,
  })
  const postgresqlAlreadyLive =
    overview.data?.provider === 'postgresql' ||
    (overview.data === undefined && config.database.provider === 'postgresql')
  const migrations = useQuery({
    queryKey: MIGRATIONS_QUERY,
    queryFn: async ({ signal }) =>
      databaseMigrationListViewSchema.parse(
        await api.get('/api/database/migrations', undefined, signal),
      ),
    refetchInterval: 2_000,
  })
  const latest = useMemo(
    () =>
      migrations.data?.operations
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null,
    [migrations.data],
  )
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY }),
      queryClient.invalidateQueries({ queryKey: MIGRATIONS_QUERY }),
    ])
  }

  const preflightMutation = useMutation({
    mutationFn: async (nextTarget: DatabaseMigrationTargetView) =>
      databaseMigrationPreflightViewSchema.parse(
        await api.post('/api/database/migrations/preflight', { target: nextTarget }),
      ),
    onSuccess(receipt, nextTarget) {
      setPreflight(receipt)
      setPreflightTargetKey(targetKey(nextTarget))
      setFormError(null)
    },
  })
  const startMutation = useMutation({
    mutationFn: async (identity: DatabaseMigrationStartIdentity) =>
      databaseMigrationStatusViewSchema.parse(
        // The daemon returns the durable planned status (202) before copy;
        // this request must retain the ordinary bounded JSON deadline. The
        // two-second query above is the progress/recovery transport.
        await api.post('/api/database/migrations', {
          idempotencyKey: await databaseMigrationStartIdempotencyKey(identity),
          target: identity.target,
        }),
      ),
    onSuccess: refresh,
  })
  const operationMutation = useMutation({
    mutationFn: async (input: {
      readonly action: 'resume' | 'cancel' | 'rollback' | 'finalize'
      readonly operationId: string
    }) =>
      databaseMigrationStatusViewSchema.parse(
        await api.post(
          `/api/database/migrations/${encodeURIComponent(input.operationId)}/${input.action}`,
        ),
      ),
    onSuccess: refresh,
  })

  const validateTarget = (): DatabaseMigrationTargetView | null => {
    if (target !== null) {
      setFormError(null)
      return target
    }
    setFormError(t('settings.database.fixFields'))
    return null
  }

  const requestPreflight = (): void => {
    const nextTarget = validateTarget()
    if (nextTarget === null) return
    setPreflight(null)
    setPreflightTargetKey(null)
    preflightMutation.mutate(nextTarget)
  }

  const requestStart = (): void => {
    const nextTarget = validateTarget()
    if (nextTarget === null) return
    if (preflight === null || preflightTargetKey !== targetKey(nextTarget)) {
      setFormError(t('settings.database.preflightRequired'))
      return
    }
    const identity =
      overview.data === undefined
        ? null
        : databaseMigrationStartIdentityFromOverview(overview.data, nextTarget)
    if (identity === null) {
      setFormError(t('settings.database.sourceUnavailable'))
      return
    }
    setConfirmation({ kind: 'start', identity })
  }

  const downloadArtifact = async (
    operationId: string,
    kind: DatabaseMigrationArtifactKind,
  ): Promise<void> => {
    if (downloadingArtifact !== null) return
    setDownloadingArtifact(kind)
    setArtifactError(null)
    try {
      const blob = await api.getBlob(
        `/api/database/migrations/${encodeURIComponent(operationId)}/artifacts/${encodeURIComponent(kind)}`,
        undefined,
        { deadlineMs: DOWNLOAD_DEADLINE_MS },
      )
      saveBlobAs(blob, `${operationId}-${kind}.json`)
    } catch (error) {
      setArtifactError(error)
    } finally {
      setDownloadingArtifact(null)
    }
  }

  const confirmTitle =
    confirmation?.kind === 'start'
      ? t('settings.database.confirmTitle')
      : confirmation?.kind === 'rollback'
        ? t('settings.database.rollbackTitle')
        : confirmation?.kind === 'finalize'
          ? t('settings.database.finalizeTitle')
          : t('settings.database.cancelTitle')

  return (
    <div
      className="form-grid database-migration-settings"
      data-testid="database-migration-settings"
    >
      <SettingsCard
        title={t('settings.database.runtimeTitle')}
        hint={t('settings.database.runtimeHint')}
      >
        {overview.isLoading && <LoadingState label={t('settings.database.loadingRuntime')} />}
        {overview.error !== null && (
          <ErrorBanner error={overview.error} onRetry={() => void overview.refetch()} />
        )}
        {overview.data !== undefined && (
          <div className="database-migration-summary" aria-live="polite">
            <div>
              <span>{t('settings.database.liveProvider')}</span>
              <StatusChip kind={overview.data.provider === 'postgresql' ? 'success' : 'neutral'}>
                {overview.data.provider}
              </StatusChip>
            </div>
            <dl className="database-migration-facts">
              <div>
                <dt>{t('settings.database.generation')}</dt>
                <dd>
                  <code>{overview.data.generationId}</code>
                </dd>
              </div>
              <div>
                <dt>{t('settings.database.fingerprint')}</dt>
                <dd>
                  <code>
                    {overview.data.databaseFingerprint ?? t('settings.database.unavailable')}
                  </code>
                </dd>
              </div>
              <div>
                <dt>{t('settings.database.schemaDigest')}</dt>
                <dd>
                  <code>{overview.data.schemaDigest}</code>
                </dd>
              </div>
              <div>
                <dt>{t('settings.database.sourceSize')}</dt>
                <dd>
                  {overview.data.source === null
                    ? t('settings.database.sourceUnavailable')
                    : `${formatBytes(overview.data.source.fileBytes)} · ${overview.data.source.totalRows === null ? t('settings.database.rowsUnknown') : `${overview.data.source.totalRows.toLocaleString()} ${t('settings.database.rows')}`}`}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title={t('settings.database.targetTitle')}
        hint={t('settings.database.targetHint')}
        as="fieldset"
        disabled={postgresqlAlreadyLive}
      >
        {postgresqlAlreadyLive && (
          <NoticeBanner tone="info" title={t('settings.database.alreadyPostgresql')}>
            {t('settings.database.alreadyPostgresqlHint')}
          </NoticeBanner>
        )}
        <NoticeBanner tone="warning" title={t('settings.database.externalServerTitle')}>
          <ul>
            <li>{t('settings.database.externalServer')}</li>
            <li>{t('settings.database.maintenanceWindow')}</li>
            <li>{t('settings.database.archiveSix')}</li>
            <li>{t('settings.database.rollbackHorizon')}</li>
          </ul>
        </NoticeBanner>
        <Field
          label={t('settings.database.urlEnv')}
          hint={t('settings.database.urlEnvHint')}
          error={fieldErrors.urlEnv}
          errorId="database-url-env-error"
          required
        >
          <TextInput
            value={draft.urlEnv}
            onChange={(urlEnv) => setDraft({ ...draft, urlEnv })}
            autoComplete="off"
            aria-invalid={fieldErrors.urlEnv !== undefined}
            aria-errormessage={
              fieldErrors.urlEnv === undefined ? undefined : 'database-url-env-error'
            }
            data-testid="database-url-env"
          />
        </Field>
        <div className="form-grid form-grid--cols-2">
          <Field
            label={t('settings.database.poolMax')}
            error={fieldErrors.poolMax}
            errorId="database-pool-max-error"
            required
          >
            <NumberInput
              value={draft.poolMax}
              onChange={(poolMax) => setDraft({ ...draft, poolMax })}
              min={1}
              max={256}
              aria-invalid={fieldErrors.poolMax !== undefined}
              aria-errormessage={
                fieldErrors.poolMax === undefined ? undefined : 'database-pool-max-error'
              }
            />
          </Field>
          <Field
            label={t('settings.database.connectTimeout')}
            error={fieldErrors.connectTimeoutMs}
            errorId="database-connect-timeout-error"
            required
          >
            <NumberInput
              value={draft.connectTimeoutMs}
              onChange={(connectTimeoutMs) => setDraft({ ...draft, connectTimeoutMs })}
              min={1_000}
              max={120_000}
              step={1_000}
              aria-invalid={fieldErrors.connectTimeoutMs !== undefined}
              aria-errormessage={
                fieldErrors.connectTimeoutMs === undefined
                  ? undefined
                  : 'database-connect-timeout-error'
              }
            />
          </Field>
          <Field
            label={t('settings.database.statementTimeout')}
            error={fieldErrors.statementTimeoutMs}
            errorId="database-statement-timeout-error"
            required
          >
            <NumberInput
              value={draft.statementTimeoutMs}
              onChange={(statementTimeoutMs) => setDraft({ ...draft, statementTimeoutMs })}
              min={1_000}
              max={3_600_000}
              step={1_000}
              aria-invalid={fieldErrors.statementTimeoutMs !== undefined}
              aria-errormessage={
                fieldErrors.statementTimeoutMs === undefined
                  ? undefined
                  : 'database-statement-timeout-error'
              }
            />
          </Field>
          <Field
            label={t('settings.database.idleTimeout')}
            error={fieldErrors.idleTimeoutMs}
            errorId="database-idle-timeout-error"
            required
          >
            <NumberInput
              value={draft.idleTimeoutMs}
              onChange={(idleTimeoutMs) => setDraft({ ...draft, idleTimeoutMs })}
              min={1_000}
              max={600_000}
              step={1_000}
              aria-invalid={fieldErrors.idleTimeoutMs !== undefined}
              aria-errormessage={
                fieldErrors.idleTimeoutMs === undefined ? undefined : 'database-idle-timeout-error'
              }
            />
          </Field>
        </div>
        {formError !== null && <NoticeBanner tone="error">{formError}</NoticeBanner>}
        {preflightMutation.error !== null && <ErrorBanner error={preflightMutation.error} />}
        {preflight !== null && (
          <NoticeBanner tone="success" title={t('settings.database.preflightReady')}>
            PostgreSQL {preflight.serverMajor} · {preflight.serverEncoding} · {preflight.timezone} ·{' '}
            {formatBytes(preflight.databaseBytes)} · {preflight.targetState}
          </NoticeBanner>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={requestPreflight}
            disabled={preflightMutation.isPending || startMutation.isPending}
          >
            {preflightMutation.isPending
              ? t('settings.database.testing')
              : t('settings.database.testConnection')}
          </button>
          <button
            ref={triggerRef}
            type="button"
            className="btn btn--primary"
            onClick={requestStart}
            disabled={startMutation.isPending}
          >
            {startMutation.isPending
              ? t('settings.database.migrating')
              : t('settings.database.start')}
          </button>
        </div>
        {startMutation.error !== null && <ErrorBanner error={startMutation.error} />}
      </SettingsCard>

      <SettingsCard
        title={t('settings.database.operationTitle')}
        hint={t('settings.database.operationHint')}
      >
        {migrations.isLoading && <LoadingState label={t('settings.database.loadingOperations')} />}
        {migrations.error !== null && (
          <ErrorBanner error={migrations.error} onRetry={() => void migrations.refetch()} />
        )}
        {latest === null && !migrations.isLoading && (
          <EmptyState
            title={t('settings.database.noOperation')}
            description={t('settings.database.noOperationHint')}
          />
        )}
        {latest !== null && (
          <div className="database-migration-operation" data-testid="database-migration-operation">
            <div className="database-migration-operation__heading">
              <code>{latest.operationId}</code>
              <StatusChip kind={phaseKind(latest)}>{latest.phase}</StatusChip>
            </div>
            <label className="database-migration-progress">
              <span>
                {t('settings.database.progress', {
                  completed: latest.progress.tablesCompleted,
                  total: latest.tableCounts.source,
                  percent: statusPercent(latest),
                })}
              </span>
              <progress max={100} value={statusPercent(latest)} />
            </label>
            <dl className="database-migration-facts">
              <div>
                <dt>{t('settings.database.currentTable')}</dt>
                <dd>{latest.progress.table ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('settings.database.rowsCopied')}</dt>
                <dd>{latest.progress.rowsCopied.toLocaleString()}</dd>
              </div>
              <div>
                <dt>{t('settings.database.bytesCopied')}</dt>
                <dd>{formatBytes(latest.progress.bytesCopied)}</dd>
              </div>
              <div>
                <dt>{t('settings.database.tablePlan')}</dt>
                <dd>
                  {latest.tableCounts.source} = {latest.tableCounts.active} +{' '}
                  {latest.tableCounts.archiveOnly}
                </dd>
              </div>
            </dl>
            {latest.failure !== null && (
              <NoticeBanner tone="error" title={latest.failure.category}>
                {latest.failure.detailCode}
              </NoticeBanner>
            )}
            <NoticeBanner
              tone={latest.rollback.eligible ? 'info' : 'warning'}
              title={t('settings.database.rollbackStatus')}
            >
              {t(`settings.database.rollbackReasons.${latest.rollback.reason}`)}
            </NoticeBanner>
            <div className="form-actions">
              {latest.resumeEligible && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    operationMutation.mutate({ action: 'resume', operationId: latest.operationId })
                  }
                  disabled={operationMutation.isPending}
                >
                  {t('settings.database.resume')}
                </button>
              )}
              {latest.cancelEligible && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setConfirmation({ kind: 'cancel', operationId: latest.operationId })
                  }
                  disabled={operationMutation.isPending}
                >
                  {t('settings.database.cancel')}
                </button>
              )}
              {latest.rollback.eligible && (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() =>
                    setConfirmation({ kind: 'rollback', operationId: latest.operationId })
                  }
                  disabled={operationMutation.isPending}
                >
                  {t('settings.database.rollback')}
                </button>
              )}
              {latest.phase === 'accepting-writes' && latest.rolledBackAt === null && (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() =>
                    setConfirmation({ kind: 'finalize', operationId: latest.operationId })
                  }
                  disabled={operationMutation.isPending}
                >
                  {t('settings.database.finalize')}
                </button>
              )}
            </div>
            {availableDatabaseMigrationArtifacts(latest).length > 0 && (
              <div className="form-actions" aria-label={t('settings.database.artifacts')}>
                {availableDatabaseMigrationArtifacts(latest).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void downloadArtifact(latest.operationId, kind)}
                    disabled={downloadingArtifact !== null}
                  >
                    {downloadingArtifact === kind
                      ? t('settings.database.downloadingArtifact')
                      : t(`settings.database.artifactKinds.${kind}`)}
                  </button>
                ))}
              </div>
            )}
            {artifactError !== null && <ErrorBanner error={artifactError} />}
            {operationMutation.error !== null && <ErrorBanner error={operationMutation.error} />}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title={t('settings.database.archiveTitle')}
        hint={t('settings.database.archiveHint')}
      >
        <code className="database-migration-table-list">
          code_artifacts · code_fix_attempts · code_mr_leases · code_produced_mrs ·{' '}
          code_publish_intents · code_work_observations
        </code>
      </SettingsCard>

      <ConfirmDialog
        open={confirmation !== null}
        title={confirmTitle}
        description={
          confirmation?.kind === 'start' ? (
            <ul>
              <li>{t('settings.database.maintenanceWindow')}</li>
              <li>{t('settings.database.externalServer')}</li>
              <li>{t('settings.database.archiveSix')}</li>
              <li>{t('settings.database.rollbackHorizon')}</li>
            </ul>
          ) : (
            t(`settings.database.confirmDescriptions.${confirmation?.kind ?? 'cancel'}`)
          )
        }
        confirmLabel={t('common.confirm')}
        tone={
          confirmation?.kind === 'rollback' || confirmation?.kind === 'cancel'
            ? 'danger'
            : 'default'
        }
        confirmInput={
          confirmation?.kind === 'start'
            ? {
                expected: 'MIGRATE',
                label: t('settings.database.typeMigrate'),
                placeholder: 'MIGRATE',
              }
            : undefined
        }
        triggerRef={triggerRef}
        onClose={() => setConfirmation(null)}
        onConfirm={() => {
          const current = confirmation
          if (current === null) return
          if (current.kind === 'start') {
            // Close after dispatch so the durable operation/status panel stays
            // visible while the long request continues in the background.
            startMutation.mutate(current.identity)
            return
          }
          return operationMutation
            .mutateAsync({
              action: current.kind,
              operationId: current.operationId,
            })
            .then(() => undefined)
        }}
      />
    </div>
  )
}
