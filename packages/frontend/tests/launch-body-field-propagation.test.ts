// RFC-125 follow-up bug fix — `buildLaunchBody` / `buildLaunchBodyMultiRepo`
// whitelist the POST /api/tasks body and previously DROPPED `workingBranch` /
// `autoCommitPush` (RFC-075) + `collaboratorUserIds` (RFC-036) on the no-upload
// single-repo + multi-repo + url+upload(V2) paths; only the path+uploads path's
// verbatim `buildLaunchFormData` spread carried them — so those shipped features
// were silently disabled on the most common launch. The prior launch-field tests
// only asserted the `launchCommon` SOURCE spread, never that the field reached the
// wire, which is exactly why the drop went unnoticed. These are the wire-level
// regression locks: every launchCommon "extra" must reach the actual body.

import { describe, expect, test } from 'vitest'
import {
  buildLaunchBody,
  buildLaunchBodyMultiRepo,
  type LaunchCommonPayload,
} from '../src/lib/launch-repo-source'

const pathSource = { kind: 'path' as const, repoPath: '/r', baseBranch: 'main' }
const urlSource = { kind: 'url' as const, repoUrl: 'https://x/r.git', ref: '' }
const full: LaunchCommonPayload = {
  workflowId: 'wf',
  name: 't',
  inputs: {},
  workingBranch: 'feat/x',
  autoCommitPush: true,
  collaboratorUserIds: ['u1', 'u2'],
  deferredQuestionDispatch: true,
}

function expectExtras(body: Record<string, unknown>) {
  expect(body.workingBranch).toBe('feat/x')
  expect(body.autoCommitPush).toBe(true)
  expect(body.collaboratorUserIds).toEqual(['u1', 'u2'])
  expect(body.deferredQuestionDispatch).toBe(true)
}

describe('launch body helpers stamp all launchCommon extras onto the wire', () => {
  test('buildLaunchBody (path) carries workingBranch/autoCommitPush/collaborators/deferred', () => {
    expectExtras(buildLaunchBody(pathSource, full))
  })

  test('buildLaunchBody (url) carries them too', () => {
    expectExtras(buildLaunchBody(urlSource, full))
  })

  test('buildLaunchBodyMultiRepo carries them too', () => {
    expectExtras(buildLaunchBodyMultiRepo([pathSource], full))
  })

  test('omits extras when blank / false / empty (byte-identical legacy wire)', () => {
    const bare: LaunchCommonPayload = { workflowId: 'wf', name: 't', inputs: {} }
    const b = buildLaunchBody(pathSource, bare)
    expect(b.workingBranch).toBeUndefined()
    expect(b.autoCommitPush).toBeUndefined()
    expect(b.collaboratorUserIds).toBeUndefined()
    expect(b.deferredQuestionDispatch).toBeUndefined()
    // empty collaborator array is also omitted (mirrors launchCommon's length>0 spread)
    expect(
      buildLaunchBody(pathSource, {
        workflowId: 'wf',
        name: 't',
        inputs: {},
        collaboratorUserIds: [],
      }).collaboratorUserIds,
    ).toBeUndefined()
  })
})
