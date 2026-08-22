import type { SelectOption } from '@/components/Select'

import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'

export type TaskCreationContractInputKind = 'text' | 'repository-picker' | 'repository-group-picker'

export interface TaskCreationContractField {
  readonly fieldRef: string
  readonly label: string
  readonly description?: string
  readonly inputKind: TaskCreationContractInputKind
  readonly required: boolean
  readonly value: string
  readonly onChange: (value: string) => void
  readonly options?: ReadonlyArray<SelectOption<string>>
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly testId?: string
}

/**
 * Shared renderer for contract-declared task fields.
 *
 * A source flow supplies only the contract projection and controlled values. It
 * cannot invent another field layout or silently derive a selection from the
 * available options. Read-only injected values use the same control with the
 * disabled state, so they remain visible as ordinary task parameters.
 */
export function TaskCreationContractFields(props: {
  readonly fields: readonly TaskCreationContractField[]
}) {
  return (
    <div className="form-grid" data-testid="task-creation-contract-fields">
      {props.fields.map((field) => (
        <Field
          key={field.fieldRef}
          label={field.label}
          hint={field.description}
          required={field.required}
        >
          {field.inputKind === 'text' ? (
            <TextInput
              value={field.value}
              onChange={field.onChange}
              placeholder={field.placeholder}
              disabled={field.disabled}
            />
          ) : (
            <Select
              value={field.value}
              onChange={field.onChange}
              options={field.options ?? []}
              searchable
              ariaLabel={field.label}
              placeholder={field.placeholder}
              disabled={field.disabled}
              data-testid={field.testId}
            />
          )}
        </Field>
      ))}
    </div>
  )
}
