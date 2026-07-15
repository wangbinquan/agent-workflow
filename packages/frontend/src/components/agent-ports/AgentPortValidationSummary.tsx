// RFC-194 — shared route/form summary for Agent port repair issues.
// Compact is the page's sole live alert; detail is deliberately a named,
// non-live region because the Ports panel can remain mounted while hidden.

import type { ReactElement } from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentPortValidationIssue, AgentPortValidationIssueCode } from '../../lib/agent-ports'
import { StatusChip } from '../StatusChip'

export interface AgentPortValidationSummaryProps {
  issues: readonly AgentPortValidationIssue[]
  variant: 'compact' | 'detail'
  onNavigate?: (target: AgentPortValidationIssue['repairTarget']) => void
}

const ISSUE_KEY: Record<AgentPortValidationIssueCode, string> = {
  'input-name-schema': 'inputNameSchema',
  'input-name-duplicate': 'inputNameDuplicate',
  'output-name-duplicate': 'outputNameDuplicate',
  'output-kind-invalid': 'outputKindInvalid',
  'wrapper-name-duplicate': 'wrapperNameDuplicate',
  'reserved-port-sidecar-key': 'reservedPortSidecarKey',
  'orphan-output-kind': 'orphanOutputKind',
  'orphan-wrapper-name': 'orphanWrapperName',
}

const ISSUE_DEFAULT: Record<AgentPortValidationIssueCode, string> = {
  'input-name-schema': 'Input port {{position}} ({{name}}) has an invalid name.',
  'input-name-duplicate': 'Input port {{name}} is duplicated at items {{positions}}.',
  'output-name-duplicate': 'Output port {{name}} is duplicated at items {{positions}}.',
  'output-kind-invalid': 'Output kind for {{key}} is invalid: {{value}}.',
  'wrapper-name-duplicate': 'Wrapper port {{name}} is produced by output items {{positions}}.',
  'reserved-port-sidecar-key': 'Reserved key {{key}} must not be stored in extra frontmatter.',
  'orphan-output-kind': 'Output kind {{key}} is not attached to a declared output: {{value}}.',
  'orphan-wrapper-name': 'Wrapper mapping {{key}} is not attached to a declared output: {{value}}.',
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function issueInterpolation(issue: AgentPortValidationIssue): Record<string, string | number> {
  return {
    name: issue.name ?? issue.key ?? '',
    key: issue.key ?? issue.name ?? '',
    position: issue.index === undefined ? '—' : issue.index + 1,
    positions: (issue.indices ?? []).map((index) => index + 1).join(', '),
    value: displayValue(issue.value),
  }
}

export function AgentPortValidationSummary({
  issues,
  variant,
  onNavigate,
}: AgentPortValidationSummaryProps): ReactElement | null {
  const { t } = useTranslation()
  const headingId = useId()
  if (issues.length === 0) return null

  const title = t(`agentForm.ports.validation.${variant}Title`, {
    count: issues.length,
    defaultValue:
      variant === 'compact'
        ? 'Port configuration needs attention ({{count}})'
        : 'Port configuration issues ({{count}})',
  })

  return (
    <section
      className={`agent-port-validation agent-port-validation--${variant}`}
      role={variant === 'compact' ? 'alert' : 'region'}
      aria-labelledby={headingId}
      data-testid={`agent-port-validation-${variant}`}
    >
      <h3 id={headingId} className="agent-port-validation__title">
        {title}
      </h3>
      <ul className="agent-port-validation__list">
        {issues.map((issue, index) => {
          const issueKey = ISSUE_KEY[issue.code]
          const targetLabel = t(`agentForm.ports.validation.target.${issue.repairTarget}`, {
            defaultValue: issue.repairTarget === 'ports' ? 'Fix in Ports' : 'Fix in Advanced',
          })
          const message = t(`agentForm.ports.validation.issue.${issueKey}`, {
            ...issueInterpolation(issue),
            defaultValue: ISSUE_DEFAULT[issue.code],
          })
          return (
            <li
              key={`${issue.code}-${issue.key ?? issue.name ?? ''}-${issue.index ?? index}`}
              className={`agent-port-validation__item agent-port-validation__item--${issue.severity}`}
            >
              <StatusChip kind={issue.severity === 'error' ? 'danger' : 'warn'} size="sm">
                {t(`agentForm.ports.validation.severity.${issue.severity}`, {
                  defaultValue: issue.severity === 'error' ? 'Error' : 'Warning',
                })}
              </StatusChip>
              <span className="agent-port-validation__message">{message}</span>
              {onNavigate === undefined ? (
                <span className="agent-port-validation__target">{targetLabel}</span>
              ) : (
                <button
                  type="button"
                  className="btn btn--xs agent-port-validation__navigate"
                  onClick={() => {
                    onNavigate(issue.repairTarget)
                    requestAnimationFrame(() => {
                      document
                        .querySelector<HTMLElement>(
                          `[data-testid="agent-tab-${issue.repairTarget}"]`,
                        )
                        ?.focus()
                    })
                  }}
                  aria-label={`${targetLabel}: ${message}`}
                >
                  {targetLabel}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
