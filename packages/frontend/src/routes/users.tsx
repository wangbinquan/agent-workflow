// RFC-221 — responsive admin user directory. Human accounts are searchable,
// filterable and managed through focused transactions; the daemon's immutable
// __system__ principal is separated from people and never enters counts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AdminUserView,
  AuthLoginPolicy,
  CreateUserBody,
  PatchUserBody,
  ResetPasswordBody,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FeedbackStack } from '@/components/FeedbackStack'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { QueryState } from '@/components/QueryState'
import { CreateUserDialog } from '@/components/users/CreateUserDialog'
import { EditUserDialog } from '@/components/users/EditUserDialog'
import { ResetUserPasswordDialog } from '@/components/users/ResetUserPasswordDialog'
import { UserDirectory } from '@/components/users/UserDirectory'
import {
  hasPermissionAtRequest,
  useActor,
  useAuthSessionRevision,
  usePermission,
} from '@/hooks/useActor'
import { getAuthSessionRevision } from '@/stores/auth'
import {
  deriveUserDirectory,
  filtersFromUsersSearch,
  searchFromUserFilters,
  validateUsersSearch,
  withUsersSearch,
  type CreateUserMode,
  type UserDirectoryFilters,
  type UsersSearch,
} from '@/lib/user-directory'
import { Route as RootRoute } from './__root'

export { validateUsersSearch }

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/users',
  validateSearch: validateUsersSearch,
  component: UsersRoutePage,
})

function UsersRoutePage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <UsersPage
      search={search}
      onSearchChange={(next, replace) => {
        void navigate({
          search: (previous) => withUsersSearch(previous, next),
          replace,
        })
      }}
    />
  )
}

type DialogTarget = {
  userId: string
  triggerRef: RefObject<HTMLElement | null>
}

type UsersDialogState =
  | { kind: 'create'; triggerRef: RefObject<HTMLElement | null> }
  | ({ kind: 'edit' | 'reset' | 'disable' | 'enable' } & DialogTarget)
  | null

type SuccessNotice =
  | 'created-password'
  | 'created-sso'
  | 'updated'
  | 'reset'
  | 'disabled'
  | 'enabled'

interface UserWriteRequest<T> {
  session: number
  authRevision: number
  input: T
}

export function UsersPage(
  props: {
    search?: UsersSearch
    onSearchChange?: (search: UsersSearch, replace: boolean) => void
  } = {},
) {
  const { t, i18n } = useTranslation()
  const allowed = usePermission('users:read')
  const canWrite = usePermission('users:write')
  const actor = useActor()
  const authRevision = useAuthSessionRevision()
  const qc = useQueryClient()
  const headerCreateRef = useRef<HTMLButtonElement>(null)
  const [localSearch, setLocalSearch] = useState<UsersSearch>({})
  const [dialog, setDialog] = useState<UsersDialogState>(null)
  const [notice, setNotice] = useState<SuccessNotice | null>(null)
  const writeSessionRef = useRef(0)
  const previousCanWriteRef = useRef(canWrite)
  const activeAuthRevisionRef = useRef(authRevision)
  const resetMutationsRef = useRef<() => void>(() => {})
  const search = props.search ?? localSearch
  const filters = filtersFromUsersSearch(search)

  const list = useQuery<AdminUserView[]>({
    queryKey: ['users', authRevision],
    queryFn: ({ signal }) => api.get('/api/users', undefined, signal),
    enabled: allowed,
  })
  const loginPolicy = useQuery<AuthLoginPolicy>({
    queryKey: ['oidc-login-policy', authRevision],
    queryFn: ({ signal }) => api.get('/api/oidc/login-policy', undefined, signal),
    enabled: allowed,
  })
  const model = deriveUserDirectory(list.data ?? [], filters, i18n.language)

  const closeDialog = () => setDialog(null)
  const refreshUsers = async (expectedAuthRevision: number) => {
    await qc.invalidateQueries({ queryKey: ['users', expectedAuthRevision], exact: true })
  }
  const requestIsCurrent = (session: number, expectedAuthRevision: number): boolean =>
    expectedAuthRevision === getAuthSessionRevision() &&
    session === writeSessionRef.current &&
    hasPermissionAtRequest(qc, 'users:write')
  const create = useMutation({
    mutationFn: ({
      input,
      session,
      authRevision: requestAuthRevision,
    }: UserWriteRequest<{ body: CreateUserBody; mode: CreateUserMode }>) => {
      if (!requestIsCurrent(session, requestAuthRevision)) {
        throw new Error('User management session ended')
      }
      return api.post<AdminUserView>('/api/users', input.body)
    },
    onSuccess: async (_created, request) => {
      if (!requestIsCurrent(request.session, request.authRevision)) return
      await refreshUsers(request.authRevision)
      if (!requestIsCurrent(request.session, request.authRevision)) return
      closeDialog()
      setNotice(request.input.mode === 'sso' ? 'created-sso' : 'created-password')
    },
  })
  const update = useMutation({
    mutationFn: ({
      input,
      session,
      authRevision: requestAuthRevision,
    }: UserWriteRequest<{ id: string; patch: PatchUserBody }>) => {
      if (!requestIsCurrent(session, requestAuthRevision)) {
        throw new Error('User management session ended')
      }
      return api.patch<AdminUserView>(`/api/users/${input.id}`, input.patch)
    },
    onSuccess: async (_updated, request) => {
      if (!requestIsCurrent(request.session, request.authRevision)) return
      await refreshUsers(request.authRevision)
      if (!requestIsCurrent(request.session, request.authRevision)) return
      closeDialog()
      setNotice('updated')
    },
  })
  const reset = useMutation({
    mutationFn: ({
      input,
      session,
      authRevision: requestAuthRevision,
    }: UserWriteRequest<{ id: string; body: ResetPasswordBody }>) => {
      if (!requestIsCurrent(session, requestAuthRevision)) {
        throw new Error('User management session ended')
      }
      return api.post(`/api/users/${input.id}/reset-password`, input.body)
    },
    onSuccess: async (_reset, request) => {
      if (!requestIsCurrent(request.session, request.authRevision)) return
      await refreshUsers(request.authRevision)
      if (!requestIsCurrent(request.session, request.authRevision)) return
      closeDialog()
      setNotice('reset')
    },
  })
  const disable = useMutation({
    mutationFn: ({
      input: id,
      session,
      authRevision: requestAuthRevision,
    }: UserWriteRequest<string>) => {
      if (!requestIsCurrent(session, requestAuthRevision)) {
        throw new Error('User management session ended')
      }
      return api.delete(`/api/users/${id}`)
    },
    onSuccess: async (_disabled, request) => {
      if (!requestIsCurrent(request.session, request.authRevision)) return
      await refreshUsers(request.authRevision)
      if (!requestIsCurrent(request.session, request.authRevision)) return
      closeDialog()
      setNotice('disabled')
    },
  })
  const enable = useMutation({
    mutationFn: ({
      input: id,
      session,
      authRevision: requestAuthRevision,
    }: UserWriteRequest<string>) => {
      if (!requestIsCurrent(session, requestAuthRevision)) {
        throw new Error('User management session ended')
      }
      return api.patch(`/api/users/${id}`, { status: 'active' })
    },
    onSuccess: async (_enabled, request) => {
      if (!requestIsCurrent(request.session, request.authRevision)) return
      await refreshUsers(request.authRevision)
      if (!requestIsCurrent(request.session, request.authRevision)) return
      closeDialog()
      setNotice('enabled')
    },
  })
  resetMutationsRef.current = () => {
    create.reset()
    update.reset()
    reset.reset()
    disable.reset()
    enable.reset()
  }
  useLayoutEffect(() => {
    const lostWrite = previousCanWriteRef.current && !canWrite
    previousCanWriteRef.current = canWrite
    const authChanged = activeAuthRevisionRef.current !== authRevision
    activeAuthRevisionRef.current = authRevision
    if (lostWrite || authChanged || (!canWrite && dialog !== null)) {
      writeSessionRef.current += 1
      setDialog(null)
      setNotice(null)
      resetMutationsRef.current()
    }
  }, [authRevision, canWrite, dialog])
  const writeSession = writeSessionRef.current

  const updateFilters = (next: UserDirectoryFilters, replace: boolean) => {
    const nextSearch = searchFromUserFilters(next)
    if (props.onSearchChange !== undefined) props.onSearchChange(nextSearch, replace)
    else setLocalSearch(nextSearch)
  }
  const openCreate = (trigger: HTMLButtonElement) => {
    if (!requestIsCurrent(writeSession, authRevision)) return
    create.reset()
    setDialog({ kind: 'create', triggerRef: { current: trigger } })
  }
  const openEdit = (user: AdminUserView, trigger: HTMLButtonElement) => {
    if (!requestIsCurrent(writeSession, authRevision)) return
    update.reset()
    setDialog({ kind: 'edit', userId: user.id, triggerRef: { current: trigger } })
  }
  const target =
    dialog !== null && dialog.kind !== 'create'
      ? (list.data?.find((user) => user.id === dialog.userId) ?? null)
      : null
  const hasHumanData = list.data !== undefined && model.humans.length > 0

  const createAction = (
    <button
      ref={headerCreateRef}
      type="button"
      className="btn btn--primary"
      onClick={(event) => openCreate(event.currentTarget)}
    >
      {t('users.new')}
    </button>
  )

  return (
    <div className="page users-page">
      <PageHeader
        title={t('users.title')}
        meta={
          hasHumanData
            ? t('users.summary', {
                total: model.counts.total,
                admin: model.counts.admin,
                invited: model.counts.invited,
                disabled: model.counts.disabled,
              })
            : undefined
        }
        actions={hasHumanData && canWrite ? createAction : undefined}
      />

      {actor.status !== 'success' || actor.fetchStatus !== 'idle' || actor.data === undefined ? (
        actor.error !== null && actor.error !== undefined ? (
          <ErrorBanner error={actor.error} onRetry={() => void actor.refetch()} />
        ) : (
          <LoadingState />
        )
      ) : !allowed ? (
        <EmptyState
          title={t('users.noPermission.title')}
          description={t('users.noPermission.body')}
          size="compact"
          data-testid="no-permission"
        />
      ) : (
        <>
          <FeedbackStack variant="section">
            {notice !== null && (
              <NoticeBanner
                tone="success"
                size="compact"
                dismiss={{ label: t('common.close'), onDismiss: () => setNotice(null) }}
              >
                {t(`users.notice.${notice}`)}
              </NoticeBanner>
            )}
          </FeedbackStack>
          <QueryState
            query={list}
            data={list.data ?? null}
            isEmpty={(value) => value === null}
            keepDataOnError
          >
            {(rows) => {
              const directory = deriveUserDirectory(rows ?? [], filters, i18n.language)
              return (
                <UserDirectory
                  model={directory}
                  filters={filters}
                  currentUserId={actor.data?.user.id}
                  canManage={canWrite}
                  onQueryChange={(q) => updateFilters({ ...filters, q }, true)}
                  onStatusChange={(status) => updateFilters({ ...filters, status }, false)}
                  onRoleChange={(role) => updateFilters({ ...filters, role }, false)}
                  onClearFilters={() => updateFilters({ q: '', status: 'all', role: 'all' }, false)}
                  onCreate={openCreate}
                  onManage={openEdit}
                />
              )
            }}
          </QueryState>
        </>
      )}

      {canWrite && dialog?.kind === 'create' && (
        <CreateUserDialog
          triggerRef={dialog.triggerRef}
          restoreFocusFallbackRef={headerCreateRef}
          passwordLoginEnabled={loginPolicy.data?.passwordLoginEnabled}
          busy={create.isPending}
          error={create.error}
          onClose={closeDialog}
          onSubmit={(body, mode) =>
            create.mutate({ session: writeSession, authRevision, input: { body, mode } })
          }
        />
      )}
      {canWrite && dialog?.kind === 'edit' && target !== null && (
        <EditUserDialog
          user={target}
          isSelf={target.id === actor.data?.user.id}
          triggerRef={dialog.triggerRef}
          restoreFocusFallbackRef={headerCreateRef}
          busy={update.isPending}
          error={update.error}
          onClose={closeDialog}
          onSubmit={(patch) =>
            update.mutate({
              session: writeSession,
              authRevision,
              input: { id: target.id, patch },
            })
          }
          onResetPassword={() => {
            if (!requestIsCurrent(writeSession, authRevision)) return
            reset.reset()
            setDialog({ ...dialog, kind: 'reset' })
          }}
          onDisable={() => {
            if (!requestIsCurrent(writeSession, authRevision)) return
            disable.reset()
            setDialog({ ...dialog, kind: 'disable' })
          }}
          onEnable={() => {
            if (!requestIsCurrent(writeSession, authRevision)) return
            enable.reset()
            setDialog({ ...dialog, kind: 'enable' })
          }}
        />
      )}
      {canWrite && dialog?.kind === 'reset' && target !== null && !target.hasOidcIdentity && (
        <ResetUserPasswordDialog
          user={target}
          triggerRef={dialog.triggerRef}
          restoreFocusFallbackRef={headerCreateRef}
          passwordLoginEnabled={loginPolicy.data?.passwordLoginEnabled}
          busy={reset.isPending}
          error={reset.error}
          onClose={closeDialog}
          onSubmit={(body) =>
            reset.mutate({
              session: writeSession,
              authRevision,
              input: { id: target.id, body },
            })
          }
        />
      )}
      <ConfirmDialog
        open={canWrite && dialog?.kind === 'disable' && target !== null}
        title={t('users.disableTitle', { name: target?.displayName ?? '' })}
        description={t('users.disableConfirm', { name: target?.displayName ?? '' })}
        confirmLabel={t('users.disable')}
        tone="danger"
        triggerRef={dialog?.kind === 'disable' ? dialog.triggerRef : undefined}
        restoreFocusFallbackRef={headerCreateRef}
        onClose={closeDialog}
        onConfirm={async () => {
          if (target !== null) {
            await disable.mutateAsync({ session: writeSession, authRevision, input: target.id })
          }
        }}
      />
      <ConfirmDialog
        open={canWrite && dialog?.kind === 'enable' && target !== null}
        title={t('users.enableTitle', { name: target?.displayName ?? '' })}
        description={t('users.enableConfirm', { name: target?.displayName ?? '' })}
        confirmLabel={t('users.enable')}
        triggerRef={dialog?.kind === 'enable' ? dialog.triggerRef : undefined}
        restoreFocusFallbackRef={headerCreateRef}
        onClose={closeDialog}
        onConfirm={async () => {
          if (target !== null) {
            await enable.mutateAsync({ session: writeSession, authRevision, input: target.id })
          }
        }}
      />
    </div>
  )
}
