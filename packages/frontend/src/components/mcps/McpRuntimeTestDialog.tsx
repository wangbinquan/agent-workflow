// RFC-238 — multi-turn MCP runtime playground Dialog.
//
// Dismissal only hides this component. The backend session continues and is
// recovered through the latest-session query when the Dialog opens again.

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  McpRuntimeTestSessionDtoSchema,
  type McpRuntimeTestCreateReceipt,
  type McpRuntimeTestMessageReceipt,
  type McpRuntimeTestMutationReceipt,
  type McpRuntimeTestSessionDto,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { Field, TextArea } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { RuntimeSelect } from '@/components/RuntimeSelect'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { SessionConversationPanel } from '@/components/node-session/SessionConversationPanel'
import type { SplitBusyRelease } from '@/components/split/splitDirty'
import { MCP_RUNTIME_TEST_QUERY_KEYS, useMcpRuntimeTestsWs } from '@/hooks/useMcpRuntimeTestsWs'
import { useRuntimesList } from '@/hooks/useRuntimesList'

export interface McpRuntimeTestDialogProps {
  mcpId: string
  operationConfigHash?: string
  dirty?: boolean
  saving?: boolean
  onSaveForRuntimeTest?: () => Promise<string | null>
  beginBusy?: () => SplitBusyRelease
}

interface CreateIds {
  key: string
  clientCreateId: string
  clientMessageId: string
}

interface MessageId {
  key: string
  clientMessageId: string
}

interface CreateResult {
  session: McpRuntimeTestSessionDto
  receiptReplaced: boolean
}

function latestKey(mcpId: string): readonly unknown[] {
  return MCP_RUNTIME_TEST_QUERY_KEYS.latest(mcpId)
}

function exactPath(mcpId: string, sessionId: string): string {
  return `/api/mcps/${encodeURIComponent(mcpId)}/runtime-test-sessions/${encodeURIComponent(
    sessionId,
  )}`
}

function parseSession(value: unknown): McpRuntimeTestSessionDto {
  return McpRuntimeTestSessionDtoSchema.parse(value)
}

async function loadLatestSession(
  mcpId: string,
  signal?: AbortSignal,
): Promise<McpRuntimeTestSessionDto | null> {
  const raw = await api.get<unknown>(
    `/api/mcps/${encodeURIComponent(mcpId)}/runtime-test-session`,
    undefined,
    signal,
  )
  return raw === null ? null : parseSession(raw)
}

function statusKind(session: McpRuntimeTestSessionDto): StatusChipKind {
  if (session.status === 'ended') return 'neutral'
  if (session.status === 'ending') return 'warn'
  if (session.inFlightTurnId !== null) return 'info'
  return 'success'
}

export function McpRuntimeTestDialog(props: McpRuntimeTestDialogProps): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [endConfirmOpen, setEndConfirmOpen] = useState(false)
  const [runtimeName, setRuntimeName] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [receiptReplaced, setReceiptReplaced] = useState(false)
  const [operationError, setOperationError] = useState<unknown>(null)
  const [clock, setClock] = useState(Date.now())
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const endTriggerRef = useRef<HTMLButtonElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const createIdsRef = useRef<CreateIds | null>(null)
  const messageIdRef = useRef<MessageId | null>(null)
  useMcpRuntimeTestsWs({ mcpId: props.mcpId, enabled: open })

  const runtimes = useRuntimesList(runtimeName, {
    requireCapability: 'mcp-test-v1',
    enabled: open,
  })
  useEffect(() => {
    if (!open || runtimes.isLoading || runtimes.isError) return
    if (
      runtimeName !== null &&
      runtimes.selectableRuntimes.some((runtime) => runtime.name === runtimeName)
    ) {
      return
    }
    const preferred =
      runtimes.selectableRuntimes.find((runtime) => runtime.isDefault === true) ??
      runtimes.selectableRuntimes[0]
    setRuntimeName(preferred?.name ?? null)
  }, [open, runtimeName, runtimes.isError, runtimes.isLoading, runtimes.selectableRuntimes])

  const sessionQuery = useQuery<McpRuntimeTestSessionDto | null>({
    queryKey: latestKey(props.mcpId),
    enabled: open,
    queryFn: ({ signal }) => loadLatestSession(props.mcpId, signal),
    refetchInterval: (query) => {
      const session = query.state.data
      return session !== null && session !== undefined && session.status !== 'ended' ? 1500 : false
    },
    refetchOnMount: 'always',
  })
  const session = sessionQuery.data ?? null

  useEffect(() => {
    if (!open || session?.idleDeadlineAt === null || session?.idleDeadlineAt === undefined) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open, session?.idleDeadlineAt])

  const installSession = (next: McpRuntimeTestSessionDto): McpRuntimeTestSessionDto => {
    qc.setQueryData(latestKey(props.mcpId), next)
    return next
  }

  const createMutation = useMutation({
    mutationFn: async (input: {
      hash: string
      runtimeName: string | null
      message: string
    }): Promise<CreateResult> => {
      const key = JSON.stringify([input.hash, input.runtimeName, input.message])
      if (createIdsRef.current?.key !== key) {
        createIdsRef.current = {
          key,
          clientCreateId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
        }
      }
      const ids = createIdsRef.current
      const release = props.beginBusy?.() ?? (() => undefined)
      try {
        try {
          const receipt = await api.post<McpRuntimeTestCreateReceipt>(
            `/api/mcps/${encodeURIComponent(props.mcpId)}/runtime-test-sessions`,
            {
              expectedMcpConfigHash: input.hash,
              runtimeName: input.runtimeName,
              message: input.message,
              clientCreateId: ids.clientCreateId,
              clientMessageId: ids.clientMessageId,
            },
          )
          try {
            const next = parseSession(
              await api.get<unknown>(exactPath(props.mcpId, receipt.sessionId)),
            )
            createIdsRef.current = null
            return { session: next, receiptReplaced: false }
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error
            const latest = await loadLatestSession(props.mcpId)
            if (latest === null) throw error
            createIdsRef.current = null
            return { session: latest, receiptReplaced: true }
          }
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'mcp-test-session-exists') {
            throw error
          }
          const latest = await loadLatestSession(props.mcpId)
          if (latest === null) throw error
          createIdsRef.current = null
          return { session: latest, receiptReplaced: false }
        }
      } finally {
        release()
      }
    },
    onSuccess: (result) => {
      installSession(result.session)
      setReceiptReplaced(result.receiptReplaced)
      setMessage('')
    },
  })

  const messageMutation = useMutation({
    mutationFn: async (input: {
      session: McpRuntimeTestSessionDto
      message: string
    }): Promise<McpRuntimeTestSessionDto> => {
      const key = JSON.stringify([input.session.id, input.message])
      if (messageIdRef.current?.key !== key) {
        messageIdRef.current = { key, clientMessageId: crypto.randomUUID() }
      }
      const receipt = await api.post<McpRuntimeTestMessageReceipt>(
        `${exactPath(props.mcpId, input.session.id)}/messages`,
        {
          message: input.message,
          clientMessageId: messageIdRef.current.clientMessageId,
          expectedSessionVersion: input.session.sessionVersion,
        },
      )
      return parseSession(await api.get<unknown>(exactPath(props.mcpId, receipt.sessionId)))
    },
    onSuccess: (next) => {
      installSession(next)
      messageIdRef.current = null
      setMessage('')
    },
  })

  const cancelMutation = useMutation({
    mutationFn: async (input: {
      sessionId: string
      turnId: string
    }): Promise<McpRuntimeTestSessionDto> => {
      const receipt = await api.post<McpRuntimeTestMutationReceipt>(
        `${exactPath(props.mcpId, input.sessionId)}/cancel-turn`,
        { turnId: input.turnId },
      )
      return parseSession(receipt.session)
    },
    onSuccess: installSession,
  })

  const endMutation = useMutation({
    mutationFn: async (sessionId: string): Promise<McpRuntimeTestSessionDto> => {
      const receipt = await api.post<McpRuntimeTestMutationReceipt>(
        `${exactPath(props.mcpId, sessionId)}/end`,
        {},
      )
      return parseSession(receipt.session)
    },
    onSuccess: installSession,
  })

  const mutationError =
    operationError ??
    createMutation.error ??
    messageMutation.error ??
    cancelMutation.error ??
    endMutation.error
  const mutationPending = createMutation.isPending || messageMutation.isPending
  const canCompose =
    session !== null &&
    session.status === 'active' &&
    session.inFlightTurnId === null &&
    session.nativeSessionReady &&
    session.continuationBlockedReason === null
  const canCreate = session === null || session.status === 'ended'
  const countdown =
    session?.idleDeadlineAt === null || session?.idleDeadlineAt === undefined
      ? null
      : Math.max(0, session.idleDeadlineAt - clock)
  const latestTurn = session?.turns.at(-1)
  const latestTurnIssue =
    latestTurn !== undefined &&
    (latestTurn.status === 'failed' ||
      latestTurn.status === 'canceled' ||
      latestTurn.status === 'timed_out' ||
      latestTurn.status === 'interrupted')
      ? latestTurn
      : null
  const latestTurnIssueTitle =
    latestTurnIssue === null
      ? null
      : latestTurnIssue.status === 'failed'
        ? t('mcps.runtimeTest.turnOutcome.failed')
        : latestTurnIssue.status === 'canceled'
          ? t('mcps.runtimeTest.turnOutcome.canceled')
          : latestTurnIssue.status === 'timed_out'
            ? t('mcps.runtimeTest.turnOutcome.timedOut')
            : t('mcps.runtimeTest.turnOutcome.interrupted')

  async function start(savedHash: string): Promise<void> {
    if (message.trim() === '' || createMutation.isPending || runtimeName === null) return
    setOperationError(null)
    await createMutation.mutateAsync({
      hash: savedHash,
      runtimeName,
      message,
    })
  }

  async function saveAndStart(): Promise<void> {
    if (props.onSaveForRuntimeTest === undefined) return
    setOperationError(null)
    try {
      const hash = await props.onSaveForRuntimeTest()
      if (hash !== null) await start(hash)
    } catch (error) {
      setOperationError(error)
    }
  }

  function sendMessage(): void {
    if (!canCompose || session === null || message.trim() === '') return
    messageMutation.mutate({ session, message })
  }

  const phaseLabel =
    session === null
      ? t('mcps.runtimeTest.status.new')
      : session.status === 'ending'
        ? t('mcps.runtimeTest.status.ending')
        : session.status === 'ended'
          ? t('mcps.runtimeTest.status.ended')
          : session.inFlightTurnId !== null
            ? t('mcps.runtimeTest.status.running')
            : t('mcps.runtimeTest.status.idle')

  const footer = (
    <div className="mcp-runtime-test__footer">
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        {t('common.close')}
      </button>
      <span className="mcp-runtime-test__footer-spacer" />
      {session?.status === 'active' && session.inFlightTurnId !== null && (
        <button
          type="button"
          className="btn"
          disabled={cancelMutation.isPending || endMutation.isPending}
          onClick={() =>
            cancelMutation.mutate({
              sessionId: session.id,
              turnId: session.inFlightTurnId!,
            })
          }
          data-testid="mcp-runtime-test-cancel-turn"
        >
          {cancelMutation.isPending
            ? t('mcps.runtimeTest.canceling')
            : t('mcps.runtimeTest.cancelTurn')}
        </button>
      )}
      {session?.status === 'active' && (
        <button
          ref={endTriggerRef}
          type="button"
          className="btn btn--danger"
          disabled={endMutation.isPending || cancelMutation.isPending}
          onClick={() => setEndConfirmOpen(true)}
          data-testid="mcp-runtime-test-end"
        >
          {t('mcps.runtimeTest.endNow')}
        </button>
      )}
      {canCompose && (
        <button
          type="button"
          className="btn btn--primary"
          disabled={message.trim() === '' || messageMutation.isPending}
          onClick={sendMessage}
          data-testid="mcp-runtime-test-send"
        >
          {messageMutation.isPending ? t('mcps.runtimeTest.sending') : t('mcps.runtimeTest.send')}
        </button>
      )}
      {canCreate && props.dirty === true && (
        <>
          <button
            type="button"
            className="btn"
            disabled={
              props.operationConfigHash === undefined ||
              runtimeName === null ||
              message.trim() === '' ||
              createMutation.isPending ||
              runtimes.isLoading ||
              runtimes.isError ||
              runtimes.selectableRuntimes.length === 0
            }
            onClick={() => {
              const hash = props.operationConfigHash
              if (hash !== undefined) void start(hash).catch(() => undefined)
            }}
          >
            {t('mcps.runtimeTest.useSaved')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={
              props.onSaveForRuntimeTest === undefined ||
              runtimeName === null ||
              message.trim() === '' ||
              createMutation.isPending ||
              props.saving === true ||
              runtimes.isLoading ||
              runtimes.isError ||
              runtimes.selectableRuntimes.length === 0
            }
            onClick={() => void saveAndStart()}
            data-testid="mcp-runtime-test-save-start"
          >
            {props.saving === true ? t('common.saving') : t('mcps.runtimeTest.saveAndStart')}
          </button>
        </>
      )}
      {canCreate && props.dirty !== true && (
        <button
          type="button"
          className="btn btn--primary"
          disabled={
            props.operationConfigHash === undefined ||
            runtimeName === null ||
            message.trim() === '' ||
            createMutation.isPending ||
            runtimes.isLoading ||
            runtimes.isError ||
            runtimes.selectableRuntimes.length === 0
          }
          onClick={() => {
            const hash = props.operationConfigHash
            if (hash !== undefined) void start(hash).catch(() => undefined)
          }}
          data-testid="mcp-runtime-test-start"
        >
          {createMutation.isPending ? t('mcps.runtimeTest.starting') : t('mcps.runtimeTest.start')}
        </button>
      )}
    </div>
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--sm"
        onClick={() => setOpen(true)}
        data-testid="mcp-runtime-test-open"
      >
        {t('mcps.runtimeTest.open')}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('mcps.runtimeTest.title')}
        size="lg"
        triggerRef={triggerRef}
        initialFocusRef={composerRef}
        dismissDisabled={mutationPending}
        footer={footer}
        panelClassName="mcp-runtime-test"
        data-testid="mcp-runtime-test-dialog"
      >
        <div className="mcp-runtime-test__body">
          <NoticeBanner tone="warning" size="compact" title={t('mcps.runtimeTest.warningTitle')}>
            {t('mcps.runtimeTest.warningBody')}
          </NoticeBanner>

          {sessionQuery.isLoading ? (
            <LoadingState label={t('mcps.runtimeTest.loading')} size="compact" />
          ) : sessionQuery.error !== null ? (
            <ErrorBanner error={sessionQuery.error} onRetry={() => void sessionQuery.refetch()} />
          ) : (
            <>
              <div className="mcp-runtime-test__status">
                {session !== null && (
                  <StatusChip kind={statusKind(session)} withDot>
                    {phaseLabel}
                  </StatusChip>
                )}
                {session !== null && (
                  <span className="muted">
                    {t('mcps.runtimeTest.runtimeSummary', {
                      runtime: session.runtime.name,
                    })}
                  </span>
                )}
                {countdown !== null && (
                  <span className="muted" data-testid="mcp-runtime-test-idle-countdown">
                    {t('mcps.runtimeTest.idleCountdown', {
                      time: formatDuration(countdown),
                    })}
                  </span>
                )}
              </div>

              {props.dirty === true && (
                <NoticeBanner tone="warning" size="compact">
                  {session !== null && session.status !== 'ended'
                    ? t('mcps.runtimeTest.activeUsesSaved')
                    : t('mcps.runtimeTest.dirtyBasis')}
                </NoticeBanner>
              )}

              {receiptReplaced && (
                <NoticeBanner tone="info" size="compact">
                  {t('mcps.runtimeTest.receiptReplaced')}
                </NoticeBanner>
              )}

              {session !== null && (
                <div className="mcp-runtime-test__conversation">
                  <SessionConversationPanel
                    queryKey={[...MCP_RUNTIME_TEST_QUERY_KEYS.sessionView(props.mcpId, session.id)]}
                    load={(signal) =>
                      api.get(`${exactPath(props.mcpId, session.id)}/session`, undefined, signal)
                    }
                    pollMs={session.status === 'ended' ? false : 1500}
                    refetchOnMount="always"
                  />
                </div>
              )}

              {latestTurnIssue !== null && latestTurnIssueTitle !== null && (
                <NoticeBanner
                  tone={latestTurnIssue.status === 'canceled' ? 'warning' : 'error'}
                  size="compact"
                  title={latestTurnIssueTitle}
                  testid="mcp-runtime-test-turn-issue"
                >
                  {latestTurnIssue.failureCode === null
                    ? t('mcps.runtimeTest.turnOutcome.noDiagnostic')
                    : t('mcps.runtimeTest.turnOutcome.diagnostic', {
                        code: latestTurnIssue.failureCode,
                      })}
                </NoticeBanner>
              )}

              {canCreate && (
                <Field label={t('mcps.runtimeTest.runtime')}>
                  <RuntimeSelect
                    value={runtimeName}
                    onChange={setRuntimeName}
                    ariaLabel={t('mcps.runtimeTest.runtime')}
                    requireCapability="mcp-test-v1"
                    disabled={createMutation.isPending}
                  />
                </Field>
              )}

              {(canCreate || canCompose) && (
                <Field
                  label={
                    canCreate
                      ? t('mcps.runtimeTest.firstMessage')
                      : t('mcps.runtimeTest.nextMessage')
                  }
                >
                  <TextArea
                    textareaRef={composerRef}
                    value={message}
                    onChange={(next) => {
                      setMessage(next)
                      setOperationError(null)
                      createIdsRef.current = null
                      messageIdRef.current = null
                    }}
                    rows={4}
                    maxLength={65_536}
                    disabled={mutationPending}
                    placeholder={t('mcps.runtimeTest.messagePlaceholder')}
                    data-testid="mcp-runtime-test-composer"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        if (canCompose) sendMessage()
                      }
                    }}
                  />
                </Field>
              )}

              {session?.status === 'ending' && (
                <NoticeBanner tone="info" size="compact">
                  {t('mcps.runtimeTest.endingHint')}
                </NoticeBanner>
              )}
              {session?.status === 'ended' && (
                <NoticeBanner tone="info" size="compact">
                  {t('mcps.runtimeTest.endedHint')}
                </NoticeBanner>
              )}
            </>
          )}

          <FeedbackStack variant="section">
            {runtimes.isError && canCreate && (
              <ErrorBanner error={new Error(t('mcps.runtimeTest.runtimeLoadError'))} />
            )}
            {!runtimes.isLoading &&
              !runtimes.isError &&
              canCreate &&
              runtimes.selectableRuntimes.length === 0 && (
                <NoticeBanner tone="warning" size="compact">
                  {t('mcps.runtimeTest.runtimeUnavailable')}
                </NoticeBanner>
              )}
            {mutationError !== null && mutationError !== undefined && (
              <ErrorBanner error={mutationError} />
            )}
          </FeedbackStack>
        </div>
      </Dialog>
      <ConfirmDialog
        open={endConfirmOpen}
        onClose={() => setEndConfirmOpen(false)}
        title={t('mcps.runtimeTest.endConfirmTitle')}
        description={t('mcps.runtimeTest.endConfirmBody')}
        confirmLabel={t('mcps.runtimeTest.endNow')}
        tone="danger"
        triggerRef={endTriggerRef}
        onConfirm={async () => {
          if (session !== null) await endMutation.mutateAsync(session.id)
        }}
      />
    </>
  )
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
