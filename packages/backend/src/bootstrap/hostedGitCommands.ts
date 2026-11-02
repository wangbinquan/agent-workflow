// RFC-427: the hosted Git credential helpers behind `agent-workflow __hosted-git-credential` / `__hosted-git-ssh`. The
// source-control composition still loads on demand, as it did when `main.ts` imported it directly.
type ProcessEnvironment = Readonly<Record<string, string | undefined>>

export async function runHostedGitCredentialCommand(
  operation: string,
  stdin: string,
  env: ProcessEnvironment,
): Promise<string> {
  const { hostedGitCredentialResponse } =
    await import('@/modules/source-control/composition/crewstationGitCredentials')
  return hostedGitCredentialResponse(operation, stdin, env)
}

export async function runHostedGitSshCommand(
  argv: readonly string[],
  env: ProcessEnvironment,
): Promise<number> {
  const { runHostedGitSsh } =
    await import('@/modules/source-control/composition/crewstationGitCredentials')
  return runHostedGitSsh(argv, env)
}
