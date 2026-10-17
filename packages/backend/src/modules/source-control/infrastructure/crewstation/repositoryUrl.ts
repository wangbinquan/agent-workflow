/** The task receives a public location. Authentication is supplied separately
 * by the platform; SSH usernames identify the account and are not secrets. */
export function assertHostedRepositoryUrl(value: string): void {
  if (
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('hosted-repository-remote-url-required')
  if (URL.canParse(value)) {
    const url = new URL(value)
    if (
      !['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) ||
      url.hostname === '' ||
      url.password !== '' ||
      (url.username !== '' && url.protocol !== 'ssh:')
    )
      throw new Error('hosted-repository-requires-remote-url-and-platform-credentials')
    return
  }
  if (!/^[^/@:\s]+@[^/:\s]+:[^\s]+$/.test(value))
    throw new Error('hosted-repository-remote-url-required')
}
