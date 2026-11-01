import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleGitSmartHttp } from '../../../packages/system-mocks/src/git/http'
import { command } from './io'

export interface GitFixtureServer {
  root: string
  repository: string
  remoteUrl: string
  stop(): Promise<void>
}

/** Only the disposable task repository is initialized; never the development checkout. */
export async function startGitServer(root: string, port = 0): Promise<GitFixtureServer> {
  const repository = join(root, 'business')
  mkdirSync(repository, { recursive: true })
  await command(['git', 'init', '-b', 'main', repository])
  await command(['git', '-C', repository, 'config', 'user.name', 'Release Upgrade Fixture'])
  await command([
    'git',
    '-C',
    repository,
    'config',
    'user.email',
    'release-upgrade@example.invalid',
  ])
  await command(['git', '-C', repository, 'config', 'http.receivepack', 'true'])
  await command(['git', '-C', repository, 'config', 'receive.denyCurrentBranch', 'updateInstead'])
  const files = {
    'README.md': '# Release upgrade business repository\n',
    'src/checkout.ts':
      'export function calculateTotal(subtotalCents: number): number { return subtotalCents * 1.13 }\n',
    'tests/checkout.contract.md': '# Checkout contract\n',
    'docs/customer-policy.md':
      '# Customer policy\nSource: approved customer policy.\nRetention period: 30 days.\n',
    'docs/partner-policy.md':
      '# Partner policy\nSource: approved partner policy.\nRetention period: 30 days.\n',
  }
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(repository, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, body)
  }
  await command(['git', '-C', repository, 'add', '--', ...Object.keys(files)])
  await command([
    'git',
    '-C',
    repository,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Seed isolated release-upgrade task repository',
  ])
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith('/git/')) {
        response.writeHead(404)
        response.end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      await handleGitSmartHttp({
        request,
        response,
        url,
        body: Buffer.concat(chunks),
        gitRoot: root,
        routePrefix: '/git',
      })
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', accept)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Git fixture server has no TCP address')
  return {
    root,
    repository,
    remoteUrl: `http://127.0.0.1:${address.port}/git/business`,
    stop: () =>
      new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      ),
  }
}
