import { describe, expect, test } from 'vitest'
import { RUNTIME_TEMPLATE_AUTHORITY_KEYS } from '@agent-workflow/shared'

import {
  RUNTIME_PARAMETER_AUTHORITY_ADAPTERS,
  runtimeParameterTargetForAuthority,
} from '../src/components/runtime-parameters/authority'

describe('runtime parameter authority adapters', () => {
  test('shared stable families and production adapter registry are an exact two-way set', () => {
    expect(Object.keys(RUNTIME_PARAMETER_AUTHORITY_ADAPTERS).sort()).toEqual(
      [...RUNTIME_TEMPLATE_AUTHORITY_KEYS].sort(),
    )
  })

  test('sink mode is enforced by the actual target builder', () => {
    const target = {
      id: 'field',
      label: 'Field',
      mode: 'replace-whole-value' as const,
      value: '',
      revision: 1,
      commit: () => {},
    }
    expect(runtimeParameterTargetForAuthority('workflow:http-param', target)).toBe(target)
    expect(() => runtimeParameterTargetForAuthority('workflow:model-prompt', target)).toThrow(
      /does not support target mode/,
    )
  })
})
