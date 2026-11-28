// RFC-626 design §3.4 rows 4–5: with automatic resolution a scheduled task whose launch payload
// cannot be healed is kept and disabled instead of blocking the upgrade — the payload stays
// byte for byte, `enabled` false, `next_run_at` cleared, `last_error` names the cause (v0.19.2's
// `rfc165-local-path-retired: <path>` when Git could not resolve a local path), and a decision
// `v2-boot-schedule-kept-disabled-invalid` is recorded. A payload naming a cached repository
// whose address is unreadable still links to it by URL hash and stays enabled. Facts that
// contradict the frozen rows (`-fact-missing`) and engine contract errors end the upgrade.
// Operator resolution blocks every one of these rows as before.
import { expect, test } from 'bun:test'
import {
  conversion,
  healFrozenScheduledPayload,
  scheduleGitFactId,
  scheduleGitMaterial,
  SCHEDULE_KEPT_DISABLED_INVALID,
} from '@/modules/integration/infrastructure/migration/scheduledPayloadRule'
import {
  createBootUpgradeFacts,
  repositoryUrlFactKey,
  repositoryUrlFacts,
  type RepositoryUrlFact,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type { LookupReader } from '@/platform/persistence/migration/conversion/lookups'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { MigrationRecord } from '@/platform/persistence/migration/conversion/types'
import type { LocalGitFact } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import { describeV2Providers, fixtureLookup } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'

const unreadableUrl = 'https://example.test/unreadable.git'
const conflictUrl = 'https://example.test/conflict.git'
const missingFactUrl = 'https://example.test/missing-fact.git'
function urlFact(
  state: RepositoryUrlFact['state'],
  reason: string | null,
  cachedRepoId: string | null,
  rawUrl: string,
): RepositoryUrlFact {
  return {
    state,
    cachedRepoId,
    repoUrl: rawUrl,
    rawUrlDigest: valueDigest(rawUrl),
    factIds: cachedRepoId ? [`repository-url:${cachedRepoId}`] : [],
    reason,
  }
}
const urlFacts: readonly (readonly [string, RepositoryUrlFact])[] = [
  // The cache row is converted (key missing); its URL hash still names it.
  [
    repositoryUrlFactKey(unreadableUrl),
    urlFact('blocked', 'v2-boot-url-key-missing', 'cache', unreadableUrl),
  ],
  // Two caches share the hash: nothing to link to.
  [
    repositoryUrlFactKey(conflictUrl),
    urlFact('blocked', 'v2-boot-url-reference-conflict', null, conflictUrl),
  ],
  [
    repositoryUrlFactKey(missingFactUrl),
    urlFact('blocked', 'v2-boot-url-fact-missing', 'missing', missingFactUrl),
  ],
]
const urls: LookupReader<RepositoryUrlFact> = {
  get: (key) => urlFacts.find(([entry]) => entry === key)?.[1],
  require: (key) => urlFacts.find(([entry]) => entry === key)![1],
  sourceStatus: () => undefined,
  entries: () => urlFacts.values(),
  version: { id: 'boot/repository-urls', version: 2, digest: valueDigest(urlFacts) },
}

test('an unreadable repository address links by URL hash only when the caller asks for it', () => {
  const payload = JSON.stringify({ repoUrl: unreadableUrl, ref: 'main' })
  const base = { payload, enabled: true, lastError: null, urls, git: new Map() }
  // Operator resolution: the blocked URL fact still fails the payload.
  expect(() => healFrozenScheduledPayload(base)).toThrow('v2-boot-url-key-missing')
  const linked = healFrozenScheduledPayload({ ...base, linkUnreadable: true })
  expect(JSON.parse(linked.payload)).toEqual({ cachedRepoId: 'cache', ref: 'main' })
  expect(linked).toMatchObject({
    disableError: null,
    reason: 'v2-boot-schedule-healed',
    factIds: ['repository-url:cache'],
  })
  // Nothing to link to, or a fact that contradicts the source: still an error.
  for (const [url, reason] of [
    [conflictUrl, 'v2-boot-url-reference-conflict'],
    [missingFactUrl, 'v2-boot-url-fact-missing'],
  ] as const)
    expect(() =>
      healFrozenScheduledPayload({
        ...base,
        payload: JSON.stringify({ repoUrl: url }),
        linkUnreadable: true,
      }),
    ).toThrow(reason)
})

const rootless: LocalGitFact = {
  path: '/rootless',
  ref: null,
  state: 'present',
  realRoot: null,
  fileUrl: null,
  bare: false,
  branchOid: null,
  tagOid: null,
  remoteOid: null,
  resolvedOid: null,
  remoteOnly: false,
}
const gitFacts = createBootUpgradeFacts([
  {
    id: scheduleGitFactId(rootless.path, rootless.ref),
    kind: 'local-git',
    material: scheduleGitMaterial(rootless),
    evidence: { ...rootless },
  },
])
const disabledCases = [
  { id: 'json', payload: '{', cause: 'v2-boot-schedule-payload-invalid' },
  { id: 'not-object', payload: '[]', cause: 'v2-boot-schedule-payload-invalid' },
  { id: 'repos', payload: '{"repos":{}}', cause: 'v2-boot-schedule-repos-invalid' },
  { id: 'path-type', payload: '{"repoPath":7}', cause: 'v2-boot-schedule-path-invalid' },
  {
    id: 'path-conflict',
    payload: '{"repoPath":"/a","localRepoPath":"/b"}',
    cause: 'v2-boot-schedule-path-conflict',
  },
  { id: 'url-type', payload: '{"repoUrl":7}', cause: 'v2-boot-schedule-repoUrl-invalid' },
  { id: 'fetch', payload: '{"fetchBeforeLaunch":"yes"}', cause: 'v2-boot-schedule-fetch-invalid' },
  {
    id: 'git',
    payload: '{"repoPath":"/unprobed"}',
    cause: 'v2-boot-schedule-git-unavailable',
    lastError: 'rfc165-local-path-retired: /unprobed',
  },
  {
    id: 'root',
    payload: '{"repoPath":"/rootless"}',
    cause: 'v2-boot-schedule-root-unproven',
    lastError: 'rfc165-local-path-retired: /rootless',
  },
  {
    id: 'conflict',
    payload: JSON.stringify({ repoUrl: conflictUrl }),
    cause: 'v2-boot-url-reference-conflict',
  },
] as const
const decisions = (sink: V2MemorySink, code: string) =>
  [...sink.units.values()]
    .flatMap((unit) => unit.records)
    .filter(
      (record): record is Extract<MigrationRecord, { kind: 'decision' }> =>
        record.kind === 'decision' && record.code === code,
    )

describeV2Providers('RFC-626 schedules kept disabled', (h) => {
  test('automatic keeps every unhealable schedule disabled; operator blocks it', async () => {
    await h.install()
    await h.write('scheduled_tasks', [
      ...disabledCases.map((entry) =>
        frozenValues('scheduled_tasks', {
          id: entry.id,
          enabled: true,
          last_error: null,
          next_run_at: 999,
          updated_at: 7,
          launch_payload: entry.payload,
        }),
      ),
      frozenValues('scheduled_tasks', {
        id: 'linked',
        enabled: true,
        last_error: null,
        next_run_at: 999,
        updated_at: 7,
        launch_payload: JSON.stringify({ repoUrl: unreadableUrl }),
      }),
    ])
    const input = await h.input([
      conversion,
      { rules: [], validators: [], lookups: [fixtureLookup(repositoryUrlFacts, urlFacts)] },
    ])
    try {
      const originals = (await input.source.readChunk('scheduled_tasks', null, 100)).decodedRows
      const sink = new V2MemorySink()
      const summary = await runConversion(
        { ...input, bootUpgradeFacts: gitFacts, resolution: 'automatic' },
        sink,
      )
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      const rows = sink.rows('scheduled_tasks')
      const kept = decisions(sink, SCHEDULE_KEPT_DISABLED_INVALID)
      expect(kept).toHaveLength(disabledCases.length)
      for (const entry of disabledCases) {
        const original = originals.find((row) => row.id === entry.id)!
        const row = rows.find((candidate) => candidate.id === entry.id)!
        expect(row).toBeDefined()
        // The payload is carried over byte for byte; only the three columns and the time move.
        expect(row.launch_payload).toBe(original.launch_payload!)
        expect(row.enabled).toBe(false)
        expect(row.next_run_at).toBeNull()
        expect(row.updated_at).toBe(input.planTime)
        if ('lastError' in entry) expect(row.last_error).toBe(entry.lastError)
        else expect(String(row.last_error)).toStartWith(`${entry.cause}: `)
        expect(row.name).toBe(original.name!)
        const sourceKey = encodeMigrationKey('scheduled_tasks', [canonicalValue(entry.id)])
        const decision = kept.find(
          (record) => (record.payload as { sourceKey?: string }).sourceKey === sourceKey,
        )!
        expect(decision).toBeDefined()
        expect(decision.payload).toMatchObject({
          cause: entry.cause,
          ...('lastError' in entry ? { path: entry.lastError.split(': ')[1] } : {}),
        })
        // The original row is archived with the change, as for any other healed schedule.
        expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toContainEqual(
          expect.objectContaining({
            sourceKey,
            kind: 'conflict-resolved',
            decision: expect.objectContaining({ code: SCHEDULE_KEPT_DISABLED_INVALID }),
          }),
        )
      }
      for (const record of kept)
        expect(record.payload).toMatchObject({
          automatic: 'kept',
          sourceTable: 'scheduled_tasks',
          original: { enabled: true, nextRunAt: 999, lastError: null },
        })
      // A repository whose address is unreadable is linked by hash and the schedule stays on.
      expect(rows.find((row) => row.id === 'linked')).toMatchObject({
        launch_payload: JSON.stringify({ cachedRepoId: 'cache' }),
        enabled: true,
        next_run_at: 999,
        last_error: null,
      })
      expect(
        summary.tableReceipts.find((receipt) => receipt.sourceTable === 'scheduled_tasks')!.counts,
      ).toMatchObject({ archived: 0, blocked: 0 })

      // Operator resolution: each of these rows still blocks; the linked one still blocks too.
      const manualSink = new V2MemorySink()
      const manual = await runConversion({ ...input, bootUpgradeFacts: gitFacts }, manualSink)
      expect(manual.status).toBe('blocked')
      expect(manual.blocks.map((block) => block.code).sort()).toEqual(
        [...disabledCases.map((entry) => entry.cause), 'v2-boot-url-key-missing'].sort(),
      )
      expect(manualSink.rows('scheduled_tasks')).toEqual([])
      expect(decisions(manualSink, SCHEDULE_KEPT_DISABLED_INVALID)).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)

  test('a contradicted URL fact ends the automatic upgrade instead of disabling the schedule', async () => {
    await h.install()
    await h.write('scheduled_tasks', [
      frozenValues('scheduled_tasks', {
        id: 'missing-fact',
        enabled: true,
        launch_payload: JSON.stringify({ repoUrl: missingFactUrl }),
      }),
    ])
    const input = await h.input([
      conversion,
      { rules: [], validators: [], lookups: [fixtureLookup(repositoryUrlFacts, urlFacts)] },
    ])
    try {
      await expect(
        runConversion({ ...input, resolution: 'automatic' }, new V2MemorySink()),
      ).rejects.toThrow('v2-boot-url-fact-missing')
      const manual = await runConversion(input, new V2MemorySink())
      expect(manual.blocks.map((block) => block.code)).toEqual(['v2-boot-url-fact-missing'])
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
