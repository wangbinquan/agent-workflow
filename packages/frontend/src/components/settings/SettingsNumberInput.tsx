import { Fragment, useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RUNTIME_NUMERIC_BOUNDS,
  SETTINGS_NUMERIC_BOUNDS,
  isNumericSettingValueWithinBound,
  type RuntimeNumericPath,
  type SettingsNumericPath,
} from '@agent-workflow/shared'
import { NumberInput } from '@/components/Form'

type NumericPath = SettingsNumericPath | RuntimeNumericPath

export interface SettingsNumberInputProps {
  setting: NumericPath
  value: number | null | undefined
  onChange: (value: number | undefined) => void
  placeholder?: string
  className?: string
  'data-testid'?: string
}

function boundFor(setting: NumericPath) {
  return setting in RUNTIME_NUMERIC_BOUNDS
    ? RUNTIME_NUMERIC_BOUNDS[setting as RuntimeNumericPath]
    : SETTINGS_NUMERIC_BOUNDS[setting as SettingsNumericPath]
}

/** One presentation and validation adapter for every numeric field in Settings. */
export function SettingsNumberInput({
  setting,
  value,
  onChange,
  placeholder,
  className,
  'data-testid': testId,
}: SettingsNumberInputProps) {
  const { t } = useTranslation()
  const errorId = useId()
  const bound = boundFor(setting)
  const numericValue = value ?? undefined
  const invalid =
    numericValue !== undefined && !isNumericSettingValueWithinBound(numericValue, bound)
  const error =
    'positiveMin' in bound
      ? t('settings.numericRangeZeroOr', { min: bound.positiveMin, max: bound.max })
      : ('valueKind' in bound ? bound.valueKind : 'integer') === 'decimal'
        ? t('settings.numericDecimalOutOfRange', { min: bound.min, max: bound.max })
        : t('settings.numericOutOfRange', { min: bound.min, max: bound.max })

  return (
    <Fragment>
      <NumberInput
        value={numericValue}
        onChange={onChange}
        placeholder={placeholder}
        min={bound.min}
        max={bound.max}
        step={'step' in bound ? bound.step : undefined}
        unit={'unit' in bound ? bound.unit : undefined}
        rangeHintText={
          'positiveMin' in bound
            ? t('common.rangeZeroOr', { min: bound.positiveMin, max: bound.max })
            : undefined
        }
        className={className}
        data-testid={testId}
        aria-invalid={invalid || undefined}
        aria-errormessage={invalid ? errorId : undefined}
        aria-describedby={invalid ? errorId : undefined}
      />
      {invalid && (
        <span id={errorId} className="form-field__error" role="alert">
          {error}
        </span>
      )}
    </Fragment>
  )
}
