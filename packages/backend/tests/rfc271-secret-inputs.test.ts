// RFC-271 import credential regression lock.
//
// Secret values are applied only at commit time. These tests keep that conversion a pure,
// manifest-fenced operation and prove that an omitted credential cannot persist the package's
// `<REDACTED:SECRET>` marker as if it were a real credential.

import { describe, expect, test } from 'bun:test'
import {
  BundleSchema,
  BUNDLE_VERSION,
  PACKAGE_SECRET_PLACEHOLDER,
  type PackageSecretRef,
  type ResourceBundle,
} from '@agent-workflow/shared'
import { DomainError } from '../src/util/errors'
import {
  applyPackageSecretInputs,
  type PackageSecretInput,
} from '../src/services/resourcePackage/secretInputs'

const secret = (resourceType: string, resourceName: string, field: string): PackageSecretRef => ({
  resourceType,
  resourceName,
  field,
})

const input = (ref: PackageSecretRef, value: string): PackageSecretInput => ({ ...ref, value })

const bundleOf = (ops: ResourceBundle['ops']): ResourceBundle =>
  BundleSchema.parse({
    bundleVersion: BUNDLE_VERSION,
    ops,
    rootRef: `local:${'slug' in ops[0]! ? ops[0]!.slug : 'root'}`,
  })

const payloadOf = <T>(bundle: ResourceBundle, index: number): T =>
  bundle.ops[index]!.payload as unknown as T

const errorCode = (fn: () => unknown): string => {
  try {
    fn()
    return '<none>'
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    return (error as DomainError).code
  }
}

describe('RFC-271 package secret inputs', () => {
  test('replaces declared object paths and leaves the parsed bundle unchanged', () => {
    const envRef = secret('mcp', 'tools', 'config.env.GITHUB_TOKEN')
    const oauthRef = secret('mcp', 'remote-tools', 'config.oauth.clientSecret')
    const bundle = bundleOf([
      {
        opId: 'op-1',
        kind: 'mcp-create',
        slug: 'mcp-tools',
        payload: {
          name: 'tools',
          description: '',
          type: 'local',
          enabled: true,
          config: {
            command: ['tool-server'],
            env: { GITHUB_TOKEN: PACKAGE_SECRET_PLACEHOLDER, MODE: 'safe' },
          },
        },
      },
      {
        opId: 'op-2',
        kind: 'mcp-create',
        slug: 'mcp-remote-tools',
        payload: {
          name: 'remote-tools',
          description: '',
          type: 'remote',
          enabled: true,
          config: {
            url: 'https://mcp.example.test',
            oauth: { clientId: 'client', clientSecret: PACKAGE_SECRET_PLACEHOLDER },
          },
        },
      },
    ])
    const before = structuredClone(bundle)

    const result = applyPackageSecretInputs(
      bundle,
      [envRef, oauthRef],
      [input(envRef, 'github-secret'), input(oauthRef, 'oauth-secret')],
    )
    const localConfig = payloadOf<{
      config: { env: Record<string, string> }
    }>(result.bundle, 0).config
    const remoteConfig = payloadOf<{
      config: { oauth: Record<string, string> }
    }>(result.bundle, 1).config

    expect(localConfig.env).toEqual({ GITHUB_TOKEN: 'github-secret', MODE: 'safe' })
    expect(remoteConfig.oauth).toEqual({ clientId: 'client', clientSecret: 'oauth-secret' })
    expect(result.skippedRefs).toEqual([])
    expect(bundle).toEqual(before)
    expect(BundleSchema.safeParse(result.bundle).success).toBe(true)
  })

  test('projects a manifest ref onto a renamed resource and ignores reused resource inputs', () => {
    const renamedRef = secret('mcp', 'tools', 'config.env.TOKEN')
    const reusedRef = secret('mcp', 'reused', 'config.env.TOKEN')
    const translated = bundleOf([
      {
        opId: 'op-1',
        kind: 'mcp-create',
        slug: 'mcp-tools',
        payload: {
          name: 'tools-copy',
          description: '',
          type: 'local',
          enabled: true,
          config: {
            command: ['tool-server'],
            env: { TOKEN: PACKAGE_SECRET_PLACEHOLDER },
          },
        },
      },
    ])

    const result = applyPackageSecretInputs(
      translated,
      [renamedRef, reusedRef],
      [input(renamedRef, 'renamed-secret'), input(reusedRef, 'ignored-secret')],
      [
        {
          source: renamedRef,
          target: secret('mcp', 'tools-copy', 'config.env.TOKEN'),
        },
      ],
    )

    expect(
      payloadOf<{ config: { env: Record<string, string> } }>(result.bundle, 0).config.env,
    ).toEqual({ TOKEN: 'renamed-secret' })
    expect(result.skippedRefs).toEqual([])
  })

  test('preserves --token= argv shape, removes an empty argv slot, and reports the skip', () => {
    const inlineRef = secret('mcp', 'local-tools', 'config.command[1]')
    const bareRef = secret('mcp', 'local-tools', 'config.command[2]')
    const bundle = bundleOf([
      {
        opId: 'op-1',
        kind: 'mcp-create',
        slug: 'mcp-local-tools',
        payload: {
          name: 'local-tools',
          description: '',
          type: 'local',
          enabled: true,
          config: {
            command: [
              'tool-server',
              `--token=${PACKAGE_SECRET_PLACEHOLDER}`,
              PACKAGE_SECRET_PLACEHOLDER,
              '--verbose',
            ],
          },
        },
      },
    ])

    const result = applyPackageSecretInputs(
      bundle,
      [inlineRef, bareRef],
      [input(inlineRef, 'cli-secret'), input(bareRef, '')],
    )

    expect(payloadOf<{ config: { command: string[] } }>(result.bundle, 0).config.command).toEqual([
      'tool-server',
      '--token=cli-secret',
      '--verbose',
    ])
    expect(result.skippedRefs).toEqual([bareRef])
    expect(JSON.stringify(result.bundle)).not.toContain(PACKAGE_SECRET_PLACEHOLDER)
  })

  test('treats MCP URL and plugin spec as whole-field credential inputs', () => {
    const urlRef = secret('mcp', 'remote-tools', 'config.url')
    const specRef = secret('plugin', 'review-plugin', 'spec')
    const bundle = bundleOf([
      {
        opId: 'op-1',
        kind: 'mcp-create',
        slug: 'mcp-remote-tools',
        payload: {
          name: 'remote-tools',
          description: '',
          type: 'remote',
          enabled: true,
          config: {
            url: 'https://mcp.example.test/?token=%3CREDACTED%3ASECRET%3E',
          },
        },
      },
      {
        opId: 'op-2',
        kind: 'plugin-create',
        slug: 'plugin-review-plugin',
        payload: {
          name: 'review-plugin',
          description: '',
          spec: 'https://git.example.test/review.git?token=%3CREDACTED%3ASECRET%3E',
          options: {},
          enabled: true,
          sourceKind: 'git',
        },
      },
    ])

    const result = applyPackageSecretInputs(
      bundle,
      [urlRef, specRef],
      [
        input(urlRef, 'https://mcp.example.test/?token=remote-secret'),
        input(specRef, 'https://git.example.test/review.git?token=git-secret'),
      ],
    )

    expect(payloadOf<{ config: { url: string } }>(result.bundle, 0).config.url).toBe(
      'https://mcp.example.test/?token=remote-secret',
    )
    expect(payloadOf<{ spec: string }>(result.bundle, 1).spec).toBe(
      'https://git.example.test/review.git?token=git-secret',
    )
    expect(BundleSchema.safeParse(result.bundle).success).toBe(true)
  })

  test('resolves workflow node env refs by node id and deletes skipped values', () => {
    const tokenRef = secret('workflow', 'deploy', 'nodes.publish.env.DEPLOY_TOKEN')
    const optionalRef = secret('workflow', 'deploy', 'nodes.publish.env.OPTIONAL_SECRET')
    const bundle = bundleOf([
      {
        opId: 'op-1',
        kind: 'workflow-create',
        slug: 'workflow-deploy',
        payload: {
          name: 'deploy',
          description: '',
          definition: {
            $schema_version: 4,
            inputs: [],
            edges: [],
            nodes: [
              {
                id: 'publish',
                kind: 'script',
                language: 'bash',
                env: {
                  DEPLOY_TOKEN: PACKAGE_SECRET_PLACEHOLDER,
                  OPTIONAL_SECRET: PACKAGE_SECRET_PLACEHOLDER,
                  MODE: 'release',
                },
              },
              { id: 'other', kind: 'script', env: { MODE: 'test' } },
            ],
          },
        },
      },
    ])

    const result = applyPackageSecretInputs(
      bundle,
      [tokenRef, optionalRef],
      [input(tokenRef, 'deploy-secret'), input(optionalRef, '')],
    )
    const nodes = payloadOf<{
      definition: { nodes: Array<{ env: Record<string, string> }> }
    }>(result.bundle, 0).definition.nodes

    expect(nodes[0]!.env).toEqual({ DEPLOY_TOKEN: 'deploy-secret', MODE: 'release' })
    expect(nodes[1]!.env).toEqual({ MODE: 'test' })
    expect(result.skippedRefs).toEqual([optionalRef])
  })

  test('missing input is a safe skip, not a literal placeholder write', () => {
    const ref = secret('agent', 'auditor', 'frontmatterExtra.API_TOKEN')
    const bundle = bundleOf([
      {
        opId: 'op-1',
        kind: 'agent-create',
        slug: 'agent-auditor',
        payload: {
          name: 'auditor',
          description: '',
          outputs: [],
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn: [],
          mcp: [],
          plugins: [],
          frontmatterExtra: { API_TOKEN: PACKAGE_SECRET_PLACEHOLDER, MODE: 'strict' },
          bodyMd: '',
        },
      },
    ])

    const result = applyPackageSecretInputs(bundle, [ref], [])

    expect(
      payloadOf<{ frontmatterExtra: Record<string, unknown> }>(result.bundle, 0).frontmatterExtra,
    ).toEqual({
      MODE: 'strict',
    })
    expect(result.skippedRefs).toEqual([ref])
  })

  test('rejects extra inputs, duplicate inputs, and duplicate manifest declarations', () => {
    const declared = secret('agent', 'auditor', 'frontmatterExtra.API_TOKEN')
    const extra = secret('agent', 'auditor', 'frontmatterExtra.OTHER_TOKEN')
    const bundle = bundleOf([
      {
        opId: 'op-1',
        kind: 'agent-create',
        slug: 'agent-auditor',
        payload: {
          name: 'auditor',
          description: '',
          outputs: [],
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn: [],
          mcp: [],
          plugins: [],
          frontmatterExtra: { API_TOKEN: PACKAGE_SECRET_PLACEHOLDER },
          bodyMd: '',
        },
      },
    ])

    expect(errorCode(() => applyPackageSecretInputs(bundle, [declared], [input(extra, 'x')]))).toBe(
      'package-secret-input-unconfirmed',
    )
    expect(
      errorCode(() =>
        applyPackageSecretInputs(
          bundle,
          [declared],
          [input(declared, 'first'), input(declared, 'second')],
        ),
      ),
    ).toBe('package-secret-input-invalid')
    expect(
      errorCode(() =>
        applyPackageSecretInputs(bundle, [declared, declared], [input(declared, 'x')]),
      ),
    ).toBe('package-secret-manifest-invalid')
  })

  test('rejects manifest-declared arbitrary fields and undeclared placeholders in the bundle', () => {
    const arbitrary = secret('agent', 'auditor', 'name')
    const bundle = bundleOf([
      {
        opId: 'op-1',
        kind: 'agent-create',
        slug: 'agent-auditor',
        payload: {
          name: 'auditor',
          description: PACKAGE_SECRET_PLACEHOLDER,
          outputs: [],
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn: [],
          mcp: [],
          plugins: [],
          frontmatterExtra: {},
          bodyMd: '',
        },
      },
    ])

    expect(
      errorCode(() => applyPackageSecretInputs(bundle, [arbitrary], [input(arbitrary, 'x')])),
    ).toBe('package-secret-manifest-invalid')
    expect(errorCode(() => applyPackageSecretInputs(bundle, [], []))).toBe(
      'package-secret-placeholder-remains',
    )
  })

  test('does not let a hand-built manifest widen serializer secret carriers', () => {
    const executableRef = secret('mcp', 'local-tools', 'config.command[0]')
    const clientIdRef = secret('mcp', 'remote-tools', 'config.oauth.clientId')
    const bundle = bundleOf([
      {
        opId: 'op-1',
        kind: 'mcp-create',
        slug: 'mcp-local-tools',
        payload: {
          name: 'local-tools',
          description: '',
          type: 'local',
          enabled: true,
          config: { command: [PACKAGE_SECRET_PLACEHOLDER] },
        },
      },
      {
        opId: 'op-2',
        kind: 'mcp-create',
        slug: 'mcp-remote-tools',
        payload: {
          name: 'remote-tools',
          description: '',
          type: 'remote',
          enabled: true,
          config: {
            url: 'https://mcp.example.test',
            oauth: { clientId: PACKAGE_SECRET_PLACEHOLDER },
          },
        },
      },
    ])

    expect(
      errorCode(() =>
        applyPackageSecretInputs(bundle, [executableRef], [input(executableRef, 'other-bin')]),
      ),
    ).toBe('package-secret-manifest-invalid')
    expect(
      errorCode(() =>
        applyPackageSecretInputs(bundle, [clientIdRef], [input(clientIdRef, 'other-client')]),
      ),
    ).toBe('package-secret-manifest-invalid')
  })

  test('fails closed when a required whole field is skipped', () => {
    const urlRef = secret('mcp', 'remote-tools', 'config.url')
    const bundle = bundleOf([
      {
        opId: 'op-1',
        kind: 'mcp-create',
        slug: 'mcp-remote-tools',
        payload: {
          name: 'remote-tools',
          description: '',
          type: 'remote',
          enabled: true,
          config: { url: 'https://mcp.example.test/?token=%3CREDACTED%3ASECRET%3E' },
        },
      },
    ])

    let caught: DomainError | undefined
    try {
      applyPackageSecretInputs(bundle, [urlRef], [input(urlRef, '')])
    } catch (error) {
      caught = error as DomainError
    }

    expect(caught?.code).toBe('package-secret-input-required')
    expect(caught?.details).toMatchObject({ skippedRefs: [urlRef] })
    expect(payloadOf<{ config: { url: string } }>(bundle, 0).config.url).toContain(
      '%3CREDACTED%3ASECRET%3E',
    )
  })
})
