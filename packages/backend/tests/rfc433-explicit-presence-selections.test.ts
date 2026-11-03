// RFC-433: the last seven optional deployment selections are stated by both profiles. Two have a real standalone
// value — the local execution authority, and the secret box opened after the startup lock — and five are hosted-only
// capabilities the standalone profile states as `null`. These cases lock the standalone behaviour that used to hide
// behind "not given": the local authority gates nothing (the session's activation gate hands its factories back
// unchanged), and the secret box factory touches `secret.key` only when called, never when the profile is built.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { standaloneSelections } from '@/bootstrap/standalone'
import { startOnExecutionActive } from '@/bootstrap/executionActivation'
import type { DaemonProviderRuntimeHandleFactory } from '@/bootstrap/daemonProviderRuntimeSession'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc433-presence-'))
  roots.push(root)
  return root
}

test('the standalone profile states the five hosted-only capabilities as null', () => {
  const selections = standaloneSelections({ appHome: home() })
  expect(selections.databaseInstallation).toBeNull()
  expect(selections.repositoryRemote).toBeNull()
  expect(selections.crewStationEvents).toBeNull()
  expect(selections.repositoryCandidateEffects).toBeNull()
  expect(selections.conflictMergeWorkspaceEffects).toBeNull()
})

test('the standalone execution authority is active and never gates a background factory', async () => {
  const authority = standaloneSelections({ appHome: home() }).executionAuthority
  const state = authority.current()
  if (state.kind !== 'active') throw new Error('the standalone authority must be active from start')
  expect(await authority.whenActive()).toBe(state.fence)
  const factory: DaemonProviderRuntimeHandleFactory = Object.freeze({
    id: 'rfc433-probe',
    start: () => ({ stop: () => undefined, drain: async () => undefined }),
  })
  // The session wraps every runtime and background factory in this gate; for the local authority it is the
  // factory itself, so a standalone daemon starts its background set exactly as when it stated no authority.
  expect(
    startOnExecutionActive(authority, factory, () => {
      throw new Error('a standalone authority never fails activation')
    }),
  ).toBe(factory)
  let lost = false
  const unsubscribe = authority.onLost(() => {
    lost = true
  })
  expect(typeof unsubscribe).toBe('function')
  unsubscribe()
  expect(lost).toBe(false)
})

test('the standalone secret box opens secret.key only when called, and every call reads the same key', () => {
  const appHome = home()
  const selections = standaloneSelections({ appHome })
  expect(typeof selections.secretBox).toBe('function')
  // Built before the startup lock: nothing is written yet.
  expect(readdirSync(appHome)).toEqual([])
  const first = selections.secretBox()
  expect(existsSync(join(appHome, 'secret.key'))).toBe(true)
  const second = selections.secretBox()
  expect(second.unseal(first.seal('rfc433'))).toBe('rfc433')
})
