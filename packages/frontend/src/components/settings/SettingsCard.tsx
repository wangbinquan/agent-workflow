import { useId, type ReactNode, type Ref } from 'react'
import { Card } from '@/components/Card'

export interface SettingsCardProps {
  title: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  as?: 'section' | 'fieldset'
  disabled?: boolean
  titleRef?: Ref<HTMLHeadingElement>
  className?: string
  'data-testid'?: string
}

/** The System Agents card contract, promoted to every `/settings` group. */
export function SettingsCard({
  title,
  hint,
  actions,
  children,
  as = 'section',
  disabled,
  titleRef,
  className,
  'data-testid': testid,
}: SettingsCardProps) {
  const generatedTitleId = useId()
  const titleId = `settings-card-title-${generatedTitleId.replaceAll(':', '')}`
  const classes = ['settings-card']
  if (className !== undefined && className !== '') classes.push(className)

  return (
    <Card
      as={as}
      disabled={as === 'fieldset' ? disabled : undefined}
      title={title}
      titleId={titleId}
      titleRef={titleRef}
      actions={actions}
      aria-labelledby={titleId}
      className={classes.join(' ')}
      data-testid={testid}
      header={
        hint === undefined || hint === null || hint === false ? undefined : (
          <p className="settings-hint settings-hint--tight">{hint}</p>
        )
      }
    >
      <div className="form-section__body">{children}</div>
    </Card>
  )
}
