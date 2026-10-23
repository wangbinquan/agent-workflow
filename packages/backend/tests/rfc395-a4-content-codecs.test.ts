// RFC-395 II-a A4: freeze HEAD's location formulas and exact legacy payload bytes for II-b conversion.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { sha256Hex } from '@/util/hash'
import { encodeLegacyContent } from '@/platform/content/contentRef'
import {
  decodeLegacyPrompt,
  encodeLegacyPrompt,
  legacyPromptPath,
  legacyPromptNeedsFile,
  legacyHostedPrompt,
  readLegacyHostedPrompt,
} from '@/platform/content/legacyPrompt'
import {
  decodeLegacyPortArchive,
  encodeLegacyPortArchive,
  copyLegacyPortArchive,
  decodeLegacyPortArchiveFile,
  legacyPortSegment,
  legacyPortArchivePath,
  legacyHostedPortArchivePath,
  legacyPortFallbackMount,
  legacyContainerPath,
} from '@/platform/content/legacyPortArchive'
import {
  decodeLegacyReviewBody,
  legacyReviewBodyPath,
  legacyReviewStagedPath,
} from '@/platform/content/legacyReview'
import {
  decodeLegacyEventArchive,
  legacyEventArchivePath,
  legacyEventArchiveChunkPath,
  legacyHostedEventArchiveReference,
} from '@/platform/content/legacyEventArchive'
import {
  decodeLegacySkillPath,
  decodeLegacySkillTree,
  skillFilesRel,
  skillVersionRelPath,
  legacySkillStagingPath,
  decodeLegacySkillStagingPath,
  legacySkillTrashPath,
  versionTree,
  stagingTree,
  trashTreeOf,
  candidateTree,
} from '@/platform/content/legacySkill'
import {
  decodeLegacyHostedObject,
  hostedObjectReference,
} from '@/platform/content/legacyHostedObject'
import { decodeLegacyHostedArchive } from '@/platform/content/legacyHostedArchive'
import {
  decodeLegacyTaskRetention,
  legacyTaskRetentionReference,
} from '@/platform/content/legacyTaskRetention'
import {
  decodeLegacyPlugin,
  legacyPluginGenerationReference,
  legacyPluginCachedReference,
} from '@/platform/content/legacyPlugin'
import { decodeLegacyContentDirectory } from '@/platform/content/legacyDirectories'

test('prompt dual storage round-trips both columns, including text precedence and empty text', () => {
  for (const value of [
    { promptText: null, promptPath: null },
    { promptText: '', promptPath: 'unused/old.md' },
    { promptText: '\ufeff中文\0', promptPath: null },
    { promptText: null, promptPath: 't/prompts/n.md' },
    { promptText: null, promptPath: 't\\prompts\\n.md' },
  ])
    expect(encodeLegacyPrompt(decodeLegacyPrompt(value))).toEqual(value)
  expect(legacyPromptPath('t', 'n')).toBe(join('t', 'prompts', 'n.md'))
  expect(legacyPromptNeedsFile('中'.repeat(1365))).toBe(false)
  expect(legacyPromptNeedsFile('中'.repeat(1365) + 'x')).toBe(true)
  expect(decodeLegacyPrompt({ promptText: '\ufeffx', promptPath: null })).toMatchObject({
    kind: 'inline',
    version: 1,
    size: 4,
    sha256: sha256Hex(Buffer.from('\ufeffx')),
  })
})

test('hosted prompts stay inline below, at and above the native spill threshold', () => {
  for (const prompt of ['', '中'.repeat(1365), 'x'.repeat(4096), '\ufeff中\0'.repeat(4096)]) {
    // HEAD crewstationExecution.ts stored the original string directly, regardless of size.
    expect(legacyHostedPrompt(prompt)).toEqual({ promptText: prompt, promptPath: null })
    expect(readLegacyHostedPrompt({ promptText: prompt, promptPath: 'ignored/old.md' })).toBe(
      prompt,
    )
  }
  expect(readLegacyHostedPrompt({ promptText: null, promptPath: 'legacy/file.md' })).toBeNull()
  expect(readLegacyHostedPrompt(null)).toBeNull()
  expect(readLegacyHostedPrompt(undefined)).toBeNull()
})

test('archive JSON copies preserve whitespace, unknown keys, invalid payloads and source size', () => {
  const raw =
    ' { "v":1, "items": [ { "path":"docs/a.md", "file":"runs/child/ports/n/p/item_0.md", "size":9999999, "truncated":true } ], "future":2 }\n'
  const decoded = decodeLegacyPortArchive(raw)!
  expect(encodeLegacyPortArchive(decoded)).toBe(raw)
  expect(copyLegacyPortArchive(raw)).toBe(raw)
  for (const invalid of [null, '', '{bad', '{"v":2,"items":[]}'])
    expect(copyLegacyPortArchive(invalid)).toBe(invalid)
  const file = decodeLegacyPortArchiveFile(decoded.archive.items[0]!.file!)
  expect(encodeLegacyContent(file)).toBe('runs/child/ports/n/p/item_0.md')
  expect(file.size).toBeNull() // The source size is not the truncated stored length.
  const segment = `${'a/b'.replace(/[^A-Za-z0-9_-]/g, '_')}_${sha256Hex('a/b').slice(0, 16)}`
  expect(legacyPortSegment('a/b')).toBe(segment)
  expect(legacyPortArchivePath('t', 'n', 'a/b', 2, '.md')).toBe(
    join('runs', 't', 'ports', 'n', segment, 'item_2.md'),
  )
  expect(legacyHostedPortArchivePath('t', 'n', 'a/b', 2, '.md')).toBe(
    `runs/t/ports/n/${segment}/item_2.md`,
  )
  expect(legacyContainerPath('repo', 'docs/a.md')).toBe(join('repo', 'docs/a.md'))
  expect(legacyPortFallbackMount(['nested'])).toBe('nested')
  expect(legacyPortFallbackMount([''])).toBe('')
  expect(legacyPortFallbackMount(['a', 'b'])).toBe('a')
  expect(legacyPortFallbackMount([])).toBe('')
})

test('review legacy, gate manifest/final path and staged path retain their formulas', () => {
  const input = { taskId: 't', reviewNodeId: 'n', sourcePortName: 'p', versionIndex: 3 }
  const legacy = 'runs/t/review/n/p/v3.md'
  const journaled = 'runs/t/review/n/p/round_op/item_0/v3.md'
  const staged = `runs/.human-gate-staging/${sha256Hex('op').slice(0, 24)}/${sha256Hex('doc').slice(0, 24)}.md`
  expect(legacyReviewBodyPath(input)).toBe(legacy)
  expect(legacyReviewBodyPath({ ...input, itemIndex: 0, operationId: 'op' })).toBe(journaled)
  expect(legacyReviewStagedPath('op', 'doc')).toBe(staged)
  for (const path of [legacy, journaled, staged, `${staged}.writing`])
    expect(encodeLegacyContent(decodeLegacyReviewBody(path))).toBe(path)
})

test('both event layouts and directory archives round-trip without rebasing', () => {
  expect(legacyEventArchivePath('/logs', 't', 'n')).toBe(join('/logs', 't', 'n.jsonl'))
  expect(legacyEventArchiveChunkPath('n', 12, 29)).toBe('n.events/12-29.jsonl')
  expect(legacyHostedEventArchiveReference('digest')).toBe('aw-event-archive:digest')
  for (const path of [
    'logs/t/n.jsonl',
    'logs/t/n.jsonl.append-journal.json',
    'logs/t/n.events/12-29.jsonl',
    'aw-event-archive:digest',
  ])
    expect(encodeLegacyContent(decodeLegacyEventArchive(path))).toBe(path)
  for (const path of ['/archive/.tmp-t/runs/t', 'cs-archive:tasks/t/logs/t'])
    expect(encodeLegacyContent(decodeLegacyContentDirectory(path))).toBe(path)
})

test('skill identities, all five database namespaces and FS-shaped references preserve spelling', () => {
  const op = '01J0PB00000000000000000001'
  expect(skillFilesRel('s')).toBe('skills/s/files')
  expect(skillVersionRelPath('s', 2)).toBe('skills/s/versions/v2/files')
  expect(legacySkillStagingPath('s', op)).toBe(`skills/s/files.op-${op}.staged`)
  expect(decodeLegacySkillStagingPath(`skills/s/files.op-${op}.staged`)).toEqual({
    skillId: 's',
    publicationId: op,
  })
  expect(legacySkillTrashPath('s', op)).toBe(`skills/.trash/s-${op}`)
  for (const path of [
    'skills/s/files',
    'skills\\s\\files',
    'C:\\old\\home\\skills\\s\\versions\\v2\\files',
    'skills/old name/files/',
    'skills/s/versions/v2/files',
    `/old/home/skills/s/files.op-${op}.candidate`,
    `skills/.trash/s-${op}`,
    'skills/s/candidates/c/files',
  ]) {
    for (const storage of ['local-file', 'database-bytes'] as const)
      expect(encodeLegacyContent(decodeLegacySkillPath(path, storage))).toBe(path)
  }
  const trees = [
    'live',
    versionTree(2),
    stagingTree(op),
    trashTreeOf(op, 'version:2'),
    candidateTree('c'),
  ]
  expect(trees).toEqual([
    'live',
    'version:2',
    `staging:${op}`,
    `trash:${op}|version:2`,
    'candidate:c',
  ])
  for (const tree of trees)
    expect(encodeLegacyContent(decodeLegacySkillTree('s', tree, 'SKILL.md'))).toEqual({
      skillId: 's',
      tree,
      path: 'SKILL.md',
    })
})

test('hosted object, archive, retention and plugin strings re-encode byte-identically', () => {
  const object = { id: '12345678-1234-1234-1234-123456789abc', size: 0, sha256: 'a'.repeat(64) }
  const objectRef = `aw-object:v2:employee-input:${object.id}:0:${object.sha256}`
  expect(hostedObjectReference('employee-input', object)).toBe(objectRef)
  expect(encodeLegacyContent(decodeLegacyHostedObject('employee-input', objectRef))).toBe(objectRef)
  for (const path of [
    'cs-archive:tasks/.tmp-t/db/tasks.jsonl',
    'cs-archive:runs/t',
    'cs-archive:logs/t',
  ])
    expect(encodeLegacyContent(decodeLegacyHostedArchive(path))).toBe(path)
  expect(legacyTaskRetentionReference('owner x', 'child', 'logs')).toBe(
    'aw-hosted-task-retention:owner%20x/child/logs',
  )
  const retention = 'aw-hosted-task-retention:owner%2fx/child/logs'
  expect(encodeLegacyContent(decodeLegacyTaskRetention(retention))).toBe(retention)
  expect(legacyPluginGenerationReference('p', 'g')).toBe('cs-plugin:p/g')
  expect(legacyPluginCachedReference('cs-plugin:p/g', 'dir/a')).toBe('cs-plugin:p/g/dir%2Fa')
  for (const path of ['cs-plugin:p/g', 'cs-plugin:p/g/dir%2fa'])
    expect(encodeLegacyContent(decodeLegacyPlugin(path))).toBe(path)
})
