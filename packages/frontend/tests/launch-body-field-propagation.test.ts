// RFC-125 follow-up bug fix — `buildLaunchBody` / `buildLaunchBodyMultiRepo`
// whitelist the POST /api/tasks body and previously DROPPED `workingBranch` /
// `autoCommitPush` (RFC-075) + `collaboratorUserIds` (RFC-036) on the no-upload
// single-repo + multi-repo + url+upload(V2) paths — so those shipped features
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

const urlSource = { kind: 'url' as const, repoUrl: 'https://x/r.git', ref: '' }
const full: LaunchCommonPayload = {
  workflowId: 'wf',
  name: 't',
  inputs: {},
  workingBranch: 'feat/x',
  autoCommitPush: true,
  collaboratorUserIds: ['u1', 'u2'],
}

function expectExtras(body: Record<string, unknown>) {
  expect(body.workingBranch).toBe('feat/x')
  expect(body.autoCommitPush).toBe(true)
  expect(body.collaboratorUserIds).toEqual(['u1', 'u2'])
}

describe('launch body helpers stamp all launchCommon extras onto the wire', () => {
  test('buildLaunchBody carries workingBranch/autoCommitPush/collaborators', () => {
    expectExtras(buildLaunchBody(urlSource, full))
  })

  test('buildLaunchBodyMultiRepo carries them too', () => {
    expectExtras(buildLaunchBodyMultiRepo([urlSource], full))
  })

  test('omits extras when blank / false / empty (byte-identical legacy wire)', () => {
    const bare: LaunchCommonPayload = { workflowId: 'wf', name: 't', inputs: {} }
    const b = buildLaunchBody(urlSource, bare)
    expect(b.workingBranch).toBeUndefined()
    expect(b.autoCommitPush).toBeUndefined()
    expect(b.collaboratorUserIds).toBeUndefined()
    // empty collaborator array is also omitted (mirrors launchCommon's length>0 spread)
    expect(
      buildLaunchBody(urlSource, {
        workflowId: 'wf',
        name: 't',
        inputs: {},
        collaboratorUserIds: [],
      }).collaboratorUserIds,
    ).toBeUndefined()
  })
})
