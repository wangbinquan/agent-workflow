// RFC-394: the standalone profile owns local dependency probes and their existing diagnostics.
import { detectGitCapabilities, mergeTreeGateError, MIN_GIT_VERSION } from '@/services/gitVersion'
import { getRuntimeDriver } from '@/services/runtime'
import type { DeploymentProfile } from './deploymentProfile'

export function composeStandaloneProfile(): DeploymentProfile {
  return {
    kind: 'standalone',
    requiredProvider: null,
    listen: {},
    selections: {},
    async probeHost({ log, config }) {
      // 4. git version probe — RFC-130 D7: every node run merge-backs via
      // `git merge-tree --write-tree` (git >= 2.38). On older git the daemon boots
      // fine and every task dies at merge-back (AFTER its agent already ran) with a
      // cryptic `merge-back-failed: git merge-tree: usage: ...` — refuse at boot
      // instead. Unlike optional agent runtimes, git is a platform dependency for
      // repository/worktree/snapshot/merge-back operations. Side effect: populate
      // the RFC-034 capability cache read by resolveSubmoduleParams.
      const gitCaps = await detectGitCapabilities()
      const gitGateError = mergeTreeGateError(gitCaps)
      if (gitGateError !== null) {
        log.error('git incompatible', {
          found: gitCaps.version?.raw ?? null,
          requiredMinimum: MIN_GIT_VERSION,
        })
        return (
          `agent-workflow: ${gitGateError}\n` +
          `  upgrade git to >= ${MIN_GIT_VERSION} and restart; the daemon's PATH must resolve the upgraded binary.`
        )
      }
      log.info('git probe ok', { version: gitCaps.version?.raw ?? null })

      // RFC-111 D10: claude-code is optional — probe it SOFT (warn only, NEVER
      // refuse to start) when it is the configured default. RFC-226 makes OpenCode
      // optional too, but deliberately does not probe it here at all: its
      // version/build admission belongs to explicit runtime validation and use.
      if (config.defaultRuntime === 'claude-code') {
        const ccDriver = getRuntimeDriver('claude-code')
        const claudeProbe = await ccDriver.probe(ccDriver.defaultBinary(config)[0]!)
        if (!claudeProbe.compatible) {
          log.warn('claude-code default runtime unavailable (nodes selecting it will fail)', {
            binary: claudeProbe.binary,
            found: claudeProbe.version,
            requiredMinimum: ccDriver.minVersion,
            reason: claudeProbe.incompatibleReason ?? 'not found',
          })
        } else {
          log.info('claude-code probe ok', {
            version: claudeProbe.version,
            binary: claudeProbe.binary,
          })
        }
      }

      return null
    },
  }
}
