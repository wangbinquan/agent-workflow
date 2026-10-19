// RFC-370 §10 V18 (c) — a digital employee action checks its workspace through
// the selected workspace implementation.
//
// Why these tests exist: RFC-370 hosted sweep (2026-10-19). The action runners
// checked `existsSync(join(workspacePath, '.git'))` and the input mounts on the
// service filesystem, while a hosted action scene is a `cs-workspace:` volume
// reference: every analyze / implement action failed `de-workspace-unavailable`.
// The runners now ask the environment's `workspaceEntries`; a standalone
// daemon still checks its own filesystem.
import { expect, test } from 'bun:test'
import {
  createAgentActionExecutionRunner,
  createScriptActionExecutionRunner,
  type ActionExecutionEnvironment,
} from '@/modules/task-execution/composition/actionExecutionRunners'

const SCENE = 'cs-workspace:development%3Ashared/tmp/actions/01M5/ws'
const MOUNT = '.agent-workflow/inputs/seed'

function environment(present: ReadonlySet<string>) {
  const checks: [string, string][] = []
  const env = {
    agents: { get: async () => null },
    workspaceEntries: {
      exists: async (workspacePath: string, relativePath: string) => {
        checks.push([workspacePath, relativePath])
        return present.has(relativePath)
      },
    },
  } as unknown as ActionExecutionEnvironment
  return { env, checks }
}

const launch = {
  workspacePath: SCENE,
  baselineSha: 'a'.repeat(40),
  platformInputPaths: [MOUNT],
  agentId: 'agent-1',
} as never

test('a hosted action scene with its checkout and mounts passes the workspace check without local files', async () => {
  const { env, checks } = environment(new Set(['.git', MOUNT]))
  const result = await createAgentActionExecutionRunner(env).launch(launch)
  // The check passed; the next step (the agent lookup) answered.
  expect(result).toMatchObject({ ok: false, failure: { code: 'de-agent-unavailable' } })
  expect(checks).toEqual([
    [SCENE, '.git'],
    [SCENE, MOUNT],
  ])
})

test('a scene without its checkout, or an agent action without its mount, is unavailable', async () => {
  const noCheckout = environment(new Set([MOUNT]))
  expect(await createAgentActionExecutionRunner(noCheckout.env).launch(launch)).toMatchObject({
    ok: false,
    failure: { code: 'de-workspace-unavailable' },
  })
  const noMount = environment(new Set(['.git']))
  expect(await createAgentActionExecutionRunner(noMount.env).launch(launch)).toMatchObject({
    ok: false,
    failure: { code: 'de-input-mount-missing' },
  })
  // Script actions check the checkout only.
  const script = environment(new Set())
  expect(await createScriptActionExecutionRunner(script.env).launch(launch)).toMatchObject({
    ok: false,
    failure: { code: 'de-workspace-unavailable' },
  })
  expect(script.checks).toEqual([[SCENE, '.git']])
})
