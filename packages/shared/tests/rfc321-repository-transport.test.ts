// RFC-321 — managed repository transport must fail closed. These cases lock
// the trust boundary before any credential is allowed to reach Git.

import { describe, expect, test } from 'bun:test'
import {
  canonicalRepositoryTransportBinding,
  CodeHostConnectionMutationConfirmationSchema,
  describeRepositoryRemote,
  OwnCodeHostPushCredentialSummarySchema,
  PutOwnCodeHostPushCredentialRequestSchema,
  RepositoryEndpointCandidateSchema,
  RepositoryPublicationReceiptSchema,
  RepositoryTransportMappingV1Schema,
  TestOwnCodeHostPushCredentialRequestSchema,
  resolveManagedRepositoryHttpEndpoint,
} from '../src/index'

const DIGEST = 'a'.repeat(64)

describe('RFC-321 strict wire contracts', () => {
  test('the write-only token request is strict and bounded', () => {
    expect(
      PutOwnCodeHostPushCredentialRequestSchema.parse({
        token: 'personal-token',
        connectionGeneration: '01K321GENERATION',
        endpointBindingDigest: DIGEST,
      }).token,
    ).toBe('personal-token')
    expect(
      PutOwnCodeHostPushCredentialRequestSchema.safeParse({
        token: 'short',
        connectionGeneration: 'g',
        endpointBindingDigest: DIGEST,
      }).success,
    ).toBe(false)
    expect(
      PutOwnCodeHostPushCredentialRequestSchema.safeParse({
        token: 'personal-token',
        connectionGeneration: 'g',
        endpointBindingDigest: DIGEST,
        echoToken: true,
      }).success,
    ).toBe(false)
  })

  test('the personal identity probe accepts either a one-shot draft or the stored-token selector', () => {
    const binding = {
      connectionGeneration: '01K321GENERATION',
      endpointBindingDigest: DIGEST,
    }
    expect(TestOwnCodeHostPushCredentialRequestSchema.parse(binding)).toEqual(binding)
    expect(
      TestOwnCodeHostPushCredentialRequestSchema.parse({
        ...binding,
        token: 'one-shot-personal-token',
      }).token,
    ).toBe('one-shot-personal-token')
    expect(
      TestOwnCodeHostPushCredentialRequestSchema.safeParse({
        ...binding,
        token: 'short',
      }).success,
    ).toBe(false)
    expect(
      TestOwnCodeHostPushCredentialRequestSchema.safeParse({
        ...binding,
        globalFallback: true,
      }).success,
    ).toBe(false)
  })

  test('read/publication contracts have no plaintext token or global hint slot', () => {
    const summary = OwnCodeHostPushCredentialSummarySchema.parse({
      provider: 'gitlab',
      displayBaseUrl: 'https://gitlab.example/api/v4',
      connectionGeneration: 'generation',
      endpointBindingDigest: DIGEST,
      configured: true,
      tokenHint: '1234',
      updatedAt: 1,
      stale: false,
      fallback: 'platform-global',
    })
    expect(Object.keys(summary).sort()).toEqual([
      'configured',
      'connectionGeneration',
      'displayBaseUrl',
      'endpointBindingDigest',
      'fallback',
      'provider',
      'stale',
      'tokenHint',
      'updatedAt',
    ])
    expect(
      OwnCodeHostPushCredentialSummarySchema.safeParse({ ...summary, token: 'secret' }).success,
    ).toBe(false)
    expect(
      RepositoryPublicationReceiptSchema.safeParse({
        credentialSource: 'personal',
        credentialRevision: 2,
        endpointSource: 'provider-api',
        endpointBindingDigest: DIGEST,
        tokenHint: '1234',
      }).success,
    ).toBe(false)
  })

  test('mapping, endpoint candidate, and confirmation reject unknown fields', () => {
    expect(
      RepositoryTransportMappingV1Schema.safeParse({
        sshHost: 'ssh.example',
        httpBaseUrl: 'https://code.example',
        token: 'forbidden',
      }).success,
    ).toBe(false)
    expect(
      RepositoryEndpointCandidateSchema.safeParse({
        provider: 'github',
        project: 'owner/repo',
        connectionGeneration: 'generation',
        url: 'https://github.com/owner/repo.git',
        source: 'provider-api',
        authorization: 'Bearer secret',
      }).success,
    ).toBe(false)
    expect(
      CodeHostConnectionMutationConfirmationSchema.safeParse({
        expectedConnectionGeneration: 'generation',
        unexpected: true,
      }).success,
    ).toBe(false)
  })
})

describe('RFC-321 repository remote descriptor', () => {
  test('normalizes SSH surface forms without merging their provenance into HTTP', () => {
    expect(describeRepositoryRemote('git@GitHub.com:Owner/Repo.git')).toEqual({
      ok: true,
      value: { transport: 'ssh', host: 'github.com', port: null, project: 'Owner/Repo' },
    })
    expect(describeRepositoryRemote('ssh://git@gitlab.example:22/team/repo.git')).toEqual({
      ok: true,
      value: { transport: 'ssh', host: 'gitlab.example', port: null, project: 'team/repo' },
    })
    expect(describeRepositoryRemote('ssh://git@gitlab.example:2222/team/repo.git')).toEqual({
      ok: true,
      value: { transport: 'ssh', host: 'gitlab.example', port: 2222, project: 'team/repo' },
    })
  })

  test('rejects traversal, encoded separators, query, and fragments', () => {
    for (const remote of [
      'git@github.com:owner/../repo.git',
      'git@github.com:owner%2Frepo/project.git',
      'https://github.com/owner/repo.git?token=x',
      'https://github.com/owner/repo.git#fragment',
    ]) {
      expect(describeRepositoryRemote(remote).ok, remote).toBe(false)
    }
  })
})

describe('RFC-321 managed SSH to HTTP(S) resolution', () => {
  test('uses the exact GitHub/GitLab SaaS conventions only', () => {
    expect(
      resolveManagedRepositoryHttpEndpoint({
        remoteUrl: 'git@github.com:owner/repo.git',
        provider: 'github',
        connectionGeneration: 'g1',
        mappings: [],
      }),
    ).toEqual({
      ok: true,
      endpoint: {
        provider: 'github',
        project: 'owner/repo',
        url: 'https://github.com/owner/repo.git',
        source: 'saas-convention',
      },
    })
    expect(
      resolveManagedRepositoryHttpEndpoint({
        remoteUrl: 'git@gitlab.com:group/repo',
        provider: 'gitlab',
        connectionGeneration: 'g1',
        mappings: [],
      }),
    ).toMatchObject({ ok: true, endpoint: { url: 'https://gitlab.com/group/repo.git' } })
    for (const host of ['www.github.com', 'github.com.evil.example', 'xn--github-9za.example']) {
      expect(
        resolveManagedRepositoryHttpEndpoint({
          remoteUrl: `git@${host}:owner/repo.git`,
          provider: 'github',
          connectionGeneration: 'g1',
          mappings: [],
        }),
      ).toMatchObject({ ok: false, code: 'repository-http-endpoint-unresolved' })
    }
  })

  test('provider candidate wins, but an untrusted candidate never falls through', () => {
    const common = {
      remoteUrl: 'git@ssh.company.test:team/app.git',
      provider: 'gitlab' as const,
      connectionGeneration: 'g1',
      mappings: [
        {
          sshHost: 'ssh.company.test',
          sshPathPrefix: 'team',
          httpBaseUrl: 'https://code.company.test/git/team',
        },
      ],
      allowedHttpBaseUrls: ['https://code.company.test/git'],
    }
    expect(
      resolveManagedRepositoryHttpEndpoint({
        ...common,
        apiCandidate: {
          provider: 'gitlab',
          project: 'team/app',
          connectionGeneration: 'g1',
          url: 'https://code.company.test/git/team/app.git',
          source: 'provider-api',
        },
      }),
    ).toMatchObject({ ok: true, endpoint: { source: 'provider-api' } })
    expect(
      resolveManagedRepositoryHttpEndpoint({
        ...common,
        apiCandidate: {
          provider: 'gitlab',
          project: 'team/app',
          connectionGeneration: 'g1',
          url: 'https://evil.example/team/app.git',
          source: 'provider-api',
        },
      }),
    ).toEqual({
      ok: false,
      code: 'repository-http-endpoint-untrusted',
      issue: 'provider-candidate-endpoint-untrusted',
    })
  })

  test('provider HTTP metadata needs an explicit mapping for the exact cleartext base', () => {
    const base = {
      remoteUrl: 'git@ssh.company.test:team/app.git',
      provider: 'gitlab' as const,
      connectionGeneration: 'g1',
      allowedHttpBaseUrls: ['http://code.company.test'],
      apiCandidate: {
        provider: 'gitlab' as const,
        project: 'team/app',
        connectionGeneration: 'g1',
        url: 'http://code.company.test/team/app.git',
        source: 'provider-api' as const,
      },
    }
    expect(resolveManagedRepositoryHttpEndpoint({ ...base, mappings: [] })).toMatchObject({
      ok: false,
      code: 'repository-http-endpoint-untrusted',
    })
    expect(
      resolveManagedRepositoryHttpEndpoint({
        ...base,
        mappings: [
          {
            sshHost: 'ssh.company.test',
            httpBaseUrl: 'http://code.company.test',
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      endpoint: { source: 'provider-api', url: 'http://code.company.test/team/app.git' },
    })
    expect(
      resolveManagedRepositoryHttpEndpoint({
        ...base,
        mappings: [
          {
            sshHost: 'ssh.company.test',
            httpBaseUrl: 'http://other.company.test',
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: 'repository-http-endpoint-untrusted' })
  })

  test('mapping uses exact authority and longest path prefix', () => {
    const result = resolveManagedRepositoryHttpEndpoint({
      remoteUrl: 'ssh://git@ssh.example:2222/team/platform/app.git',
      provider: 'gitlab',
      connectionGeneration: 'g1',
      mappings: [
        { sshHost: 'ssh.example', sshPort: 2222, httpBaseUrl: 'https://code.example/all' },
        {
          sshHost: 'ssh.example',
          sshPort: 2222,
          sshPathPrefix: 'team/platform',
          httpBaseUrl: 'https://code.example/git/team/platform',
        },
      ],
    })
    expect(result).toEqual({
      ok: true,
      endpoint: {
        provider: 'gitlab',
        project: 'team/platform/app',
        url: 'https://code.example/git/team/platform/app.git',
        source: 'admin-mapping',
      },
    })
  })

  test('mapping may explicitly rebase an SSH path prefix onto a different HTTP base path', () => {
    expect(
      resolveManagedRepositoryHttpEndpoint({
        remoteUrl: 'ssh://git@ssh.example:2222/platform/team/app.git',
        provider: 'gitlab',
        connectionGeneration: 'g1',
        mappings: [
          {
            sshHost: 'ssh.example',
            sshPort: 2222,
            sshPathPrefix: 'platform',
            httpBaseUrl: 'https://code.example/scm',
          },
        ],
      }),
    ).toEqual({
      ok: true,
      endpoint: {
        provider: 'gitlab',
        project: 'platform/team/app',
        url: 'https://code.example/scm/team/app.git',
        source: 'admin-mapping',
      },
    })
  })

  test('the same SSH target cannot be rebound to two HTTP bases', () => {
    expect(
      resolveManagedRepositoryHttpEndpoint({
        remoteUrl: 'git@ssh.example:team/app.git',
        provider: 'gitlab',
        connectionGeneration: 'g1',
        mappings: [
          {
            sshHost: 'ssh.example',
            sshPathPrefix: 'team',
            httpBaseUrl: 'https://one.example/team',
          },
          {
            sshHost: 'ssh.example',
            sshPathPrefix: 'team',
            httpBaseUrl: 'https://two.example/team',
          },
        ],
      }),
    ).toEqual({
      ok: false,
      code: 'repository-http-endpoint-untrusted',
      issue: 'mapping-1-ssh-target-conflict',
    })
  })

  test('HTTP input drops userinfo and only explicit mapping can admit cleartext HTTP', () => {
    expect(
      resolveManagedRepositoryHttpEndpoint({
        remoteUrl: 'https://user:old-token@code.example/team/app.git',
        provider: 'gitlab',
        connectionGeneration: 'g1',
        mappings: [],
        allowedHttpBaseUrls: ['https://code.example'],
      }),
    ).toMatchObject({
      ok: true,
      endpoint: { url: 'https://code.example/team/app.git', source: 'input-http' },
    })
    expect(
      resolveManagedRepositoryHttpEndpoint({
        remoteUrl: 'http://code.example/team/app.git',
        provider: 'gitlab',
        connectionGeneration: 'g1',
        mappings: [{ sshHost: 'ssh.example', httpBaseUrl: 'http://code.example' }],
        allowedHttpBaseUrls: ['http://code.example'],
      }),
    ).toMatchObject({
      ok: true,
      endpoint: { url: 'http://code.example/team/app.git', source: 'input-http' },
    })
    expect(
      resolveManagedRepositoryHttpEndpoint({
        remoteUrl: 'http://code.example/team/app.git',
        provider: 'gitlab',
        connectionGeneration: 'g1',
        mappings: [{ sshHost: 'ssh.example', httpBaseUrl: 'http://other.example' }],
        allowedHttpBaseUrls: ['http://code.example'],
      }),
    ).toMatchObject({ ok: false, code: 'repository-http-endpoint-untrusted' })
  })
})

describe('RFC-321 endpoint binding canonicalization', () => {
  test('mapping order and default SSH port do not change the canonical binding', () => {
    const base = {
      version: 1 as const,
      provider: 'gitlab' as const,
      connectionGeneration: 'generation',
      apiBaseUrl: 'https://gitlab.example/api/v4/',
      rejectUnauthorized: true,
    }
    const first = canonicalRepositoryTransportBinding({
      ...base,
      transportMappings: [
        { sshHost: 'B.example', sshPathPrefix: 'team', httpBaseUrl: 'https://b.example/' },
        { sshHost: 'a.example', sshPort: 22, httpBaseUrl: 'https://a.example' },
      ],
    })
    const second = canonicalRepositoryTransportBinding({
      ...base,
      transportMappings: [
        { sshHost: 'a.example', httpBaseUrl: 'https://a.example/' },
        { sshHost: 'b.example', sshPathPrefix: 'team', httpBaseUrl: 'https://b.example' },
      ],
    })
    expect(first).toBe(second)
    expect(first).not.toContain('token')
  })
})
