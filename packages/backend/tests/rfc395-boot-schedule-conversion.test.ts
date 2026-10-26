// RFC-395 U-4: preserve old launch precedence and approve each disable from captured Git facts.
import { expect, test } from 'bun:test'
import {
  healFrozenScheduledPayload,
  scheduleGitFactId,
  scheduledPayloadEnvironment,
  conversion,
  scheduleGitMaterial,
} from '@/modules/integration/infrastructure/migration/scheduledPayloadRule'
import {
  repositoryUrlFactKey,
  repositoryCacheFactKey,
  type RepositoryUrlFact,
  createBootUpgradeFacts,
  repositoryUrlFacts,
  bootUpgradeEffectsFromRecords,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type { LookupReader } from '@/platform/persistence/migration/conversion/lookups'
import {
  probeLocalGit,
  type BootUpgradeCaptureInput,
  type LocalGitFact,
} from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { describeV2Providers, emptyV2Content, fixtureLookup } from './helpers/rfc395V2Harness'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const url = 'https://example.test/source.git'
const values = new Map<string, RepositoryUrlFact>([
  [
    repositoryUrlFactKey(url),
    {
      state: 'proven',
      cachedRepoId: 'cache',
      repoUrl: url,
      rawUrlDigest: valueDigest(url),
      reason: null,
      factIds: ['url-proof'],
    },
  ],
  [
    repositoryCacheFactKey('cache'),
    {
      state: 'proven',
      cachedRepoId: 'cache',
      repoUrl: url,
      rawUrlDigest: null,
      reason: null,
      factIds: ['url-proof'],
    },
  ],
])
const urls: LookupReader<RepositoryUrlFact> = {
  get: (key) => values.get(key),
  require: (key) => values.get(key)!,
  sourceStatus: () => undefined,
  entries: () => values.entries(),
  version: { id: 'boot/repository-urls', version: 1, digest: valueDigest([...values]) },
}
const local: LocalGitFact = {
  path: '/local/source',
  ref: 'origin/topic',
  state: 'present',
  realRoot: '/local/root',
  fileUrl: 'file:///local/root',
  bare: false,
  branchOid: 'a'.repeat(40),
  tagOid: null,
  remoteOid: 'b'.repeat(40),
  resolvedOid: 'a'.repeat(40),
  remoteOnly: false,
}
function heal(
  payload: string,
  options: { enabled?: boolean; lastError?: string; fact?: LocalGitFact } = {},
) {
  const fact = options.fact ?? local
  return healFrozenScheduledPayload({
    payload,
    enabled: options.enabled ?? true,
    lastError: options.lastError ?? null,
    urls,
    git: new Map([[scheduleGitFactId(fact.path, fact.ref), fact]]),
  })
}
test('unchanged payload keeps original JSON bytes and current launchKind', () => {
  const raw = ' { "launchKind" : "task", "name" : "current" }\r\n'
  expect(heal(raw).payload).toBe(raw)
})
test.each([
  [{ fetchBeforeLaunch: true }, 'rfc165-fetch-semantic-review'],
  [{ repos: [{}, {}] }, 'rfc248-multi-repo-retired'],
] as const)('disabled schedule records %s', (payload, reason) => {
  const result = heal(JSON.stringify(payload))
  expect(result.disableError).toStartWith(reason)
  expect(result.payload).toBe(JSON.stringify(payload))
})
test.each(['absent', 'not-repository', 'unavailable'] as const)(
  'local observation %s is not guessed',
  (state) => {
    const payload = JSON.stringify({ repoPath: local.path, baseBranch: local.ref })
    const act = () => heal(payload, { fact: { ...local, state } })
    if (state === 'unavailable') expect(act).toThrow('git-unavailable')
    else expect(act().disableError).toStartWith('rfc165-local-path-retired')
  },
)
test('local origin branch and tag stay local; remote-only is disabled', () => {
  const raw = JSON.stringify({ repoPath: local.path, baseBranch: local.ref })
  for (const fact of [local, { ...local, branchOid: null, tagOid: 'c'.repeat(40) }])
    expect(JSON.parse(heal(raw, { fact }).payload)).toEqual({
      repoUrl: 'file:///local/root',
      ref: 'origin/topic',
    })
  expect(
    heal(raw, { fact: { ...local, branchOid: null, remoteOnly: true } }).disableError,
  ).toStartWith('rfc165-remote-tracking-ref')
})
test('URL linkage precedes flattening, with top-level field precedence', () => {
  const result = heal(
    JSON.stringify({
      repoUrl: url,
      ref: 'top',
      repos: [{ repoUrl: url, ref: 'nested' }],
      gitUserName: 'old',
    }),
  )
  expect(JSON.parse(result.payload)).toEqual({ cachedRepoId: 'cache', ref: 'top' })
  expect(result.factIds).toContain('url-proof')
  expect(result.changes).toContain('keep top-level ref')
})
test('retired local path alias, stray fields and empty repos heal without enabling disabled rows', () => {
  expect(
    JSON.parse(heal(JSON.stringify({ localRepoPath: local.path, baseBranch: local.ref })).payload),
  ).toEqual({ repoUrl: local.fileUrl, ref: local.ref })
  expect(
    JSON.parse(heal('{"baseBranch":"old","fetchBeforeLaunch":false,"repos":[]}').payload),
  ).toEqual({})
  const raw = '{"repoPath":"/gone","fetchBeforeLaunch":true}'
  expect(
    heal(raw, { enabled: false, lastError: 'rfc165-local-path-retired: /gone' }),
  ).toMatchObject({ payload: raw, disableError: null, reason: 'v2-boot-schedule-kept-disabled' })
})
test.each(['{', 'null', '[]', '{"repos":{}}', '{"repoPath":7}', '{"fetchBeforeLaunch":"yes"}'])(
  'invalid bytes/fields block: %s',
  (raw) => {
    expect(() => heal(raw)).toThrow()
  },
)

test('unresolved and unborn refs heal, and a nested-only path consumes no top-level baseBranch', () => {
  expect(
    JSON.parse(
      heal(JSON.stringify({ repoPath: local.path, baseBranch: local.ref }), {
        fact: { ...local, resolvedOid: null },
      }).payload,
    ),
  ).toEqual({ repoUrl: local.fileUrl, ref: local.ref })
  expect(
    JSON.parse(
      heal(
        JSON.stringify({
          baseBranch: 'unused',
          repos: [{ repoPath: local.path, baseBranch: local.ref }],
        }),
      ).payload,
    ),
  ).toEqual({ repoUrl: local.fileUrl, ref: local.ref })
  expect(
    scheduleGitMaterial({ ...local, branchOid: 'x', remoteOid: 'y', resolvedOid: 'z' }),
  ).toEqual(scheduleGitMaterial(local))
})

const execGit = promisify(execFile)
async function gitAt(path: string, ...args: string[]) {
  return execGit('git', ['-C', path, ...args], { env: { ...process.env, LC_ALL: 'C' } })
}
test('real Git probes distinguish absent, files, non-repositories, bare roots, subdirectories and local origin branches/tags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boot-git-'))
  try {
    const repo = join(root, 'work'),
      bare = join(root, 'bare.git'),
      file = join(root, 'file')
    await mkdir(repo)
    await writeFile(file, 'regular file')
    expect((await probeLocalGit(join(root, 'missing'), null)).state).toBe('absent')
    expect((await probeLocalGit(root, null)).state).toBe('not-repository')
    expect((await probeLocalGit(file, null)).state).toBe('not-repository')
    expect((await probeLocalGit(join(file, 'child'), null)).state).toBe('not-repository')
    await gitAt(repo, 'init', '--initial-branch=main')
    const unborn = await probeLocalGit(repo, null)
    expect(unborn).toMatchObject({ state: 'present', resolvedOid: null, remoteOnly: false })
    expect(
      JSON.parse(heal('{"repoPath":' + JSON.stringify(repo) + '}', { fact: unborn }).payload),
    ).toEqual({ repoUrl: pathToFileURL(await realpath(repo)).href })
    await gitAt(
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    )
    await mkdir(join(repo, 'nested'))
    const sub = await probeLocalGit(join(repo, 'nested'), 'deleted-feature')
    expect(sub).toMatchObject({
      state: 'present',
      realRoot: await realpath(repo),
      resolvedOid: null,
      fileUrl: pathToFileURL(await realpath(repo)).href,
    })
    await gitAt(repo, 'branch', 'origin/local-branch')
    await gitAt(repo, 'tag', 'origin/local-tag')
    await gitAt(repo, 'update-ref', 'refs/remotes/origin/remote-only', 'HEAD')
    expect(await probeLocalGit(repo, 'origin/local-branch')).toMatchObject({
      remoteOnly: false,
      branchOid: expect.any(String),
    })
    expect(await probeLocalGit(repo, 'origin/local-tag')).toMatchObject({
      remoteOnly: false,
      tagOid: expect.any(String),
    })
    expect(await probeLocalGit(repo, 'origin/remote-only')).toMatchObject({
      remoteOnly: true,
      branchOid: null,
      tagOid: null,
      remoteOid: expect.any(String),
    })
    const first = await probeLocalGit(repo, 'main')
    await gitAt(
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'next',
    )
    const second = await probeLocalGit(repo, 'main')
    expect(second.resolvedOid).not.toBe(first.resolvedOid)
    expect(scheduleGitMaterial(second)).toEqual(scheduleGitMaterial(first))
    await gitAt(root, 'init', '--bare', bare)
    expect(await probeLocalGit(bare, null)).toMatchObject({
      state: 'present',
      bare: true,
      realRoot: await realpath(bare),
      fileUrl: pathToFileURL(await realpath(bare)).href,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

describeV2Providers('RFC-395 captured schedule facts and target rows', (h) => {
  test('captured facts drive copied, healed, disabled and blocked targets with complete effect evidence', async () => {
    await h.install()
    const current = ' { "launchKind" : "task" }\r\n'
    const cases = [
      { id: 'current', launch_payload: current },
      {
        id: 'heal',
        launch_payload: JSON.stringify({
          baseBranch: 'unused',
          repos: [{ repoPath: '/present', baseBranch: 'gone' }],
        }),
      },
      { id: 'absent', launch_payload: '{"repoPath":"/absent"}' },
      { id: 'blocked', launch_payload: '{"repoPath":"/unavailable"}' },
      {
        id: 'disabled165',
        enabled: false,
        last_error: 'rfc165-local-path-retired: /kept',
        launch_payload: '{"repoPath":"/kept165"}',
      },
      {
        id: 'disabled248',
        enabled: false,
        last_error: 'rfc248-multi-repo-retired: old',
        launch_payload: '{"repoPath":"/kept248"}',
      },
      { id: 'fetch', launch_payload: '{"repoPath":"/unused-fetch","fetchBeforeLaunch":true}' },
      { id: 'multi', launch_payload: '{"repos":[{"repoPath":"/unused-multi"},{}]}' },
    ]
    await h.write(
      'scheduled_tasks',
      cases.map((row) =>
        frozenValues('scheduled_tasks', {
          enabled: true,
          last_error: null,
          next_run_at: 999,
          updated_at: 7,
          ...row,
        }),
      ),
    )
    const input = await h.input([
      conversion,
      { rules: [], validators: [], lookups: [fixtureLookup(repositoryUrlFacts, [])] },
    ])
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
      root: {
        kind: 'app-home',
        root: h.sourceHarness.operationRoot,
        runsSupplied: false,
        objects: 'none',
      },
      content: emptyV2Content,
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
    const probed: string[] = []
    let oid = 'first'
    const environment = scheduledPayloadEnvironment(async (path, ref) => {
      probed.push(path)
      return {
        ...local,
        path,
        ref,
        realRoot: path,
        fileUrl: pathToFileURL(path).href,
        state: path === '/absent' ? 'absent' : path === '/unavailable' ? 'unavailable' : 'present',
        branchOid: oid,
        resolvedOid: null,
      }
    })
    try {
      const facts = createBootUpgradeFacts(await environment.capture(capture))
      expect(probed.sort()).toEqual(['/absent', '/present', '/unavailable'])
      oid = 'second'
      const observations = createBootUpgradeFacts(await environment.capture(capture))
      expect(observations.environmentDigest).toBe(facts.environmentDigest)
      expect(valueDigest(observations)).not.toBe(valueDigest(facts))
      const sink = new V2MemorySink(),
        summary = await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
      const rows = sink.rows('scheduled_tasks')
      expect(rows.find((row) => row.id === 'current')).toMatchObject({
        launch_payload: current,
        enabled: true,
        updated_at: 7,
        next_run_at: 999,
      })
      expect(rows.find((row) => row.id === 'heal')).toMatchObject({
        launch_payload: JSON.stringify({ repoUrl: pathToFileURL('/present').href, ref: 'gone' }),
        enabled: true,
        updated_at: input.planTime,
        next_run_at: 999,
      })
      for (const id of ['absent', 'fetch', 'multi'])
        expect(rows.find((row) => row.id === id)).toMatchObject({
          enabled: false,
          next_run_at: null,
          updated_at: input.planTime,
        })
      expect(rows.find((row) => row.id === 'absent')!.last_error).toBe(
        'rfc165-local-path-retired: /absent',
      )
      for (const id of ['disabled165', 'disabled248'])
        expect(rows.find((row) => row.id === id)).toMatchObject({
          enabled: false,
          next_run_at: 999,
          updated_at: 7,
        })
      expect(rows.some((row) => row.id === 'blocked')).toBe(false)
      const blocked = bootUpgradeEffectsFromRecords(summary.records).find(
        (effect) => effect.disposition === 'blocked',
      )!
      expect(blocked).toMatchObject({
        factIds: [scheduleGitFactId('/unavailable', null)],
        before: { path: '/unavailable', factIds: [scheduleGitFactId('/unavailable', null)] },
      })
      expect(
        summary.blocks.find((block) => block.code === 'v2-boot-schedule-git-unavailable')!.detail,
      ).toMatchObject({ path: '/unavailable' })
      const disabled = bootUpgradeEffectsFromRecords(summary.records).find(
        (effect) => effect.reason === 'rfc165-local-path-retired',
      )!
      expect(disabled.after).toMatchObject({ enabled: false, nextRunCleared: true })
      expect(
        (await input.source.readChunk('scheduled_tasks', null, 100)).decodedRows.find(
          (row) => row.id === 'absent',
        ),
      ).toMatchObject({ enabled: true, next_run_at: 999, updated_at: 7 })
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
