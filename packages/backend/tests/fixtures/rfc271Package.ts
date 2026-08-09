// RFC-271 —— 共享的「工作组包」测试载体。
//
// 抽出来是因为它被两处需要：`rfc271-import-commit.test.ts` 的导入决策用例，与
// `rfc271-overwrite-ownership.test.ts` 的归属边界用例。两边必须用**同一个**包，
// 否则「覆盖别人的被拒」这类断言可能只是因为两边的包长得不一样。

import { encodeZip } from '../../src/util/zip'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const workgroupManifest = `formatVersion: 1
exportedAt: 0
root:
  slug: workgroup-squad
  type: workgroup
  name: squad
resources:
  - slug: workgroup-squad
    type: workgroup
    name: squad
requirements:
  humanMembers:
    - alice
secrets: []
danglingCallRefs: []
`

export const buildWorkgroupPackageZip = (): Uint8Array =>
  encodeZip([
    { path: 'manifest.yaml', bytes: utf8(workgroupManifest) },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'workgroup-create',
              slug: 'workgroup-squad',
              payload: {
                name: 'squad',
                description: '',
                instructions: '',
                mode: 'free_collab',
                switches: { shareOutputs: true, directMessages: false, blackboard: false },
                maxRounds: 20,
                completionGate: false,
                clarifyBudget: 3,
                fanOut: false,
                members: [
                  {
                    memberType: 'human',
                    username: 'alice',
                    displayName: 'reviewer',
                    roleDesc: 'reviews',
                    sortOrder: 0,
                  },
                ],
                leaderDisplayName: null,
              },
            },
          ],
          rootRef: 'local:workgroup-squad',
        }),
      ),
    },
  ])
