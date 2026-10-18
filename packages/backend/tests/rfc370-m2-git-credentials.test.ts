import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  compileHostedGitEnvironment,
  createHostedGitCommandEnvironment,
  createHostedGitAgentEnvironment,
  hostedGitCredentialResponse,
  sshGitTarget,
} from '@/modules/source-control/infrastructure/crewstation/gitCredentials'
import {
  parseHostedGitSshRequest,
  runHostedGitSsh,
  taskImageGitEnvironment,
} from '@/modules/source-control/infrastructure/crewstation/taskImageGitCredentials'
import { createHash } from 'node:crypto'
import {
  createHostedWorkspaceCommands,
  WorkspaceCommandUnknownError,
} from '@/modules/source-control/infrastructure/crewstation/workspaceCommands'
import type {
  CrewStationBusinessExecution,
  SubmitBusinessSubtask,
} from '@/platform/crewstation/businessExecution'
import {
  workspaceHelperArguments,
  workspaceResultPath,
} from '@/platform/crewstation/workspaceProtocol'
import { runGit } from '@/util/git'
import { describeEachProvider } from './helpers/eachProvider'

const id = '01a1428d-05f5-7000-9af3-aef7382bfe08'
const bindings = (url = 'https://git.test/owner/repo.git') =>
  JSON.stringify([{ kind: 'http', url, username: 'git-user', passwordSecretId: id }])
const runtime = (url?: string) => {
  const environment = compileHostedGitEnvironment(bindings(url))!
  return {
    AW_GIT_RUNTIME_BINDINGS: environment.AW_GIT_RUNTIME_BINDINGS as string,
    AW_GIT_AUTH_0: 'original-private-password',
  }
}

test('Agent Git keeps the frozen Secret reference and exact quoted identity without changing shared config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-agent-git-'))
  const gitName = "Developer's $(literal) ! name",
    gitEmail = 'developer@example.test'
  try {
    const selected = createHostedGitAgentEnvironment(bindings())({
      gitUserName: gitName,
      gitUserEmail: gitEmail,
    })!
    expect(selected.AW_GIT_AUTH_0).toEqual({ secret: { configDefinitionId: id } })
    const env = {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(selected).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(root, 'absent-global-config'),
    }
    for (const [key, expected] of [
      ['user.name', gitName],
      ['user.email', gitEmail],
      ['core.sshCommand', 'agent-workflow __hosted-git-ssh'],
      ['credential.useHttpPath', 'true'],
    ]) {
      const process = Bun.spawn(['git', 'config', '--get', key!], {
        cwd: root,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect((await new Response(process.stdout).text()).trim()).toBe(expected!)
      expect(await process.exited).toBe(0)
    }
    expect(existsSync(join(root, 'absent-global-config'))).toBe(false)
    expect(existsSync(join(root, '.git'))).toBe(false)
    expect(JSON.stringify(selected)).not.toContain('original-private-password')
    expect(createHostedGitAgentEnvironment(undefined)({})).toBeUndefined()
    expect(
      createHostedGitAgentEnvironment(undefined)({ gitUserName: gitName, gitUserEmail: gitEmail }),
    ).not.toHaveProperty('AW_GIT_RUNTIME_BINDINGS')
    expect(() =>
      createHostedGitAgentEnvironment(bindings())({
        gitUserName: 'name\ninjected',
        gitUserEmail: gitEmail,
      }),
    ).toThrow('identity-invalid')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('public Git bindings use individual Secret references and fixed operation admission', () => {
  const environment = compileHostedGitEnvironment(bindings())!
  expect(environment.AW_GIT_AUTH_0).toEqual({ secret: { configDefinitionId: id } })
  expect(JSON.stringify(environment)).not.toContain('original-private-password')
  const command = createHostedGitCommandEnvironment(bindings())
  for (const op of [
    'resolve-repository',
    'materialize-group',
    'candidate-push',
    'employee-case',
    'plugin-installation',
  ])
    expect(command(op)).toEqual(environment)
  // RFC-370 §9.2 V3: only coarse operations that reach a remote get Secrets;
  // local candidate derivation / staging / commit never do.
  for (const op of [
    'run-script',
    'read-json',
    'archive-task-files',
    'database-backup-workspace',
    'candidate-derive',
    'candidate-stage',
    'candidate-commit',
  ])
    expect(command(op)).toBeUndefined()
  expect(compileHostedGitEnvironment(undefined)).toBeUndefined()
  expect(() => compileHostedGitEnvironment(bindings('https://user:secret@git.test/repo'))).toThrow(
    'bindings-invalid',
  )
  expect(() =>
    compileHostedGitEnvironment(
      JSON.stringify([...JSON.parse(bindings()), ...JSON.parse(bindings())]),
    ),
  ).toThrow('target-duplicate')
  expect(() => compileHostedGitEnvironment('private malformed input')).toThrow(
    'hosted-git-credential-bindings-invalid',
  )
})

test('HTTP helper matches exact authority and repository, rejects protocol/control injection and ignores store', () => {
  const env = runtime(),
    request = 'protocol=https\nhost=GIT.TEST:443\npath=owner/repo.git\n\n'
  expect(hostedGitCredentialResponse('get', request, env)).toBe(
    'username=git-user\npassword=original-private-password\n',
  )
  for (const changed of [
    request.replace('https', 'http'),
    request.replace('GIT.TEST:443', 'other.test'),
    request.replace('repo.git', 'sibling.git'),
    request.replace('path=owner/repo.git', 'path='),
  ])
    expect(hostedGitCredentialResponse('get', changed, env)).toBe('')
  expect(hostedGitCredentialResponse('store', request, env)).toBe('')
  expect(
    hostedGitCredentialResponse('get', request, {
      ...env,
      AW_GIT_AUTH_0: 'secret\npassword=other',
    }),
  ).toBe('')
  expect(hostedGitCredentialResponse('get', request, { AW_GIT_RUNTIME_BINDINGS: 'invalid' })).toBe(
    '',
  )
  const git = taskImageGitEnvironment(env)
  expect(JSON.stringify(git)).not.toContain('original-private-password')
  expect(Object.values(git)).toContain('http.followRedirects')
  expect(Object.values(git)).toContain('credential.useHttpPath')
  expect(() =>
    taskImageGitEnvironment({ AW_GIT_RUNTIME_BINDINGS: env.AW_GIT_RUNTIME_BINDINGS }),
  ).toThrow('secret-unavailable')
  // RFC-370 acceptance (2026-10-17): CrewStation gives every task container the
  // project's configuration as environment, so the deployment's public binding
  // JSON is present even for commands that carry no credentials. It is never
  // read as runtime bindings: such a command runs without Git credentials
  // instead of failing with `hosted-git-credential-bindings-invalid`.
  expect(taskImageGitEnvironment({ AW_GIT_CREDENTIAL_BINDINGS: bindings() })).toEqual({})
  expect(taskImageGitEnvironment({ ...env, AW_GIT_CREDENTIAL_BINDINGS: bindings() })).toEqual(git)
})

test('SSH request identity includes the exact port, account and shell-quoted repository', async () => {
  expect(sshGitTarget('git@git.test:owner/repo.git')).toEqual({
    host: 'git.test',
    user: 'git',
    port: 22,
    path: 'owner/repo.git',
  })
  expect(sshGitTarget('ssh://deploy@git.test:2222/owner/repo.git').port).toBe(2222)
  expect(
    parseHostedGitSshRequest([
      '-p',
      '2222',
      '-o',
      'SendEnv=GIT_PROTOCOL',
      'deploy@git.test',
      "git-upload-pack '/owner/repo.git'",
    ]),
  ).toMatchObject({ port: 2222, user: 'deploy', path: '/owner/repo.git' })
  for (const argv of [
    ['-o', 'ProxyCommand=evil', 'git.test', "git-upload-pack 'repo'"],
    ['git.test', "git-upload-pack 'repo'; echo private"],
    ['git.test', 'sh'],
    ['git.test', "git-upload-pack 'repo'", 'extra'],
  ])
    expect(() => parseHostedGitSshRequest(argv)).toThrow('request-invalid')
  expect(await runHostedGitSsh(['git.test', "git-upload-pack 'other'"], {})).toBe(255)
})

test('SSH sends only the bound key with pinned host verification and removes it after process exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-ssh-fixture-'))
  const receipt = join(root, 'receipt.json'),
    script = join(root, 'ssh.ts')
  try {
    writeFileSync(
      script,
      `import { readFileSync, statSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), key = args[args.indexOf('-i') + 1];
writeFileSync(process.env.SSH_FIXTURE_RECEIPT!, JSON.stringify({ key, mode: statSync(key).mode & 0o777,
validKey: readFileSync(key, 'utf8') === 'synthetic-private-key', args,
leaked: Object.keys(process.env).filter(k => k.startsWith('AW_GIT_')) }));
process.exit(17);
`,
    )
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    writeFileSync(
      join(root, 'ssh'),
      `#!/bin/sh\nexec ${quote(process.execPath)} run ${quote(script)} "$@"\n`,
      { mode: 0o755 },
    )
    const publicEnv = compileHostedGitEnvironment(
      JSON.stringify([
        {
          kind: 'ssh',
          url: 'ssh://deploy@git.test:2222/owner/repo.git',
          privateKeySecretId: id,
          knownHosts: '[git.test]:2222 ssh-ed25519 fixture-public-key\n',
        },
      ]),
    )!
    const env = {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      SSH_FIXTURE_RECEIPT: receipt,
      AW_GIT_RUNTIME_BINDINGS: publicEnv.AW_GIT_RUNTIME_BINDINGS as string,
      AW_GIT_AUTH_0: 'synthetic-private-key',
    }
    expect(
      await runHostedGitSsh(
        ['-p', '2222', 'deploy@git.test', "git-upload-pack '/owner/repo.git'"],
        env,
      ),
    ).toBe(17)
    const observed = JSON.parse(readFileSync(receipt, 'utf8'))
    expect(observed).toMatchObject({ mode: 0o600, validKey: true, leaked: [] })
    expect(observed.args).toContain('StrictHostKeyChecking=yes')
    expect(observed.args).toContain('IdentityAgent=none')
    expect(existsSync(observed.key)).toBe(false)
    for (const request of [
      ['-p', '22', 'deploy@git.test', "git-upload-pack '/owner/repo.git'"],
      ['-p', '2222', 'other@git.test', "git-upload-pack '/owner/repo.git'"],
      ['-p', '2222', 'deploy@evil.test', "git-upload-pack '/owner/repo.git'"],
      ['-p', '2222', 'deploy@git.test', "git-upload-pack '/owner/sibling.git'"],
    ])
      expect(await runHostedGitSsh(request, env)).toBe(255)
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual(observed)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the task-image credential helper authorizes a real private HTTP clone without persisting its credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-private-git-'))
  const repo = join(root, 'origin'),
    work = join(root, 'work')
  mkdirSync(repo)
  mkdirSync(work)
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    for (const args of [
      ['init', '-b', 'main'],
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'private',
      ],
      ['update-server-info'],
    ]) {
      const result = await runGit(repo, args)
      expect(result.exitCode).toBe(0)
    }
    let authorized = 0
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (
          request.headers.get('authorization') !==
          `Basic ${Buffer.from('git-user:original-private-password').toString('base64')}`
        )
          return new Response('authentication required', {
            status: 401,
            headers: { 'www-authenticate': 'Basic realm="fixture"' },
          })
        authorized++
        const path = new URL(request.url).pathname.replace(/^\/repo.git\//, '')
        const file = resolve(repo, '.git', path)
        if (!file.startsWith(join(repo, '.git') + '/')) return new Response('', { status: 404 })
        const content = Bun.file(file)
        return (await content.exists()) ? new Response(content) : new Response('', { status: 404 })
      },
    })
    const url = `http://127.0.0.1:${server.port}/repo.git`
    const env = { ...process.env, ...runtime(url) }
    // Invoke the actual CLI helper protocol through Git, with its fixed task
    // environment. The fixture directory is unrelated to the shared checkout.
    const result = await runGit(work, ['clone', '--', url, 'copy'], {
      env: { ...env, ...taskImageGitEnvironment(env) },
      timeoutMs: 30_000,
    })
    expect(result.exitCode).toBe(0)
    expect(authorized).toBeGreaterThan(0)
    expect(readFileSync(join(work, 'copy/.git/config'), 'utf8')).not.toContain(
      'original-private-password',
    )
    expect(result.stdout + result.stderr).not.toContain('original-private-password')
    expect((await runGit(join(work, 'copy'), ['rev-parse', 'HEAD'])).stdout).toBe(
      (await runGit(repo, ['rev-parse', 'HEAD'])).stdout,
    )
  } finally {
    await server?.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)

describeEachProvider('RFC-370 hosted Git credentials on cold command replay', (harness) => {
  test('cold command replay adopts its original Secret references without reading rotated deployment bindings', async () => {
    let rotated = false,
      environmentReads = 0,
      lose = true
    const submits: SubmitBusinessSubtask[] = []
    const executionId = 'command:task:one'
    const resultPath = workspaceResultPath(createHash('sha256').update(executionId).digest('hex'))
    const unused = async (): Promise<never> => {
      throw new Error('unexpected platform call')
    }
    const subtask = {
      id: 'physical',
      taskId: 'parent',
      kind: 'command' as const,
      attempt: 1,
      state: 'running',
      executionId: 'exec',
    }
    const api: CrewStationBusinessExecution = {
      createTask: unused,
      getTask: unused,
      closeTask: unused,
      finalizeTask: unused,
      pauseTask: unused,
      resumeTask: unused,
      listSubtasks: unused,
      createMaterial: unused,
      getSubtask: unused,
      cancelSubtask: unused,
      listFiles: unused,
      async submitSubtask(_task, request) {
        submits.push(request)
        if (lose) {
          lose = false
          throw new Error('lost response')
        }
        return subtask
      },
      async events() {
        return {
          items: [
            {
              taskId: 'parent',
              subtaskId: 'physical',
              attempt: 1,
              cursor: 'end',
              sourceEventId: 'end',
              occurredAt: new Date(0).toISOString(),
              type: 'result',
              data: {
                exitCode: 0,
                reason: 'exited',
                stdout: '',
                stderr: '',
                truncated: false,
                finalCursor: 'end',
              },
            },
          ],
          hasMore: false,
          nextCursor: 'end',
        }
      },
      streamEvents: () => {
        throw new Error('unexpected stream')
      },
      async readFile(_task, query) {
        expect(query.path).toBe(resultPath.slice('/work/'.length))
        const content = Buffer.from('{"ok":true,"value":{"done":true}}')
        return {
          path: query.path,
          version: 'v',
          size: content.length,
          offset: 0,
          contentBase64: content.toString('base64'),
          nextOffset: null,
        }
      },
    }
    const helper = () =>
      createHostedWorkspaceCommands({
        db: harness.db,
        fence: {
          current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
          assertHeld: async () => undefined,
        },
        api,
        workspaces: { ensure: async () => ({ businessTaskId: 'parent' }) },
        commandEnvironment: () => {
          environmentReads++
          if (rotated) throw new Error('must not reread current mapping')
          return compileHostedGitEnvironment(bindings())
        },
      })
    await expect(
      helper().call(
        'task',
        'resolve-repository',
        { url: 'https://git.test/owner/repo.git' },
        { operationId: 'one' },
      ),
    ).rejects.toBeInstanceOf(WorkspaceCommandUnknownError)
    rotated = true
    expect(
      await helper().call(
        'task',
        'resolve-repository',
        { url: 'https://git.test/owner/repo.git' },
        { operationId: 'one' },
      ),
    ).toEqual({ done: true })
    expect(environmentReads).toBe(1)
    expect(submits).toHaveLength(2)
    for (const request of submits)
      expect(request).toMatchObject({
        env: { AW_GIT_AUTH_0: { secret: { configDefinitionId: id } } },
        argv: workspaceHelperArguments(
          'resolve-repository',
          { url: 'https://git.test/owner/repo.git' },
          resultPath,
        ),
      })
    await expect(
      helper().call(
        'task',
        'resolve-repository',
        { url: 'https://git.test/other.git' },
        { operationId: 'one' },
      ),
    ).rejects.toThrow('replay-mismatch')
  })
})
