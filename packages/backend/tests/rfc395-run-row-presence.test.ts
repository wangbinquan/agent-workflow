// RFC-395 N-a: absent subordinate rows never synthesize configuration or process facts.
import { expect, test } from 'bun:test'
import {
  nodeRunRowPresence,
  NODE_RUN_CONFIG_FIELDS,
  NODE_RUN_RUNTIME_FIELDS,
  NODE_RUN_RESULT_FIELDS,
} from '@/modules/task-execution/domain/nodeRunRowPresence'

for (const role of ['node-attempt', 'container', 'synthetic', null] as const)
  for (const recordMode of ['executable', 'history-only'] as const) {
    test(`${recordMode}/${role}: an identity alone creates no subordinate rows`, () => {
      expect(nodeRunRowPresence({ role, recordMode })).toEqual({
        config: false,
        runtimeState: false,
        result: false,
      })
      expect(
        nodeRunRowPresence({
          role,
          recordMode,
          config: { runtime: null },
          runtime: { mergeState: null },
          result: { rolledBack: null },
        }),
      ).toEqual({ config: false, runtimeState: false, result: false })
    })
  }
for (const [group, fields, flag] of [
  ['config', NODE_RUN_CONFIG_FIELDS, 'config'],
  ['runtime', NODE_RUN_RUNTIME_FIELDS, 'runtimeState'],
  ['result', NODE_RUN_RESULT_FIELDS, 'result'],
] as const)
  for (const field of fields)
    test(`${group}.${field}: recorded false/zero/empty values survive unknown history`, () => {
      for (const value of [false, 0, '', new Uint8Array(0)])
        expect(
          nodeRunRowPresence({
            role: null,
            recordMode: 'history-only',
            [group]: { [field]: value },
          })[flag],
        ).toBe(true)
      for (const value of [null, undefined])
        expect(
          nodeRunRowPresence({
            role: null,
            recordMode: 'history-only',
            [group]: { [field]: value },
          })[flag],
        ).toBe(false)
    })
