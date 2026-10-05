// RFC-370 H4/H5: the selected compiler projects complete AW declarations to
// native material without returning physical launch fields to neutral callers.
// Existing RFC-282 dual-runtime golden tests exercise this same compatibility
// bridge against the actual native assemblers; these cases cover selection,
// snapshot, content-reader timing and original failure identity.
// The R1 review regressions preserve prototype locators and the native
// persona declaration-error downgrade without pre-consuming its getter.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE, type Agent, type Mcp } from '@agent-workflow/shared'
import type {
  AgentMaterialEvidenceCapabilities,
  AgentMaterialIntent,
} from '../src/modules/runtime-management/application/ports/agentMaterial'
import {
  createLocalAgentMaterialCompiler,
  type NativeAgentMaterialContents,
} from '../src/modules/runtime-management/infrastructure/local/agentMaterialCompiler'
import {
  bindLegacyNativeAgentMaterial,
  compileLegacyNativeAgentMaterial,
} from '../src/modules/runtime-management/infrastructure/local/legacyAgentMaterialBinding'
import type { RuntimeProfile } from '../src/modules/runtime-management/public/types'
import { emptyDeclaredManifest, type RuntimePlugin } from '../src/services/execution/agentInjection'
import { getRuntimeDriver } from '../src/services/runtime'
import { selectLocalAgentMaterialDefinition } from '../src/modules/runtime-management/infrastructure/local/localAgentMaterialDefinition'
import type {
  AgentSpawnContext,
  AgentSpawnPlan,
  ResolvedSkill,
} from '../src/services/runtime/types'
import { createLogger } from '../src/util/log'

const capabilities: AgentMaterialEvidenceCapabilities = Object.freeze({
  usageNormalizer: true,
  nativeUsageCapture: true,
  spanCapture: true,
  sessionCapture: true,
  inventory: true,
  finalEvents: true,
  liveCapture: true,
  sessionSinkCapture: true,
})
const log = createLogger('rfc370-material')

function profile(model: string | null, extraArgs?: string[] | null): RuntimeProfile {
  return {
    model,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: false,
    ...(extraArgs !== undefined ? { extraArgs } : {}),
  }
}

function agent(name: string): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: name,
    outputs: ['result'],
    syncOutputsOnIterate: true,
    permission: { bash: 'allow' },
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: { nested: { value: 'original' } },
    bodyMd: `body-${name}`,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function context(): AgentSpawnContext {
  return {
    injection: { mcps: [] },
    prompt: 'final user prompt',
    agentName: 'root',
    systemPrompt: 'final system prompt',
    resolvedParamsByAgent: new Map([['root', profile(null)]]),
    cwd: '/native/workspace',
    runRoot: '/native/run-content',
    freshAgentRun: false,
    nodeRunId: 'node-run',
    log,
  }
}

function plan(): AgentSpawnPlan {
  return {
    cmd: ['/native/runtime', 'run'],
    env: { ORIGINAL: 'environment' },
    stdin: { mode: 'pipe', data: 'original stdin' },
    declared: emptyDeclaredManifest(),
  }
}

describe('RFC-370 selected material compiler', () => {
  test('complete declarations and ordered profiles are snapshots without freezing live resources', () => {
    const root = agent('root')
    const first = agent('first')
    const second = agent('second')
    const mcp: Mcp = {
      id: 'mcp',
      name: 'mcp',
      description: '',
      type: 'local',
      config: { command: ['runtime', 'serve'], env: { KEY: 'original' } },
      enabled: true,
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    }
    const args = ['--original']
    const profiles = new Map([
      ['root', profile(null, args)],
      ['first', profile('model-first', null)],
      ['second', profile('model-second')],
    ])
    const mounts = ['/native/workspace', '/native/second-workspace']
    const pluginOptions = { nested: { value: 'original' } }
    const original = {
      ...context(),
      injection: {
        mcps: [mcp],
        agent: root,
        dependents: [first, second],
        profile: profiles.get('root'),
        skills: [],
        plugins: [
          {
            id: 'plugin',
            name: 'plugin',
            options: pluginOptions,
            enabled: true,
            cachedPath: '/plugin',
          },
        ],
      },
      resolvedParamsByAgent: profiles,
      taskMounts: mounts,
      configDir: { ...DEFAULT_CONFIG_DIR_PROFILE.opencode },
      extraArgs: args,
    } satisfies AgentSpawnContext
    const selected = bindLegacyNativeAgentMaterial('opencode', original)
    root.bodyMd = 'changed'
    root.outputs.push('changed')
    first.name = 'changed'
    mcp.config.command.push('changed')
    mcp.config.env!.KEY = 'changed'
    args.push('--changed')
    mounts.push('/changed')
    pluginOptions.nested.value = 'changed'
    profiles.set('root', profile('changed'))

    expect(selected.intent.injection.agent?.bodyMd).toBe('body-root')
    expect(selected.intent.injection.agent?.outputs).toEqual(['result'])
    expect(selected.intent.injection.dependents?.map((value) => value.name)).toEqual([
      'first',
      'second',
    ])
    expect(selected.intent.injection.mcps[0]).toEqual({
      ...mcp,
      config: { command: ['runtime', 'serve'], env: { KEY: 'original' } },
    })
    expect(selected.intent.resolvedProfiles.map(([name, value]) => [name, value.model])).toEqual([
      ['root', null],
      ['first', 'model-first'],
      ['second', 'model-second'],
    ])
    expect(selected.intent.resolvedProfiles[0]?.[1].extraArgs).toEqual(['--original'])
    expect(selected.intent.resolvedProfiles[1]?.[1].extraArgs).toBeNull()
    expect('extraArgs' in selected.intent.resolvedProfiles[2]![1]).toBe(false)
    expect(selected.intent.extraArgs).toEqual(['--original'])
    expect(selected.intent.taskMounts?.map((mount) => selected.contents.workspace(mount))).toEqual([
      '/native/workspace',
      '/native/second-workspace',
    ])
    expect(selected.intent.injection.plugins?.[0]?.declaration.options).toEqual({
      nested: { value: 'original' },
    })
    expect(Object.isFrozen(selected.intent.injection.agent?.outputs)).toBe(true)
    expect(Object.isFrozen(selected.intent.injection.dependents)).toBe(true)
    expect(Object.isFrozen(root)).toBe(false)
    expect(Object.isFrozen(pluginOptions)).toBe(false)
  })

  test('omitted, explicit undefined and null stay distinct; sessions are independent facts', () => {
    const omitted = bindLegacyNativeAgentMaterial('opencode', context()).intent
    for (const key of [
      'runtimeBinding',
      'configDir',
      'taskMounts',
      'injectedMemoryBlock',
      'nativeSessionId',
      'resumeSessionId',
    ]) {
      expect(key in omitted).toBe(false)
    }
    const explicit = bindLegacyNativeAgentMaterial('opencode', {
      ...context(),
      runtimeBinary: undefined,
      configDir: undefined,
      taskMounts: undefined,
      injectedMemoryBlock: null,
      nativeSessionId: 'first-native',
      resumeSessionId: 'resume-native',
      freshAgentRun: true,
    }).intent
    expect('runtimeBinding' in explicit).toBe(true)
    expect(explicit.runtimeBinding).toBeUndefined()
    expect('configDir' in explicit).toBe(true)
    expect('taskMounts' in explicit).toBe(true)
    expect(explicit.injectedMemoryBlock).toBeNull()
    expect(explicit.nativeSessionId).toBe('first-native')
    expect(explicit.resumeSessionId).toBe('resume-native')
    expect(explicit.freshAgentRun).toBe(true)
    expect(
      bindLegacyNativeAgentMaterial('opencode', { ...context(), runtimeBinary: null }).intent
        .runtimeBinding,
    ).toBeNull()
  })

  test('only the selected content binding resolves references; AW declarations override locator metadata', async () => {
    const original = {
      ...context(),
      injection: {
        mcps: [],
        skills: [
          {
            name: 'logical-skill',
            sourceKind: 'managed',
            skillId: 'logical-id',
            contentVersion: 9,
          },
        ],
        plugins: [
          {
            id: 'logical-plugin',
            name: 'logical-plugin',
            options: { enabledOption: true },
            enabled: false,
            cachedPath: '/original-plugin',
          },
        ],
      },
      runtimeBinary: '/original-runtime',
      taskMounts: ['/first-mount', '/second-mount'],
    } satisfies AgentSpawnContext
    const bound = bindLegacyNativeAgentMaterial('opencode', original)
    let versionReads = 0
    class PhysicalSkill implements ResolvedSkill {
      name = 'locator-name'
      sourceKind = 'project' as const
      skillId = 'locator-id'
      contentVersion = 100
      get sourcePath() {
        return '/selected-skill'
      }
      async readContentVersion() {
        expect<ResolvedSkill>(this).toBe(physicalSkill)
        versionReads += 1
        return 9
      }
    }
    const physicalSkill = new PhysicalSkill()
    class PhysicalPlugin {
      id = 'locator-plugin'
      name = 'locator-plugin'
      options = {}
      enabled = true
      get runtimeSpecifier() {
        return 'selected-plugin@2'
      }
    }
    const physicalPlugin: RuntimePlugin = new PhysicalPlugin()
    const calls: string[] = []
    class SelectedContents implements NativeAgentMaterialContents {
      workspace(reference: AgentMaterialIntent['workspace']) {
        expect<NativeAgentMaterialContents>(this).toBe(contents)
        calls.push(reference.reference)
        return `/selected/${reference.reference}`
      }
      runContent(reference: AgentMaterialIntent['runContent']) {
        expect<NativeAgentMaterialContents>(this).toBe(contents)
        calls.push(reference.reference)
        return '/selected/run'
      }
      runtimeBinary() {
        expect<NativeAgentMaterialContents>(this).toBe(contents)
        calls.push('runtime')
        return '/selected/runtime'
      }
      skill() {
        expect<NativeAgentMaterialContents>(this).toBe(contents)
        return physicalSkill
      }
      plugin() {
        expect<NativeAgentMaterialContents>(this).toBe(contents)
        return physicalPlugin
      }
    }
    const contents = new SelectedContents()
    let compilations = 0
    const native = plan()
    const selected = createLocalAgentMaterialCompiler({
      protocol: 'opencode',
      contents,
      evidenceCapabilities: capabilities,
      async buildNative(value) {
        compilations += 1
        expect(value.cwd).toBe('/selected/node-run:workspace')
        expect(value.runRoot).toBe('/selected/run')
        expect(value.runtimeBinary).toBe('/selected/runtime')
        expect(value.taskMounts).toEqual([
          '/selected/node-run:mount:0',
          '/selected/node-run:mount:1',
        ])
        expect(value.injection.skills?.[0]).toMatchObject({
          name: 'logical-skill',
          sourceKind: 'managed',
          skillId: 'logical-id',
          contentVersion: 9,
          sourcePath: '/selected-skill',
        })
        expect(value.injection.plugins).toEqual([
          {
            id: 'logical-plugin',
            name: 'logical-plugin',
            options: { enabledOption: true },
            enabled: false,
            runtimeSpecifier: 'selected-plugin@2',
          },
        ])
        expect(versionReads).toBe(0)
        expect(await value.injection.skills![0]!.readContentVersion!()).toBe(9)
        return native
      },
    })
    const prepared = await selected.compiler.compile(bound.intent)
    expect(compilations).toBe(1)
    expect(versionReads).toBe(1)
    expect(calls).toEqual([
      'node-run:workspace',
      'node-run:run-content',
      'node-run:mount:0',
      'node-run:mount:1',
      'runtime',
    ])
    expect(prepared.declared).toBe(native.declared)
    expect(prepared.evidenceCapabilities).toBe(capabilities)
    expect(selected.nativePlan(prepared.materialRef)).toBe(native)
    expect(Object.keys(prepared).sort()).toEqual([
      'declared',
      'evidenceCapabilities',
      'materialRef',
    ])
    expect(JSON.stringify(bound.intent)).not.toContain('/original-')
    expect(JSON.stringify(prepared)).not.toContain('/native/')
    expect(() => selected.nativePlan('unknown')).toThrow('agent-material-reference-unavailable')
  })

  test('legacy version reader retains its receiver and original staging time', async () => {
    let reads = 0
    const skill: ResolvedSkill = {
      name: 'managed-skill',
      sourceKind: 'managed',
      sourcePath: '/skill',
      skillId: 'skill',
      contentVersion: 4,
      async readContentVersion() {
        expect(this).toBe(skill)
        reads += 1
        return 4
      },
    }
    const original = { ...context(), injection: { mcps: [], skills: [skill] } }
    const selected = bindLegacyNativeAgentMaterial('opencode', original)
    expect(reads).toBe(0)
    const compiler = createLocalAgentMaterialCompiler({
      protocol: 'opencode',
      ...selected,
      evidenceCapabilities: capabilities,
      async buildNative(value) {
        expect(reads).toBe(0)
        await value.injection.skills![0]!.readContentVersion!()
        await value.injection.skills![0]!.readContentVersion!()
        return plan()
      },
    })
    await compiler.compiler.compile(selected.intent)
    expect(reads).toBe(2)
  })

  test('native binding consumes own skill and plugin locator getters once', async () => {
    let skillReads = 0
    let pluginReads = 0
    const skill: ResolvedSkill = {
      name: 'once-skill',
      sourceKind: 'managed',
      get sourcePath() {
        skillReads += 1
        if (skillReads > 1) throw new Error('skill locator consumed twice')
        return '/once-skill'
      },
    }
    const plugin: RuntimePlugin = {
      id: 'once-plugin',
      name: 'once-plugin',
      options: {},
      enabled: true,
      get runtimeSpecifier() {
        pluginReads += 1
        if (pluginReads > 1) throw new Error('plugin locator consumed twice')
        return 'once-plugin@1'
      },
    }
    const bound = bindLegacyNativeAgentMaterial('opencode', {
      ...context(),
      injection: { mcps: [], skills: [skill], plugins: [plugin] },
    })
    expect(skillReads).toBe(1)
    expect(pluginReads).toBe(1)
    const selected = createLocalAgentMaterialCompiler({
      protocol: 'opencode',
      ...bound,
      evidenceCapabilities: capabilities,
      async buildNative(value) {
        expect(value.injection.skills?.[0]?.sourcePath).toBe('/once-skill')
        expect(value.injection.plugins?.[0]?.runtimeSpecifier).toBe('once-plugin@1')
        return plan()
      },
    })
    await selected.compiler.compile(bound.intent)
    expect(skillReads).toBe(1)
    expect(pluginReads).toBe(1)
  })

  test('selected content plugin locator getter is not read again by a material spread', async () => {
    const bound = bindLegacyNativeAgentMaterial('opencode', {
      ...context(),
      injection: {
        mcps: [],
        plugins: [
          { id: 'logical', name: 'logical', options: {}, enabled: true, cachedPath: '/old' },
        ],
      },
    })
    let reads = 0
    let created = 0
    const physical: RuntimePlugin = {
      id: 'physical',
      name: 'physical',
      options: { ignored: true },
      enabled: false,
      get runtimeSpecifier() {
        reads += 1
        if (reads > 1) throw new Error('selected locator consumed twice')
        return 'selected-plugin@1'
      },
    }
    const selected = createLocalAgentMaterialCompiler({
      protocol: 'opencode',
      ...bound,
      contents: { ...bound.contents, plugin: () => physical },
      evidenceCapabilities: capabilities,
      async buildNative(value) {
        created += 1
        expect(value.injection.plugins).toEqual([
          {
            id: 'logical',
            name: 'logical',
            options: {},
            enabled: true,
            runtimeSpecifier: 'selected-plugin@1',
          },
        ])
        return plan()
      },
    })
    await selected.compiler.compile(bound.intent)
    expect(reads).toBe(1)
    expect(created).toBe(1)
  })

  test('fixture commands and probe stay outside the neutral intent', async () => {
    const binaryOverride = ['fixture-runtime', '--fixture']
    const boundaryHostProbe = { platform: 'linux', hasExecutable: () => true } as const
    const bound = bindLegacyNativeAgentMaterial('opencode', {
      ...context(),
      binaryOverride,
      boundaryHostProbe,
    })
    expect('binaryOverride' in bound.intent).toBe(false)
    expect('boundaryHostProbe' in bound.intent).toBe(false)
    const selected = createLocalAgentMaterialCompiler({
      protocol: 'opencode',
      ...bound,
      evidenceCapabilities: capabilities,
      async buildNative(value) {
        expect(value.binaryOverride).toBe(binaryOverride)
        expect(value.boundaryHostProbe).toBe(boundaryHostProbe)
        return plan()
      },
    })
    await selected.compiler.compile(bound.intent)
  })

  test('mismatched protocol rejects before any selected content resolution or material creation', async () => {
    const bound = bindLegacyNativeAgentMaterial('opencode', context())
    let created = 0
    const selected = createLocalAgentMaterialCompiler({
      protocol: 'claude-code',
      contents: {
        workspace() {
          throw new Error('unexpected content read')
        },
        runContent() {
          throw new Error('unexpected content read')
        },
        runtimeBinary() {
          throw new Error('unexpected content read')
        },
        skill() {
          throw new Error('unexpected content read')
        },
        plugin() {
          throw new Error('unexpected content read')
        },
      },
      evidenceCapabilities: capabilities,
      async buildNative() {
        created += 1
        return plan()
      },
    })
    await expect(selected.compiler.compile(bound.intent)).rejects.toThrow(
      'agent-material-protocol-mismatch: opencode',
    )
    expect(created).toBe(0)
  })

  test('unknown references and native preparation rejection preserve the original failure', async () => {
    const bound = bindLegacyNativeAgentMaterial('opencode', context())
    let created = 0
    const selected = createLocalAgentMaterialCompiler({
      protocol: 'opencode',
      ...bound,
      evidenceCapabilities: capabilities,
      async buildNative() {
        created += 1
        return plan()
      },
    })
    await expect(
      selected.compiler.compile({
        ...bound.intent,
        workspace: { owner: 'source-control', reference: 'unknown', version: null },
      }),
    ).rejects.toThrow('agent-material-content-reference-unavailable')
    expect(created).toBe(0)
    const failure = new Error('original-material-preparation-failed')
    await expect<unknown>(
      compileLegacyNativeAgentMaterial({
        protocol: 'opencode',
        context: context(),
        evidenceCapabilities: capabilities,
        async buildNative() {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
  })

  for (const kind of ['opencode', 'claude-code'] as const) {
    test(`${kind}: inherited locators reach actual skill copies and native plugin declarations`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc370-material-locators-'))
      const workspace = join(root, 'workspace')
      const runRoot = join(root, 'runs', 'task', 'node')
      const sourcePath = join(root, 'managed-skill')
      mkdirSync(workspace, { recursive: true })
      mkdirSync(sourcePath, { recursive: true })
      const skillBytes = '---\nname: inherited-skill\n---\nOriginal managed skill.\n'
      writeFileSync(join(sourcePath, 'SKILL.md'), skillBytes)
      writeFileSync(join(sourcePath, 'helper.txt'), 'whole-directory-content')
      class InheritedSkill implements ResolvedSkill {
        name = 'inherited-skill'
        sourceKind = 'managed' as const
        skillId = 'managed-id'
        contentVersion = 7
        get sourcePath() {
          return sourcePath
        }
      }
      class CachedPlugin {
        id = 'cached-plugin'
        name = 'cached-plugin'
        options = {}
        enabled = true
        get cachedPath() {
          return join(root, 'cached-plugin')
        }
      }
      class SpecifierPlugin {
        id = 'specifier-plugin'
        name = 'specifier-plugin'
        options = {}
        enabled = true
        get runtimeSpecifier() {
          return 'selected-plugin@2'
        }
      }
      const original: AgentSpawnContext = {
        ...context(),
        cwd: workspace,
        runRoot,
        taskMounts: [workspace],
        configDir: { env: 'AW_TEST_CONFIG_DIR', name: 'fixture-config' },
        binaryOverride: ['fixture-runtime'],
        injection: {
          mcps: [],
          agent: agent('root'),
          dependents: [],
          skills: [new InheritedSkill()],
          plugins: [new CachedPlugin(), new SpecifierPlugin()],
        },
      }
      try {
        // Exercise both the raw native compatibility API and a bound neutral
        // compilation, each against the actual unchanged native assembler.
        const driver = getRuntimeDriver(kind)
        const bound = bindLegacyNativeAgentMaterial(kind, original)
        const selected = createLocalAgentMaterialCompiler({
          protocol: kind,
          ...bound,
          evidenceCapabilities: capabilities,
          buildNative: (value) => driver.buildSpawn(value),
        })
        const definition = selectLocalAgentMaterialDefinition(kind)
        expect(definition.protocol.kind).toBe(kind)
        expect(definition.evidenceHooks).toBe(driver)
        const rootSelected = definition.createCompiler(bound.contents, bound.fixture)
        const preparations = [
          () => driver.buildSpawn(original),
          async () => {
            const prepared = await selected.compiler.compile(bound.intent)
            return selected.nativePlan(prepared.materialRef)
          },
          async () => {
            const prepared = await rootSelected.compiler.compile(bound.intent)
            return rootSelected.nativePlan(prepared.materialRef)
          },
        ]
        for (const prepare of preparations) {
          const native = await prepare()
          try {
            const configPath =
              kind === 'opencode'
                ? join(runRoot, 'fixture-config')
                : join(workspace, 'fixture-config')
            const staged = join(configPath, 'skills', 'inherited-skill')
            expect(readFileSync(join(staged, 'SKILL.md'), 'utf8')).toBe(skillBytes)
            expect(readFileSync(join(staged, 'helper.txt'), 'utf8')).toBe('whole-directory-content')
            expect(native.declared.skills).toEqual(['inherited-skill'])
            if (kind === 'opencode') {
              const inline: { plugin: string[] } = JSON.parse(native.env.OPENCODE_CONFIG_CONTENT!)
              expect(inline.plugin).toEqual([
                `file://${join(root, 'cached-plugin')}`,
                'selected-plugin@2',
              ])
              expect(native.declared.plugins).toEqual(['cached-plugin', 'specifier-plugin'])
            } else {
              expect(native.declared.unsupported).toEqual([
                'plugin:cached-plugin',
                'plugin:specifier-plugin',
              ])
            }
          } finally {
            await native.cleanup?.()
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test(`${kind}: persona declaration getter fails once inside the original downgrade boundary`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc370-material-persona-'))
      const workspace = join(root, 'workspace')
      mkdirSync(workspace)
      const failure = new Error('original-declaration-access-failed')
      let reads = 0
      const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
      const original: AgentSpawnContext = {
        ...context(),
        cwd: workspace,
        runRoot: join(root, 'run'),
        binaryOverride: ['fixture-runtime'],
        log: {
          ...log,
          warn(message, fields) {
            warnings.push({ message, fields })
          },
        },
        injection: {
          mcps: [],
          get plugins(): RuntimePlugin[] {
            reads += 1
            if (reads === 1) throw failure
            return []
          },
        },
      }
      try {
        const native = await getRuntimeDriver(kind).buildSpawn(original)
        try {
          expect(reads).toBe(1)
          expect(native.cmd[0]).toBe('fixture-runtime')
          expect(native.declared).toEqual(emptyDeclaredManifest())
          expect(
            warnings.filter((value) => value.message === 'startup-declaration-failed'),
          ).toEqual([
            {
              message: 'startup-declaration-failed',
              fields: { nodeRunId: 'node-run', err: failure.message },
            },
          ])
        } finally {
          await native.cleanup?.()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test(`${kind}: business material getter remains fatal after the original declaration warning`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc370-material-business-error-'))
      const workspace = join(root, 'workspace')
      mkdirSync(workspace)
      const failure = new Error('original-business-material-failed')
      let reads = 0
      const warnings: string[] = []
      const original: AgentSpawnContext = {
        ...context(),
        cwd: workspace,
        runRoot: join(root, 'run'),
        taskMounts: [workspace],
        configDir: DEFAULT_CONFIG_DIR_PROFILE[kind],
        binaryOverride: ['fixture-runtime'],
        log: {
          ...log,
          warn(message) {
            warnings.push(message)
          },
        },
        injection: {
          mcps: [],
          agent: agent('root'),
          get plugins(): RuntimePlugin[] {
            reads += 1
            throw failure
          },
        },
      }
      try {
        await expect<unknown>(getRuntimeDriver(kind).buildSpawn(original)).rejects.toBe(failure)
        expect(reads).toBe(2)
        expect(warnings).toEqual(['startup-declaration-failed'])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test(`${kind}: an inherited plugin data container keeps its nested getter inside persona downgrade`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc370-material-inherited-declaration-'))
      const workspace = join(root, 'workspace')
      mkdirSync(workspace)
      const failure = new Error('inherited-plugin-name-access-failed')
      let reads = 0
      const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
      const plugin: RuntimePlugin = {
        id: 'inherited',
        options: {},
        enabled: true,
        runtimeSpecifier: 'inherited@1',
        get name(): string {
          reads += 1
          if (reads === 1) throw failure
          return 'inherited'
        },
      }
      class InheritedInjection {
        mcps: Mcp[] = []
        declare plugins: RuntimePlugin[]
      }
      Object.defineProperty(InheritedInjection.prototype, 'plugins', { value: [plugin] })
      const original: AgentSpawnContext = {
        ...context(),
        cwd: workspace,
        runRoot: join(root, 'run'),
        binaryOverride: ['fixture-runtime'],
        injection: new InheritedInjection(),
        log: {
          ...log,
          warn(message, fields) {
            warnings.push({ message, fields })
          },
        },
      }
      try {
        const native = await getRuntimeDriver(kind).buildSpawn(original)
        try {
          expect(reads).toBe(1)
          expect(native.cmd[0]).toBe('fixture-runtime')
          expect(native.declared).toEqual(emptyDeclaredManifest())
          expect(
            warnings.filter((value) => value.message === 'startup-declaration-failed'),
          ).toEqual([
            {
              message: 'startup-declaration-failed',
              fields: { nodeRunId: 'node-run', err: failure.message },
            },
          ])
        } finally {
          await native.cleanup?.()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test(`${kind}: an empty MCP array iterator getter keeps the original persona downgrade`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc370-material-iterator-declaration-'))
      const workspace = join(root, 'workspace')
      mkdirSync(workspace)
      const failure = new Error('mcp-iterator-access-failed')
      let reads = 0
      const mcps: Mcp[] = []
      Object.defineProperty(mcps, Symbol.iterator, {
        get() {
          reads += 1
          if (reads === 1) throw failure
          return Array.prototype[Symbol.iterator]
        },
      })
      const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
      const original: AgentSpawnContext = {
        ...context(),
        cwd: workspace,
        runRoot: join(root, 'run'),
        binaryOverride: ['fixture-runtime'],
        injection: { mcps },
        log: {
          ...log,
          warn(message, fields) {
            warnings.push({ message, fields })
          },
        },
      }
      try {
        const native = await getRuntimeDriver(kind).buildSpawn(original)
        try {
          expect(reads).toBe(1)
          expect(native.cmd[0]).toBe('fixture-runtime')
          expect(native.declared).toEqual(emptyDeclaredManifest())
          expect(
            warnings.filter((value) => value.message === 'startup-declaration-failed'),
          ).toEqual([
            {
              message: 'startup-declaration-failed',
              fields: { nodeRunId: 'node-run', err: failure.message },
            },
          ])
        } finally {
          await native.cleanup?.()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

// RFC-370: native supplier lookup keeps the original unknown-kind error before
// opening any content or execution scope. Both real native bodies run above.
describe('RFC-370 native material supplier selection', () => {
  for (const kind of ['unregistered', '__proto__', '']) {
    test(`unknown native material kind ${JSON.stringify(kind)} retains its original error`, () => {
      expect(() =>
        selectLocalAgentMaterialDefinition(
          kind as Parameters<typeof selectLocalAgentMaterialDefinition>[0],
        ),
      ).toThrow(`unknown runtime kind '${String(kind)}' — no registered driver (RFC-282 决策 13)`)
    })
  }
})
