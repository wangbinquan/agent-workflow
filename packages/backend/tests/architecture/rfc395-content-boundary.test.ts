// RFC-395 II-a A4: location formulas stay in reusable codecs and skill content ports carry bytes.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sites = [
  [
    'modules/task-execution/application/nodeRunPrompt.ts',
    'promptNeedsFile',
    /PROMPT_SPILL_MIN_BYTES/,
  ],
  [
    'modules/task-execution/infrastructure/local/fileNodeRunPromptContent.ts',
    'promptPath',
    /join\(taskId, 'prompts'/,
  ],
  ['modules/task-execution/domain/portArtifacts.ts', 'decodePortArchive', /JSON\.parse\(raw\)/],
  [
    'modules/task-execution/application/portArtifacts.ts',
    'containerPath',
    /join\(mountPath, repoRelPath\)/,
  ],
  [
    'modules/task-execution/infrastructure/taskExecutionReadModels.ts',
    'portFallbackMount',
    /const legacyRepoDirName = isSingleRootRepository/,
  ],
  [
    'modules/collaboration/application/prepareReviewGateOpen.ts',
    'finalContentKey',
    /`runs\/\$\{input\.taskId\}/,
  ],
  [
    'modules/collaboration/application/reviewArtifactPlan.ts',
    'reviewStagedPath',
    /`runs\/\.human-gate-staging\//,
  ],
  ['modules/collaboration/infrastructure/review.ts', 'reviewBodyPath', /writeFileSync\(/],
  ['platform/background/eventsArchiveReader.ts', 'eventArchivePath', /join\(logsDir, taskId/],
  [
    'platform/persistence/sqlite/systemEventsArchive.ts',
    'eventArchivePath',
    /join\(logsDir, taskId/,
  ],
  [
    'modules/task-execution/infrastructure/crewstation/nodeEventArchive.ts',
    'eventArchiveChunkPath',
    /`aw-event-archive:/,
  ],
  [
    'modules/resource-catalog/infrastructure/databaseSkillContent.ts',
    'decodeSkillStagingPath',
    /STAGING_REFERENCE/,
  ],
  [
    // RFC-405: the agent-single port-file forcing moved with its binding out of nodeMechanics.ts.
    'modules/task-execution/composition/agentNodeExecution.ts',
    'portFallbackMount',
    /state\.repos\[0\]\?\.mountPath \?\? ''/,
  ],
  [
    'modules/task-execution/infrastructure/local/filePortArtifactContent.ts',
    'portArchiveTaskRoot',
    /resolve\(appHome, 'runs', taskId, 'ports'\)/,
  ],
  [
    'modules/task-execution/infrastructure/crewstation/taskArchiveContent.ts',
    'isHostedArchiveTemporary',
    /cs-archive:/,
  ],
  [
    'modules/resource-catalog/infrastructure/crewstation/pluginGenerations.ts',
    'isHostedPluginReference',
    /startsWith\('cs-plugin:'/,
  ],
  [
    'modules/resource-catalog/infrastructure/crewstation/pluginPublication.ts',
    'isHostedPluginReference',
    /startsWith\('cs-plugin:'/,
  ],
] as const

function violations(path: string, text: string): string[] {
  const site = sites.find(([candidate]) => candidate === path)
  if (site === undefined) return []
  return [
    ...(!text.includes(site[1]) ? ['codec missing'] : []),
    ...(site[2].test(text) ? ['legacy formula outside codec'] : []),
  ]
}

test('all migrated formula owners call the codec', () => {
  expect(sites.length).toBeGreaterThanOrEqual(12)
  for (const [path] of sites)
    expect(
      violations(path, readFileSync(resolve(import.meta.dir, '../../src', path), 'utf8')),
      path,
    ).toEqual([])
})

test('negative controls detect a lost codec call and restored prompt location formula', () => {
  expect(violations(sites[0][0], 'const PROMPT_SPILL_MIN_BYTES = 4096')).toEqual([
    'codec missing',
    'legacy formula outside codec',
  ])
  expect(violations(sites[1][0], "promptPath; join(taskId, 'prompts', run)")).toEqual([
    'legacy formula outside codec',
  ])
  const inline = [
    "state.repos[0]?.mountPath ?? ''",
    "resolve(appHome, 'runs', taskId, 'ports')",
    '`cs-archive:${kind}`',
    "value.startsWith('cs-plugin:')",
    "value.startsWith('cs-plugin:')",
  ]
  for (const [index, formula] of inline.entries()) {
    const [path, codec] = sites[index + 12]!
    expect(violations(path, codec + '; ' + formula)).toEqual(['legacy formula outside codec'])
    expect(violations(path, '')).toEqual(['codec missing'])
  }
})

test('skill port bytes and explicit text projection cannot silently become string reads again', () => {
  for (const path of [
    'contentReader.ts',
    'versionContentReader.ts',
    'creationContentStore.ts',
    'versionContentStore.ts',
  ]) {
    const source = readFileSync(
      resolve(import.meta.dir, '../../src/modules/resource-catalog/application/skills', path),
      'utf8',
    )
    expect(source).toContain('Uint8Array')
    expect(source).not.toMatch(/readonly (?:mainContent|content|main): string/)
  }
  const source = readFileSync(
    resolve(import.meta.dir, '../../src/modules/resource-catalog/application/skills/textView.ts'),
    'utf8',
  )
  expect(source).toContain("policy.textBom === 'strip'")
  expect('readonly content: string').toMatch(/readonly (?:mainContent|content|main): string/)
})

test('target content adapters never reintroduce text-encoded skill bytes or the old publication table', () => {
  const trees = readFileSync(
    resolve(
      import.meta.dir,
      '../../src/modules/resource-catalog/infrastructure/databaseSkillTrees.ts',
    ),
    'utf8',
  )
  expect(trees).toContain('contentRefColumns')
  expect(trees).toContain('readDatabaseContent')
  expect(trees).not.toMatch(/row\.encoding|row\.content\b|toString\('base64'\)/)
  const publications = readFileSync(
    resolve(
      import.meta.dir,
      '../../src/modules/system-operations/infrastructure/crewstation/objectPublications.ts',
    ),
    'utf8',
  )
  expect(publications).toContain('contentPublications: hostedObjectPublications')
  expect(publications).not.toMatch(/\{ hostedObjectPublications \} = tablesOf/)
  const boot = readFileSync(
    resolve(
      import.meta.dir,
      '../../src/modules/resource-catalog/infrastructure/skillCatalogBootAdapter.ts',
    ),
    'utf8',
  )
  expect(boot).toContain('recoverSkillOperations(input.db, selected, SKILL_OP_RECOVERY_REGISTRY)')
  expect(boot).not.toContain('runSkillIdentityMigrationBarrier')
  expect(boot).not.toContain('backfillLegacySkillVersions')
  const versions = readFileSync(
    resolve(
      import.meta.dir,
      '../../src/modules/resource-catalog/infrastructure/legacy/skillVersion.ts',
    ),
    'utf8',
  )
  expect(versions).not.toMatch(/\bawait\s+ensureInitialSkillVersion\(/)
})

test('RFC-403 review keeps the platform fallback codec through its bound port', () => {
  const path = 'modules/task-execution/engine/node/review/reviewNodeExecutor.ts'
  const binding = 'modules/task-execution/composition/humanGateNodeExecution.ts'
  const valid = (text: string) =>
    text.includes('ports.portFallbackMount(ports.repoMounts)') && !/repoMounts\[0\]/.test(text)
  expect(valid(readFileSync(resolve(import.meta.dir, '../../src', path), 'utf8'))).toBe(true)
  expect(readFileSync(resolve(import.meta.dir, '../../src', binding), 'utf8')).toContain(
    "import { portFallbackMount } from '@/platform/content/locations/portArchive'",
  )
  expect(valid('repoDirName: ports.repoMounts[0]')).toBe(false)
  expect(valid('repoDirName: "repo"')).toBe(false)
})

test('RFC-405 the agent body reaches the fallback codec only through its workspace port', () => {
  const path = 'modules/task-execution/engine/node/agent-single/runAgentSingleNode.ts'
  const valid = (text: string) =>
    text.includes('workspace.portFileContainerPaths(') &&
    !text.includes('portFallbackMount') &&
    !/repos\[0\]\?\.mountPath/.test(text)
  expect(valid(readFileSync(resolve(import.meta.dir, '../../src', path), 'utf8'))).toBe(true)
  expect(valid("toContainerRelative(state.repos[0]?.mountPath ?? '', p)")).toBe(false)
  expect(valid('workspace.portFileContainerPaths(paths); portFallbackMount(mounts)')).toBe(false)
})
