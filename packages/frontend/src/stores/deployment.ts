// RFC-370 M0 — the deployment the serving daemon states in index.html.
//
// A CrewStation-hosted page carries `<meta name="agent-workflow-deployment"
// content="crewstation">`: the platform gateway authenticates every request,
// so the SPA holds no local credential and never shows the local sign-in,
// first-administrator setup or database provider controls. Pages without the
// marker (standalone daemons, the Vite dev server) behave exactly as before.

export type DeploymentMode = 'standalone' | 'crewstation'

export const DEPLOYMENT_META_NAME = 'agent-workflow-deployment'

let cached: DeploymentMode | undefined

export function readDeploymentMode(doc?: Pick<Document, 'querySelector'>): DeploymentMode {
  const source = doc ?? (typeof document === 'undefined' ? undefined : document)
  const content = source
    ?.querySelector(`meta[name="${DEPLOYMENT_META_NAME}"]`)
    ?.getAttribute('content')
  return content === 'crewstation' ? 'crewstation' : 'standalone'
}

/** Read once per page load; the served document never changes its deployment. */
export function deploymentMode(): DeploymentMode {
  return (cached ??= readDeploymentMode())
}

/** True behind the CrewStation gateway: identity arrives with every request. */
export function isGatewayIdentity(): boolean {
  return deploymentMode() === 'crewstation'
}

/** Test seam: forget the cached mode after a test changes the document head. */
export function resetDeploymentModeForTest(): void {
  cached = undefined
}
