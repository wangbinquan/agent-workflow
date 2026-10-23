// RFC-395 II-a A4: location formulas stay in reusable codecs and skill content ports carry bytes.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sites = [
  [
    'modules/task-execution/application/nodeRunPrompt.ts',
    'legacyPromptNeedsFile',
    /PROMPT_SPILL_MIN_BYTES/,
  ],
  [
    'modules/task-execution/infrastructure/local/fileNodeRunPromptContent.ts',
    'legacyPromptPath',
    /join\(taskId, 'prompts'/,
  ],
  [
    'modules/task-execution/domain/portArtifacts.ts',
    'decodeLegacyPortArchive',
    /JSON\.parse\(raw\)/,
  ],
  [
    'modules/task-execution/application/portArtifacts.ts',
    'legacyContainerPath',
    /join\(mountPath, repoRelPath\)/,
  ],
  [
    'modules/task-execution/infrastructure/taskExecutionReadModels.ts',
    'legacyPortFallbackMount',
    /const legacyRepoDirName = isSingleRootRepository/,
  ],
  [
    'modules/collaboration/application/prepareReviewGateOpen.ts',
    'legacyReviewBodyPath',
    /`runs\/\$\{input\.taskId\}/,
  ],
  [
    'modules/collaboration/application/reviewArtifactPlan.ts',
    'legacyReviewStagedPath',
    /`runs\/\.human-gate-staging\//,
  ],
  ['modules/collaboration/infrastructure/review.ts', 'legacyReviewBodyPath', /writeFileSync\(/],
  ['platform/background/eventsArchiveReader.ts', 'legacyEventArchivePath', /join\(logsDir, taskId/],
  [
    'platform/persistence/sqlite/systemEventsArchive.ts',
    'legacyEventArchivePath',
    /join\(logsDir, taskId/,
  ],
  [
    'modules/task-execution/infrastructure/crewstation/nodeEventArchive.ts',
    'legacyEventArchiveChunkPath',
    /`aw-event-archive:/,
  ],
  [
    'modules/resource-catalog/infrastructure/databaseSkillContent.ts',
    'decodeLegacySkillStagingPath',
    /STAGING_REFERENCE/,
  ],
  [
    'modules/task-execution/composition/nodeMechanics.ts',
    'legacyPortFallbackMount',
    /state\.repos\[0\]\?\.mountPath \?\? ''/,
  ],
  [
    'modules/task-execution/infrastructure/local/filePortArtifactContent.ts',
    'legacyPortArchiveTaskRoot',
    /resolve\(appHome, 'runs', taskId, 'ports'\)/,
  ],
  [
    'modules/task-execution/infrastructure/crewstation/taskArchiveContent.ts',
    'isLegacyHostedArchiveTemporary',
    /cs-archive:/,
  ],
  [
    'modules/resource-catalog/infrastructure/crewstation/pluginGenerations.ts',
    'isLegacyHostedPluginReference',
    /startsWith\('cs-plugin:'/,
  ],
  [
    'modules/resource-catalog/infrastructure/crewstation/pluginPublication.ts',
    'isLegacyHostedPluginReference',
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
  expect(violations(sites[1][0], "legacyPromptPath; join(taskId, 'prompts', run)")).toEqual([
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
