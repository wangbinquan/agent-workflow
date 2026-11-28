// RFC-626 design §3.4 rows 6a / 6b and §3.5. Locks three things:
// - `judgeRuntimeConfigFile` is the one judgement of `config.json` (strict UTF-8, JSON, top-level
//   object, binary paths as text, ENOENT is fine and other read errors are not). The boot facts
//   use it and the environment check before an automatic upgrade compares against it.
// - Legacy default keys left in config.json no longer block the automatic upgrade: runtimes
//   convert as usual (binary path inheritance included) with a
//   `v2-boot-runtime-defaults-not-carried` decision, and an empty `runtimes` table gets the
//   decision instead of a table block.
// - An unproven config.json (or no captured fact) cannot occur once the environment check ran;
//   meeting it in the automatic conversion is an engine error. Operator resolution keeps the
//   row and table blocks.
import { setDefaultTimeout, expect, test } from 'bun:test'
import {
  conversion,
  judgeRuntimeConfigFile,
  runtimeConfigEnvironment,
  RUNTIME_DEFAULTS_NOT_CARRIED,
} from '@/modules/runtime-management/infrastructure/migration/runtimeConfigRule'
import { judgeRuntimeConfigFile as composed } from '@/modules/runtime-management/composition/conversion'
import { createBootUpgradeFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import type { MigrationRecord } from '@/platform/persistence/migration/conversion/types'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import { describeV2Providers, emptyV2Content } from './helpers/rfc395V2Harness'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'

setDefaultTimeout(60_000)

const bytes = (text: string) => new TextEncoder().encode(text)
const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' })
const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' })
test.each([
  ['missing file (reader returned nothing)', { bytes: null }, true, 'absent', null],
  ['missing file (ENOENT)', { error: enoent }, true, 'absent', null],
  ['other read error', { error: eacces }, false, 'unavailable', 'config-unreadable'],
  ['valid object', { bytes: bytes('{"opencodePath":"/bin/oc"}') }, true, 'present', null],
  ['binary paths may be null', { bytes: bytes('{"claudeCodePath":null}') }, true, 'present', null],
  [
    'not strict UTF-8',
    { bytes: new Uint8Array([0x7b, 0xff, 0x7d]) },
    false,
    'invalid',
    'config-not-utf8',
  ],
  ['not JSON', { bytes: bytes('{invalid') }, false, 'invalid', 'config-not-json'],
  ['top level is an array', { bytes: bytes('[]') }, false, 'invalid', 'config-not-object'],
  ['top level is null', { bytes: bytes('null') }, false, 'invalid', 'config-not-object'],
  [
    'binary path not text',
    { bytes: bytes('{"opencodePath":7}') },
    false,
    'invalid',
    'config-binary-invalid: opencodePath',
  ],
] as const)('config.json judgement: %s', (_name, input, valid, state, reason) => {
  const judged = judgeRuntimeConfigFile(input)
  expect(judged.valid).toBe(valid)
  expect(judged.state).toBe(state)
  if (reason === null) expect(judged.reason).toBeNull()
  else expect(String(judged.reason)).toStartWith(reason)
})
test('an invalid binary path still yields the parsed object; the composition exports the same judge', () => {
  expect(
    judgeRuntimeConfigFile({ bytes: bytes('{"defaultModel":"m","claudeCodePath":1}') }),
  ).toEqual({
    valid: false,
    state: 'invalid',
    reason: 'config-binary-invalid: claudeCodePath',
    object: { defaultModel: 'm', claudeCodePath: 1 },
  })
  expect(composed).toBe(judgeRuntimeConfigFile)
})

function captureInput(input: ConversionInput, root: string): BootUpgradeCaptureInput {
  return {
    stage: 'plan',
    source: {
      reader: input.source,
      preflight: input.preflight,
      preUpgrade: null,
      watermark: input.preflight.watermark,
      evidenceRoot: null,
      close: async () => {},
    },
    content: emptyV2Content,
    root: { kind: 'app-home', root, runsSupplied: false, objects: 'none' },
    manifest: {
      version: 1,
      roots: [],
      files: [],
      objects: [],
      databaseTrees: [],
      digest: valueDigest([]),
    },
    readArtifact: async () => null,
    writeArtifact: async () => {},
  }
}
const notCarried = (sink: V2MemorySink) =>
  [...sink.units.values()]
    .flatMap((unit) => unit.records)
    .filter(
      (record): record is Extract<MigrationRecord, { kind: 'decision' }> =>
        record.kind === 'decision' && record.code === RUNTIME_DEFAULTS_NOT_CARRIED,
    )

describeV2Providers('RFC-626 runtime configuration under automatic resolution', (h) => {
  for (const mode of ['with-runtime', 'empty'] as const)
    test(`legacy defaults are left behind without blocking (${mode})`, async () => {
      await h.install()
      if (mode === 'with-runtime')
        await h.write('runtimes', [
          frozenValues('runtimes', {
            id: 'runtime',
            name: 'opencode',
            protocol: 'opencode',
            binary_path: null,
          }),
        ])
      const input = await h.input([conversion])
      try {
        const facts = createBootUpgradeFacts(
          await runtimeConfigEnvironment(async () =>
            bytes('{"defaultModel":"old","opencodePath":"/configured"}'),
          ).capture(captureInput(input, h.sourceHarness.operationRoot)),
        )
        const sink = new V2MemorySink()
        const summary = await runConversion(
          { ...input, bootUpgradeFacts: facts, resolution: 'automatic' },
          sink,
        )
        expect(summary.blocks).toEqual([])
        expect(summary.status).toBe('converted')
        const decisions = notCarried(sink)
        if (mode === 'with-runtime') {
          const rows = sink.rows('runtimes')
          expect(rows).toHaveLength(1)
          // Binary path inheritance still applies to the kept runtime.
          expect(rows[0]!.binary_path).toBe('/configured')
          expect(rows[0]!.updated_at).toBe(input.planTime)
          expect(decisions).toHaveLength(1)
          expect(decisions[0]!.payload).toMatchObject({
            automatic: 'kept',
            sourceTable: 'runtimes',
            sourceKey: expect.stringMatching(/^mk1:/),
            legacyDefaults: ['defaultModel'],
          })
        } else {
          expect(sink.rows('runtimes')).toEqual([])
          // No row to carry the decision: one record without a source row.
          expect(decisions).toHaveLength(1)
          expect(decisions[0]!.payload).toMatchObject({
            automatic: 'kept',
            sourceTable: 'runtimes',
            legacyDefaults: ['defaultModel'],
          })
          expect(decisions[0]!.payload).not.toHaveProperty('sourceKey')
        }
        // Operator resolution: the same facts block the row, or the table when it is empty.
        const manualSink = new V2MemorySink()
        const manual = await runConversion({ ...input, bootUpgradeFacts: facts }, manualSink)
        expect(manual.status).toBe('blocked')
        expect(manual.blocks).toEqual([
          expect.objectContaining({
            code: 'v2-boot-runtime-defaults-unmigrated',
            scope: mode === 'empty' ? 'table' : 'row',
          }),
        ])
        expect(manualSink.rows('runtimes')).toEqual([])
        expect(notCarried(manualSink)).toEqual([])
      } finally {
        await input.source.close()
      }
    }, 180_000)

  test('an unproven config.json or a missing fact is an engine error in automatic mode', async () => {
    await h.install()
    await h.write('runtimes', [
      frozenValues('runtimes', { id: 'runtime', name: 'opencode', protocol: 'opencode' }),
    ])
    const input = await h.input([conversion])
    try {
      const invalid = createBootUpgradeFacts(
        await runtimeConfigEnvironment(async () => bytes('{invalid')).capture(
          captureInput(input, h.sourceHarness.operationRoot),
        ),
      )
      await expect(
        runConversion(
          { ...input, bootUpgradeFacts: invalid, resolution: 'automatic' },
          new V2MemorySink(),
        ),
      ).rejects.toThrow('v2-boot-runtime-config-unproven')
      await expect(
        runConversion({ ...input, resolution: 'automatic' }, new V2MemorySink()),
      ).rejects.toThrow('v2-boot-runtime-config-unproven')
      // Operator resolution: still a block, never an error.
      const manual = await runConversion(
        { ...input, bootUpgradeFacts: invalid },
        new V2MemorySink(),
      )
      expect(manual.blocks.map((block) => block.code)).toEqual(['v2-boot-runtime-config-unproven'])
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
