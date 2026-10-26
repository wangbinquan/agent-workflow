// RFC-395 II-a A4: freeze HEAD's location formulas and exact legacy payload bytes for II-b conversion.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { sha256Hex } from '@/util/hash'
import { encodeLegacyContent } from '@/platform/content/contentRef'
import {
  decodePrompt,
  encodePrompt,
  promptPath,
  promptNeedsFile,
  hostedPrompt,
  readHostedPrompt,
} from '@/platform/content/locations/prompt'
import {
  decodePortArchive,
  encodePortArchive,
  copyPortArchive,
  decodePortArchiveFile,
  portSegment,
  portArchivePath,
  hostedPortArchivePath,
  portFallbackMount,
  containerPath,
} from '@/platform/content/locations/portArchive'
import {
  decodeReviewBody,
  reviewBodyPath,
  reviewStagedPath,
} from '@/platform/content/locations/review'
import {
  decodeEventArchive,
  eventArchivePath,
  eventArchiveChunkPath,
  hostedEventArchiveReference,
} from '@/platform/content/locations/eventArchive'
import {
  decodeSkillPath,
  decodeSkillTree,
  skillFilesRel,
  skillVersionRelPath,
  skillStagingPath,
  decodeSkillStagingPath,
  skillTrashPath,
  versionTree,
  stagingTree,
  trashTreeOf,
  candidateTree,
} from '@/platform/content/locations/skill'
import {
  decodeHostedObject,
  hostedObjectReference,
} from '@/platform/content/locations/hostedObject'
import { decodeHostedArchive } from '@/platform/content/locations/hostedArchive'
import {
  decodeTaskRetention,
  taskRetentionReference,
} from '@/platform/content/locations/taskRetention'
import {
  decodePlugin,
  pluginGenerationReference,
  pluginCachedReference,
} from '@/platform/content/locations/plugin'
import { decodeContentDirectory } from '@/platform/content/locations/directories'

test('prompt dual storage round-trips both columns, including text precedence and empty text', () => {
  for (const value of [
    { promptText: null, promptPath: null },
    { promptText: '', promptPath: 'unused/old.md' },
    { promptText: '\ufeff中文\0', promptPath: null },
    { promptText: null, promptPath: 't/prompts/n.md' },
    { promptText: null, promptPath: 't\\prompts\\n.md' },
  ])
    expect(encodePrompt(decodePrompt(value))).toEqual(value)
  expect(promptPath('t', 'n')).toBe(join('t', 'prompts', 'n.md'))
  expect(promptNeedsFile('中'.repeat(1365))).toBe(false)
  expect(promptNeedsFile('中'.repeat(1365) + 'x')).toBe(true)
  expect(decodePrompt({ promptText: '\ufeffx', promptPath: null })).toMatchObject({
    kind: 'inline',
    version: 1,
    size: 4,
    sha256: sha256Hex(Buffer.from('\ufeffx')),
  })
})

test('hosted prompts stay inline below, at and above the native spill threshold', () => {
  for (const prompt of ['', '中'.repeat(1365), 'x'.repeat(4096), '\ufeff中\0'.repeat(4096)]) {
    // HEAD crewstationExecution.ts stored the original string directly, regardless of size.
    expect(hostedPrompt(prompt)).toEqual({ promptText: prompt, promptPath: null })
    expect(readHostedPrompt({ promptText: prompt, promptPath: 'ignored/old.md' })).toBe(prompt)
  }
  expect(readHostedPrompt({ promptText: null, promptPath: 'legacy/file.md' })).toBeNull()
  expect(readHostedPrompt(null)).toBeNull()
  expect(readHostedPrompt(undefined)).toBeNull()
})

test('archive JSON copies preserve whitespace, unknown keys, invalid payloads and source size', () => {
  const raw =
    ' { "v":1, "items": [ { "path":"docs/a.md", "file":"runs/child/ports/n/p/item_0.md", "size":9999999, "truncated":true } ], "future":2 }\n'
  const decoded = decodePortArchive(raw)!
  expect(encodePortArchive(decoded)).toBe(raw)
  expect(copyPortArchive(raw)).toBe(raw)
  for (const invalid of [null, '', '{bad', '{"v":2,"items":[]}'])
    expect(copyPortArchive(invalid)).toBe(invalid)
  const file = decodePortArchiveFile(decoded.archive.items[0]!.file!)
  expect(encodeLegacyContent(file)).toBe('runs/child/ports/n/p/item_0.md')
  expect(file.size).toBeNull() // The source size is not the truncated stored length.
  const segment = `${'a/b'.replace(/[^A-Za-z0-9_-]/g, '_')}_${sha256Hex('a/b').slice(0, 16)}`
  expect(portSegment('a/b')).toBe(segment)
  expect(portArchivePath('t', 'n', 'a/b', 2, '.md')).toBe(
    join('runs', 't', 'ports', 'n', segment, 'item_2.md'),
  )
  expect(hostedPortArchivePath('t', 'n', 'a/b', 2, '.md')).toBe(
    `runs/t/ports/n/${segment}/item_2.md`,
  )
  expect(containerPath('repo', 'docs/a.md')).toBe(join('repo', 'docs/a.md'))
  expect(portFallbackMount(['nested'])).toBe('nested')
  expect(portFallbackMount([''])).toBe('')
  expect(portFallbackMount(['a', 'b'])).toBe('a')
  expect(portFallbackMount([])).toBe('')
})

test('review legacy, gate manifest/final path and staged path retain their formulas', () => {
  const input = { taskId: 't', reviewNodeId: 'n', sourcePortName: 'p', versionIndex: 3 }
  const legacy = 'runs/t/review/n/p/v3.md'
  const journaled = 'runs/t/review/n/p/round_op/item_0/v3.md'
  const staged = `runs/.human-gate-staging/${sha256Hex('op').slice(0, 24)}/${sha256Hex('doc').slice(0, 24)}.md`
  expect(reviewBodyPath(input)).toBe(legacy)
  expect(reviewBodyPath({ ...input, itemIndex: 0, operationId: 'op' })).toBe(journaled)
  expect(reviewStagedPath('op', 'doc')).toBe(staged)
  for (const path of [legacy, journaled, staged, `${staged}.writing`])
    expect(encodeLegacyContent(decodeReviewBody(path))).toBe(path)
})

test('both event layouts and directory archives round-trip without rebasing', () => {
  expect(eventArchivePath('/logs', 't', 'n')).toBe(join('/logs', 't', 'n.jsonl'))
  expect(eventArchiveChunkPath('n', 12, 29)).toBe('n.events/12-29.jsonl')
  expect(hostedEventArchiveReference('digest')).toBe('aw-event-archive:digest')
  for (const path of [
    'logs/t/n.jsonl',
    'logs/t/n.jsonl.append-journal.json',
    'logs/t/n.events/12-29.jsonl',
    'aw-event-archive:digest',
  ])
    expect(encodeLegacyContent(decodeEventArchive(path))).toBe(path)
  for (const path of ['/archive/.tmp-t/runs/t', 'cs-archive:tasks/t/logs/t'])
    expect(encodeLegacyContent(decodeContentDirectory(path))).toBe(path)
})

test('skill identities, all five database namespaces and FS-shaped references preserve spelling', () => {
  const op = '01J0PB00000000000000000001'
  expect(skillFilesRel('s')).toBe('skills/s/files')
  expect(skillVersionRelPath('s', 2)).toBe('skills/s/versions/v2/files')
  expect(skillStagingPath('s', op)).toBe(`skills/s/files.op-${op}.staged`)
  expect(decodeSkillStagingPath(`skills/s/files.op-${op}.staged`)).toEqual({
    skillId: 's',
    publicationId: op,
  })
  expect(skillTrashPath('s', op)).toBe(`skills/.trash/s-${op}`)
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
      expect(encodeLegacyContent(decodeSkillPath(path, storage))).toBe(path)
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
    expect(encodeLegacyContent(decodeSkillTree('s', tree, 'SKILL.md'))).toEqual({
      skillId: 's',
      tree,
      path: 'SKILL.md',
    })
})

test('hosted object, archive, retention and plugin strings re-encode byte-identically', () => {
  const object = { id: '12345678-1234-1234-1234-123456789abc', size: 0, sha256: 'a'.repeat(64) }
  const objectRef = `aw-object:v2:employee-input:${object.id}:0:${object.sha256}`
  expect(hostedObjectReference('employee-input', object)).toBe(objectRef)
  expect(encodeLegacyContent(decodeHostedObject('employee-input', objectRef))).toBe(objectRef)
  for (const path of [
    'cs-archive:tasks/.tmp-t/db/tasks.jsonl',
    'cs-archive:runs/t',
    'cs-archive:logs/t',
  ])
    expect(encodeLegacyContent(decodeHostedArchive(path))).toBe(path)
  expect(taskRetentionReference('owner x', 'child', 'logs')).toBe(
    'aw-hosted-task-retention:owner%20x/child/logs',
  )
  const retention = 'aw-hosted-task-retention:owner%2fx/child/logs'
  expect(encodeLegacyContent(decodeTaskRetention(retention))).toBe(retention)
  expect(pluginGenerationReference('p', 'g')).toBe('cs-plugin:p/g')
  expect(pluginCachedReference('cs-plugin:p/g', 'dir/a')).toBe('cs-plugin:p/g/dir%2Fa')
  for (const path of ['cs-plugin:p/g', 'cs-plugin:p/g/dir%2fa'])
    expect(encodeLegacyContent(decodePlugin(path))).toBe(path)
})
