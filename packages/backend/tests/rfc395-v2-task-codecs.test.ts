import { describe, expect, test } from 'bun:test'
import { canonicalJson } from '@agent-workflow/shared'
import { decodeRequestedSource } from '@/platform/persistence/taskRepositorySurface'
import {
  encodeRequestedSource,
  decodeRequestedSourceJson,
  requestedSourceView,
  REQUESTED_SOURCE_CODEC,
  type PersistedRequestedSource,
} from '@/modules/task-execution/domain/requestedSourceCodec'
import {
  encodeWorkgroupLaunchConfig,
  decodeWorkgroupLaunchConfigJson,
} from '@/modules/task-execution/domain/workgroupLaunchConfigCodec'

describe('RFC-395 V2-T persisted codecs', () => {
  test('requestedSource v2 round-trips all request facts with exact stored URL and resolved-ref provenance', () => {
    const source: PersistedRequestedSource = {
      codec: REQUESTED_SOURCE_CODEC,
      kind: 'local',
      kindProvenance: 'epoch1-stored-fields',
      spaceKind: 'local',
      repoPath: 'C:\\source\\仓库',
      repoUrl: 'https://user:password@example.invalid/r.git?q=one',
      cachedRepoId: 'cache',
      repoGroupId: 'group',
      repoGroupName: '',
      requestedRef: { value: 'resolved/ref', provenance: 'resolved-base-branch' },
      legacyBaseCommit: null,
    }
    const bytes = encodeRequestedSource(source)
    expect(bytes).toBe(canonicalJson(source))
    expect(decodeRequestedSourceJson(bytes)).toEqual(source)
    expect(requestedSourceView(source)).toEqual(
      decodeRequestedSource({
        spaceKind: source.spaceKind,
        repoUrl: source.repoUrl,
        cachedRepoId: source.cachedRepoId,
        repoGroupId: source.repoGroupId,
        repoGroupName: source.repoGroupName,
        baseBranch: source.requestedRef.value,
      }),
    )
    expect(requestedSourceView(source).kind).toBe('internal')
    expect(requestedSourceView(source).repoUrl).not.toBe(source.repoUrl)
    expect(decodeRequestedSourceJson(bytes).repoPath).toBe('C:\\source\\仓库')
  })

  test('all representable kinds map to II-a without changing the persisted request', () => {
    for (const kind of [
      'local',
      'internal',
      'inherited',
      'scratch',
      'url',
      'cached-repo',
      'repo-group',
    ] as const) {
      const source: PersistedRequestedSource = {
        codec: REQUESTED_SOURCE_CODEC,
        kind,
        kindProvenance: 'epoch1-stored-fields',
        spaceKind: ['url', 'cached-repo', 'repo-group'].includes(kind)
          ? 'remote'
          : (kind as PersistedRequestedSource['spaceKind']),
        repoPath: '',
        repoUrl: kind === 'url' ? 'git@example.invalid:repo' : null,
        cachedRepoId: kind === 'cached-repo' ? 'cache' : null,
        repoGroupId: kind === 'repo-group' ? 'group' : null,
        repoGroupName: null,
        requestedRef: { value: '', provenance: 'resolved-base-branch' },
        legacyBaseCommit: '',
      }
      expect(decodeRequestedSourceJson(encodeRequestedSource(source))).toEqual(source)
      expect(requestedSourceView(source).kind).toBe(kind === 'local' ? 'internal' : kind)
    }
  })

  test('old in-memory tags, malformed JSON, missing local paths and invented original-ref provenance are rejected', () => {
    for (const value of [
      '{',
      '{"codec":"requestedSource@v1"}',
      '{"codec":"requestedSource@v2","kind":"local"}',
    ])
      expect(() => decodeRequestedSourceJson(value)).toThrow()
    expect(() =>
      decodeRequestedSourceJson(
        JSON.stringify({
          codec: REQUESTED_SOURCE_CODEC,
          kind: 'url',
          requestedRef: { value: 'main', provenance: 'original-request' },
        }),
      ),
    ).toThrow()
  })

  test('workgroup launch codec selects only original five values and has stable canonical bytes', () => {
    const launch = {
      workgroupId: 'id',
      workgroupName: 'name',
      mode: 'free_collab' as const,
      leaderMemberId: null,
      goal: '',
    }
    const encoded = encodeWorkgroupLaunchConfig({
      members: [],
      unknown: 'retain in runtime only',
      ...launch,
    })
    expect(encoded).toBe(canonicalJson(launch))
    expect(decodeWorkgroupLaunchConfigJson(encoded)).toEqual(launch)
    expect(() => decodeWorkgroupLaunchConfigJson('{"mode":"unknown"}')).toThrow()
  })
})
