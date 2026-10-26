// RFC-395 B-5: preserve explicit runtime choices and block unproven legacy defaults.
import { expect, test } from 'bun:test'
import {
  conversion,
  runtimeConfigEnvironment,
  runtimeConfigBlock,
  type RuntimeConfigFact,
} from '@/modules/runtime-management/infrastructure/migration/runtimeConfigRule'
import {
  createBootUpgradeFacts,
  bootUpgradeEffectsFromRecords,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { describeV2Providers, emptyV2Content } from './helpers/rfc395V2Harness'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'

const config: RuntimeConfigFact = {
  state: 'present',
  source: 'config.json',
  opencodePath: '/bin/opencode',
  claudeCodePath: '/bin/claude',
  legacyDefaults: {},
  profiles: [],
}
test('legacy generation defaults require a canonical persisted profile, not a reusable name', () => {
  expect(runtimeConfigBlock({ ...config, legacyDefaults: { defaultModel: 'old' } })).toBe(
    'v2-boot-runtime-defaults-unmigrated',
  )
  expect(
    runtimeConfigBlock({
      ...config,
      legacyDefaults: { defaultModel: 'old' },
      profiles: [
        { id: 'builtin', name: 'opencode', protocol: 'opencode', values: { model: 'old' } },
      ],
    }),
  ).toBeNull()
  expect(runtimeConfigBlock({ ...config, state: 'invalid' })).toBe(
    'v2-boot-runtime-config-unproven',
  )
  expect(runtimeConfigBlock({ ...config, state: 'unavailable' })).toBe(
    'v2-boot-runtime-config-unproven',
  )
  expect(runtimeConfigBlock({ ...config, state: 'absent' })).toBeNull()
})
describeV2Providers('RFC-395 runtime configuration conversion', (h) => {
  test.each(['canonical', 'explicit', 'wrong-protocol', 'custom-only', 'empty'] as const)(
    '%s retains empty-table and null-only semantics',
    async (mode) => {
      await h.install()
      if (mode !== 'empty')
        await h.write('runtimes', [
          frozenValues('runtimes', {
            id: 'runtime',
            name: mode === 'custom-only' ? 'custom' : 'opencode',
            protocol: mode === 'wrong-protocol' ? 'claude-code' : 'opencode',
            binary_path: mode === 'explicit' ? '/user/chosen' : null,
          }),
        ])
      const input = await h.input([conversion]),
        artifacts = new Map<string, Uint8Array>()
      const capture: BootUpgradeCaptureInput = {
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
        root: {
          kind: 'app-home',
          root: h.sourceHarness.operationRoot,
          runsSupplied: false,
          objects: 'none',
        },
        manifest: {
          version: 1,
          roots: [],
          files: [],
          objects: [],
          databaseTrees: [],
          digest: valueDigest([]),
        },
        readArtifact: async (name) => artifacts.get(name) ?? null,
        writeArtifact: async (name, bytes) => {
          artifacts.set(name, bytes)
        },
      }
      try {
        const read = (text: string) => runtimeConfigEnvironment(async () => Buffer.from(text))
        const first = createBootUpgradeFacts(
          await read('{"opencodePath":"/configured","unrelated":1}').capture(capture),
        )
        const formatting = createBootUpgradeFacts(
          await read(' { "unrelated": 2, "opencodePath" : "/configured" }\n').capture(capture),
        )
        expect(formatting.environmentDigest).toBe(first.environmentDigest)
        expect(valueDigest(formatting)).not.toBe(valueDigest(first))
        const changed = createBootUpgradeFacts(
          await read('{"opencodePath":"/other"}').capture(capture),
        )
        if (mode === 'canonical')
          expect(changed.environmentDigest).not.toBe(first.environmentDigest)
        else expect(changed.environmentDigest).toBe(first.environmentDigest)
        const sink = new V2MemorySink(),
          summary = await runConversion({ ...input, bootUpgradeFacts: first }, sink)
        expect(summary.status).toBe('converted')
        const rows = sink.rows('runtimes')
        expect(rows).toHaveLength(mode === 'empty' ? 0 : 1)
        if (mode !== 'empty')
          expect(rows[0]!.binary_path).toBe(
            mode === 'canonical' ? '/configured' : mode === 'explicit' ? '/user/chosen' : null,
          )
        expect(
          bootUpgradeEffectsFromRecords(summary.records).filter(
            (effect) => effect.disposition === 'transformed',
          ),
        ).toHaveLength(mode === 'canonical' ? 1 : 0)
        const invalid = createBootUpgradeFacts(await read('{invalid').capture(capture))
        expect(
          (await runConversion({ ...input, bootUpgradeFacts: invalid }, new V2MemorySink())).status,
        ).toBe('blocked')
        const withDefaults = createBootUpgradeFacts(
          await read('{"defaultModel":"old","opencodePath":"/configured"}').capture(capture),
        )
        const evidence = withDefaults.facts[0]!.evidence as { config: RuntimeConfigFact }
        expect(evidence.config.profiles.map((profile) => profile.id)).toEqual(
          mode === 'canonical' || mode === 'explicit' ? ['runtime'] : [],
        )
      } finally {
        await input.source.close()
      }
    },
    180_000,
  )
})
