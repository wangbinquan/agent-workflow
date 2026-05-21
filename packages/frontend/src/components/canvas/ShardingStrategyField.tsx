// RFC-055 — fanout (agent-multi) node sharding strategy inspector field.
//
// Renders a <Select> for the three sharding kinds + a conditional
// <NumberInput> for `n` (per-n-files) or `depth` (per-directory).
// Writes back the full ShardingStrategy object via onChange.
//
// Per CLAUDE.md "Frontend UI consistency": uses the shared <Select> /
// <Field> / <NumberInput> primitives — no native <select> chrome, no
// custom CSS for popovers.

import { useTranslation } from 'react-i18next'
import {
  DEFAULT_SHARDING_STRATEGY,
  SHARDING_KINDS,
  type ShardingKind,
  type ShardingStrategy,
  normalizeShardingStrategy,
} from '@agent-workflow/shared'
import { Field, NumberInput } from '../Form'
import { Select, type SelectOption } from '../Select'

interface Props {
  value: ShardingStrategy | undefined
  onChange: (next: ShardingStrategy) => void
  disabled?: boolean
}

const KIND_TO_KEY: Record<ShardingKind, 'perFile' | 'perNFiles' | 'perDirectory'> = {
  'per-file': 'perFile',
  'per-n-files': 'perNFiles',
  'per-directory': 'perDirectory',
}

export function ShardingStrategyField({ value, onChange, disabled }: Props) {
  const { t } = useTranslation()
  const v = value ?? DEFAULT_SHARDING_STRATEGY
  const options: SelectOption<ShardingKind>[] = SHARDING_KINDS.map((k) => ({
    value: k,
    label: t(`inspector.shardingKind.${KIND_TO_KEY[k]}`),
  }))
  return (
    <>
      <Field
        label={t('inspector.fieldShardingStrategy')}
        required
        hint={t('inspector.fieldShardingStrategyHint')}
      >
        <Select<ShardingKind>
          value={v.kind}
          options={options}
          onChange={(k) => onChange(normalizeShardingStrategy(value, k))}
          disabled={disabled}
          ariaLabel={t('inspector.fieldShardingStrategy')}
        />
      </Field>
      {v.kind === 'per-n-files' && (
        <Field
          label={t('inspector.fieldShardingN')}
          required
          hint={t('inspector.fieldShardingNHint')}
        >
          <NumberInput
            value={v.n}
            min={1}
            step={1}
            onChange={(n) =>
              onChange({ kind: 'per-n-files', n: n == null || n < 1 ? 1 : Math.floor(n) })
            }
            disabled={disabled}
            data-testid="sharding-n-input"
          />
        </Field>
      )}
      {v.kind === 'per-directory' && (
        <Field
          label={t('inspector.fieldShardingDepth')}
          hint={t('inspector.fieldShardingDepthHint')}
        >
          <NumberInput
            value={v.depth}
            min={1}
            step={1}
            onChange={(d) =>
              onChange(
                d == null
                  ? { kind: 'per-directory' }
                  : { kind: 'per-directory', depth: Math.max(1, Math.floor(d)) },
              )
            }
            disabled={disabled}
            data-testid="sharding-depth-input"
          />
        </Field>
      )}
    </>
  )
}
