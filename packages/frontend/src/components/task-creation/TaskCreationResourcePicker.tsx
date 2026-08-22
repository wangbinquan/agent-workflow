import type { SelectOption } from '@/components/Select'

import { ErrorBanner } from '@/components/ErrorBanner'
import { Field } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { Select } from '@/components/Select'

/**
 * The one execution-object picker used by every task source.
 *
 * It is fully controlled and never derives a value from an async inventory.
 * A resource is selected only by the user or by an explicit deep-link value.
 */
export function TaskCreationResourcePicker<Value extends string>(props: {
  readonly label: string
  readonly description?: string
  readonly value: Value
  readonly onChange: (value: Value) => void
  readonly options: ReadonlyArray<SelectOption<Value>>
  readonly loading: boolean
  readonly error: unknown
  readonly onRetry: () => void
  readonly placeholder: string
  readonly emptyText: string
  readonly testId: string
  readonly disabled?: boolean
}) {
  const picker = (
    <Select
      value={props.value}
      onChange={props.onChange}
      options={props.options}
      searchable
      ariaLabel={props.label}
      placeholder={props.placeholder}
      data-testid={props.testId}
      disabled={props.disabled}
    />
  )

  return (
    <Field label={props.label} hint={props.description} required group>
      {props.loading ? (
        <LoadingState size="compact" data-testid="wizard-object-loading" />
      ) : props.error !== null && props.error !== undefined ? (
        <>
          <div data-testid="wizard-object-load-error">
            <ErrorBanner error={props.error} onRetry={props.onRetry} />
          </div>
          {props.options.length > 0 ? picker : null}
        </>
      ) : props.options.length === 0 ? (
        <div className="muted" data-testid="wizard-object-empty">
          {props.emptyText}
        </div>
      ) : (
        picker
      )}
    </Field>
  )
}
