import type { EpochDeployment } from '@/platform/persistence/migration/run/types'

/** Persistence records the deployment; execution asks for its actual mechanisms. */
const capabilities = {
  standalone: {
    localPaths: true,
    pointerActivation: true,
    restoreLocalFiles: true,
    externalSwitch: false,
  },
  crewstation: {
    localPaths: false,
    pointerActivation: false,
    restoreLocalFiles: false,
    externalSwitch: true,
  },
} as const
export function epochDeploymentCapabilities(deployment: EpochDeployment) {
  return capabilities[deployment]
}
