import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isHostExecutionGroupReady,
  type HostExecutionGroup,
  type HostExecutionStatus,
} from '@agent-workflow/shared'
import { useHostExecutionStatus } from './useHostExecutionStatus'

/** Standalone native components keep their original behavior. The real app
 * always installs its selected status, including the unknown/loading state. */
export const HostExecutionReadinessContext = createContext<HostExecutionStatus | undefined>({
  mode: 'native',
  status: null,
})

export function HostExecutionProvider({ children }: { children: ReactNode }) {
  const query = useHostExecutionStatus()
  return (
    <HostExecutionReadinessContext.Provider value={query.isError ? undefined : query.data}>
      {children}
    </HostExecutionReadinessContext.Provider>
  )
}

export function useHostExecutionAvailability(group: HostExecutionGroup) {
  const view = useContext(HostExecutionReadinessContext),
    { t } = useTranslation()
  const available = view !== undefined && isHostExecutionGroupReady(view, group)
  const canRecoverOriginal =
    view?.mode === 'execution' && !available && ['standby', 'draining'].includes(view.status.phase)
  const unavailableReason = available
    ? undefined
    : view === undefined
      ? t('hostExecution.checking')
      : t('hostExecution.unavailable', { groups: t(`hostExecution.group.${group}`) })
  const current = useRef({ available, unavailableReason, canRecoverOriginal })
  current.current = { available, unavailableReason, canRecoverOriginal }
  const assertAvailable = useCallback(() => {
    if (!current.current.available) throw new Error(current.current.unavailableReason)
  }, [])
  const assertRecoveryAvailable = useCallback(() => {
    if (!current.current.canRecoverOriginal)
      throw new Error(
        current.current.unavailableReason ??
          'Original recovery is not available for an active execution',
      )
  }, [])
  return {
    available,
    unavailableReason,
    assertAvailable,
    canRecoverOriginal,
    assertRecoveryAvailable,
  }
}
