// Shared backend test isolation.
//
// `--isolate` gives every file a fresh global object, while cases inside one
// file still share process.env and cwd. Snapshot after suite-level beforeAll
// hooks and restore after each case so randomized neighbors inherit the suite
// baseline rather than the previous case's mutations.

import { afterEach, beforeEach } from 'bun:test'

let envAtTestStart: NodeJS.ProcessEnv | undefined
let cwdAtTestStart: string | undefined

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(snapshot, key)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(() => {
  envAtTestStart = { ...process.env }
  cwdAtTestStart = process.cwd()
})

afterEach(() => {
  const env = envAtTestStart
  const cwd = cwdAtTestStart
  envAtTestStart = undefined
  cwdAtTestStart = undefined
  if (env !== undefined) restoreEnv(env)
  if (cwd !== undefined && process.cwd() !== cwd) process.chdir(cwd)
})
