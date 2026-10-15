// RFC-370 M0 — resource capabilities a CrewStation-hosted control plane does not
// offer yet. Installing a plugin needs npm / git and lands in the agent runtime
// configuration, and resource packages carry plugins and skill trees through
// the local artifact funnel; both arrive with the CrewStation native
// configuration overlay (v2 §4, M2). Until then they are refused explicitly
// with the reason, never degraded silently.
import { DomainError } from '@/util/errors'
import type {
  ResourcePackagePluginArtifactOwner,
  ResourcePackageSkillArtifactOwner,
} from '../../application/package/artifactOwners'
import type { PluginInstallerPort } from '../../application/plugins/ports'

export type HostedUnavailableFeature = 'plugin-install' | 'resource-package-apply'

export class HostedCapabilityUnavailableError extends DomainError {
  constructor(capability: HostedUnavailableFeature) {
    super(
      'hosted-capability-unavailable',
      capability === 'plugin-install'
        ? 'Installing plugins is not available on this CrewStation-hosted deployment yet'
        : 'Applying resource packages is not available on this CrewStation-hosted deployment yet',
      503,
      { capability },
    )
    this.name = 'HostedCapabilityUnavailableError'
  }
}

export function createHostedPluginInstaller(): PluginInstallerPort {
  return Object.freeze({
    install: () => Promise.reject(new HostedCapabilityUnavailableError('plugin-install')),
    checkForUpdate: () => Promise.reject(new HostedCapabilityUnavailableError('plugin-install')),
  } satisfies PluginInstallerPort)
}

/** Planning refuses before any artifact or row is written, so nothing needs compensation. */
export function createHostedResourcePackageArtifacts(): {
  readonly skills: ResourcePackageSkillArtifactOwner
  readonly plugins: ResourcePackagePluginArtifactOwner
} {
  const refuse = (): never => {
    throw new HostedCapabilityUnavailableError('resource-package-apply')
  }
  const nothingStaged = async (): Promise<void> => {}
  return Object.freeze({
    skills: Object.freeze({
      planCreate: refuse,
      planUpdate: refuse,
      compensate: nothingStaged,
      rollForward: nothingStaged,
      afterCommitted: nothingStaged,
    } satisfies ResourcePackageSkillArtifactOwner),
    plugins: Object.freeze({
      planInstall: refuse,
      compensate: nothingStaged,
      rollForward: nothingStaged,
      afterCommitted: nothingStaged,
    } satisfies ResourcePackagePluginArtifactOwner),
  })
}
