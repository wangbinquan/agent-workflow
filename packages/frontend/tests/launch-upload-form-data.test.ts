// RFC-020 T6: buildLaunchFormDataV2 turns the launch form snapshot into a
// multipart body matching the backend's handleMultipartTaskStart contract.
// Pure-function tests so they stay fast and tied to the exact field shape.
// (RFC-165: the path-mode buildLaunchFormData helper is retired; the V2
// URL-mode builder carries the same payload/files[<key>][] envelope.)

import { describe, expect, test } from 'vitest'
import { buildLaunchFormDataV2, type RepoSource } from '../src/lib/launch-repo-source'

const SRC: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'main' }
const COMMON = { workflowId: 'wf1', name: 'fixture-task' }

function makeFile(name: string, body = 'x'): File {
  return new File([body], name, { type: 'text/plain' })
}

describe('buildLaunchFormDataV2 (RFC-020 envelope)', () => {
  test('writes payload JSON into the payload field', async () => {
    const fd = buildLaunchFormDataV2(SRC, { ...COMMON, inputs: { topic: 't' } }, {})
    const blob = fd.get('payload') as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toContain('application/json')
    const text = await blob.text()
    expect(JSON.parse(text)).toEqual({
      workflowId: 'wf1',
      name: 'fixture-task',
      repoUrl: 'git@h:o/r.git',
      ref: 'main',
      inputs: { topic: 't' },
    })
  })

  test('appends one files[<key>][] entry per File in order', () => {
    const fd = buildLaunchFormDataV2(
      SRC,
      { ...COMMON, inputs: { refs: '' } },
      { refs: [makeFile('a.txt'), makeFile('b.txt')] },
    )
    const all = fd.getAll('files[refs][]')
    expect(all).toHaveLength(2)
    expect((all[0] as File).name).toBe('a.txt')
    expect((all[1] as File).name).toBe('b.txt')
  })

  test('back-fills inputs[uploadKey]="" when missing', async () => {
    const fd = buildLaunchFormDataV2(
      SRC,
      { ...COMMON, inputs: { topic: 't' } },
      { refs: [makeFile('x.txt')] },
    )
    const payload = JSON.parse(await (fd.get('payload') as Blob).text())
    expect(payload.inputs).toEqual({ topic: 't', refs: '' })
  })

  test('uploads with two different keys produce two field names', () => {
    const fd = buildLaunchFormDataV2(
      SRC,
      { ...COMMON, inputs: {} },
      { refs: [makeFile('a.txt')], pics: [makeFile('p.png'), makeFile('q.png')] },
    )
    expect(fd.getAll('files[refs][]')).toHaveLength(1)
    expect(fd.getAll('files[pics][]')).toHaveLength(2)
  })

  test('empty uploads still emits the payload field', () => {
    const fd = buildLaunchFormDataV2(SRC, { ...COMMON, inputs: {} }, {})
    expect(fd.get('payload')).not.toBeNull()
    expect(fd.getAll('files[anything][]')).toHaveLength(0)
  })
})
