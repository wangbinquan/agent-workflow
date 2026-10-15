import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isExecutionAvailable,
  type ExecutionGroup,
  type ExecutionStatus,
} from '@agent-workflow/shared'
import { useExecutionStatus } from './useExecutionStatus'

/** Components rendered outside the app shell (tests, isolated previews) see a
 * standalone, always-active instance. */
export const ExecutionStatusContext = createContext<ExecutionStatus | undefined>({
  mode: 'standalone',
  state: 'active',
  reason: null,
})

export function ExecutionStatusProvider({ children }: { children: ReactNode }) {
  const query = useExecutionStatus()
  return (
    <ExecutionStatusContext.Provider value={query.data}>{children}</ExecutionStatusContext.Provider>
  )
}

/**
 * RFC-370 v2 H7: execution entrypoints are disabled only while a CrewStation
 * instance is known not to be active. An unknown status (still loading or a
 * failed read) never blocks the UI — the server refuses grouped requests itself.
 */
export function useExecutionAvailability(group: ExecutionGroup) {
  const status = useContext(ExecutionStatusContext),
    { t } = useTranslation()
  const available = status === undefined || isExecutionAvailable(status)
  const unavailableReason = available
    ? undefined
    : t('execution.unavailable', { group: t(`execution.group.${group}`) })
  const current = useRef({ available, unavailableReason })
  current.current = { available, unavailableReason }
  const assertAvailable = useCallback(() => {
    if (!current.current.available) throw new Error(current.current.unavailableReason)
  }, [])
  return { available, unavailableReason, assertAvailable }
}
