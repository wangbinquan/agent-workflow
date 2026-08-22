import { useTranslation } from 'react-i18next'
import { TASK_SOURCE_REGISTRATIONS, type TaskCreationKind } from '@agent-workflow/shared'

import { ChoiceCards } from '@/components/ChoiceCards'
import { ResourceIcon } from '@/components/icons/resourceIcons'
import { useActor } from '@/hooks/useActor'
import { navIconForPath } from '@/lib/nav'

export function TaskCreationKindPicker(props: {
  value: TaskCreationKind
  onChange: (kind: TaskCreationKind) => void
  availableKinds?: ReadonlySet<TaskCreationKind>
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const actor = useActor()
  const permissions =
    actor.status === 'success' &&
    actor.fetchStatus === 'idle' &&
    actor.data !== undefined &&
    actor.data !== null
      ? new Set(actor.data.permissions)
      : new Set()
  const sources = TASK_SOURCE_REGISTRATIONS.filter(
    (source) => props.availableKinds?.has(source.id) ?? true,
  )

  return (
    <ChoiceCards<TaskCreationKind>
      className="task-creation-kind-picker"
      value={props.value}
      onChange={props.onChange}
      disabled={props.disabled}
      ariaLabel={t('taskWizard.kindLabel')}
      testidPrefix="wizard-kind"
      options={sources.map((source) => {
        const permitted = permissions.has(source.creation.requiredPermission)
        return {
          value: source.id,
          label: t(source.labelKey),
          description: t(source.descriptionKey),
          icon: <ResourceIcon name={navIconForPath(source.catalogPath)} />,
          disabled: !permitted,
          title: permitted ? undefined : t('errors.permission-required'),
        }
      })}
    />
  )
}
