import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, resolve, sep } from 'node:path'

import { runProcess } from '../core/process'

export async function handleGitSmartHttp(input: {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  body: Buffer
  gitRoot: string
  routePrefix: string
  /** Optional provider-shaped alias resolved by the code-host store. */
  repositoryPath?: string
}): Promise<void> {
  const effectiveGitRoot =
    input.repositoryPath === undefined ? input.gitRoot : dirname(input.repositoryPath)
  const rawPath =
    input.repositoryPath === undefined
      ? decodeURIComponent(input.url.pathname.slice(input.routePrefix.length) || '/')
      : `/${basename(input.repositoryPath)}${decodeURIComponent(
          input.url.pathname.slice(input.routePrefix.length),
        )}`
  const relativePath = rawPath.replace(/^\/+/, '')
  const resolved = resolve(effectiveGitRoot, relativePath.split('/').join(sep))
  if (resolved !== effectiveGitRoot && !resolved.startsWith(`${effectiveGitRoot}${sep}`)) {
    input.response.writeHead(400)
    input.response.end('git path escapes mock root')
    return
  }

  const result = await runProcess('git', ['http-backend'], {
    input: input.body,
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: effectiveGitRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_HTTP_RECEIVE_PACK: '1',
      PATH_INFO: `/${relativePath}`,
      QUERY_STRING: input.url.searchParams.toString(),
      REQUEST_METHOD: input.request.method ?? 'GET',
      CONTENT_TYPE: input.request.headers['content-type'] ?? '',
      CONTENT_LENGTH: String(input.body.length),
      HTTP_CONTENT_ENCODING: input.request.headers['content-encoding'] ?? '',
      REMOTE_ADDR: '127.0.0.1',
      REMOTE_USER: 'system-mock',
    },
  })
  if (result.exitCode !== 0 && result.stdout.length === 0) {
    input.response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    input.response.end(result.stderr)
    return
  }

  const crlf = result.stdout.indexOf('\r\n\r\n')
  const lf = crlf === -1 ? result.stdout.indexOf('\n\n') : -1
  const headEnd = crlf === -1 ? lf : crlf
  const separatorLength = crlf === -1 ? 2 : 4
  if (headEnd < 0) {
    input.response.writeHead(500)
    input.response.end('git http-backend returned no CGI headers')
    return
  }
  let status = 200
  const headers: Record<string, string> = {}
  for (const line of result.stdout.subarray(0, headEnd).toString('utf8').split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200
    else headers[name] = value
  }
  input.response.writeHead(status, headers)
  input.response.end(result.stdout.subarray(headEnd + separatorLength))
}

export function gitRemoteUrl(baseUrl: string, gitRoot: string, repositoryPath: string): string {
  const realRoot = resolve(gitRoot)
  const realRepository = resolve(repositoryPath)
  if (realRepository !== realRoot && !realRepository.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`repository '${repositoryPath}' is outside mock git root '${gitRoot}'`)
  }
  const relative = realRepository.slice(realRoot.length).split(sep).join('/').replace(/^\/+/, '')
  return `${baseUrl}/git/${relative}`
}
