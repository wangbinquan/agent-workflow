// RFC-319 REPO-42 —— SSH 协议的仓库接入：真的用 ssh 传输 clone 一次。
//
// 为什么这条测试存在：`ssh://` 与 scp 式 URL 是 `parseGitUrl` 的一等形态
// （packages/shared/src/git-url.ts:59-84 的 `ssh-uri`、:140 的 `ssh-scp`），
// doctor 也把 ssh 列为「ssh:// 远端需要」的可选前置（cli/doctor.ts:307-324）。
// 但在这条用例之前，**全仓没有任何一处真的经由 ssh 传输取过一次仓**：
// `ssh://` 只出现在 URL 解析、脱敏、provider 判定的单测里，全部止步于字符串。
// 唯一的端到端占位是 e2e/git-protocols.spec.ts 里一个空的 `describe.skip`
// 外壳（只有注释，没有断言），它连自己都没运行过。
//
// 「用不了真 sshd」不是不能测的理由：git 的 ssh 传输本来就是「把
// `git-upload-pack <path>` 交给 GIT_SSH_COMMAND 去执行」，所以拿一个**桩 ssh**
// 就地执行那条命令，走的仍然是 git 自己的 ssh transport 分支——URL 解析、
// 传输选择、GIT_SSH_COMMAND 组装全都是生产代码路径，只有「传输到哪台机器」被
// 换成了本机。这正是本条要锁的那一段。
//
// 它顺带锁住了本产品的**部署密钥机制**：本仓没有「按仓登记 deploy key」这个功能
// （`deploy_key` / `deployKey` 全仓零命中），运维交付私钥的唯一途径就是给 daemon
// 环境设 `GIT_SSH_COMMAND="ssh -i <key>"`，由 util/git.ts:38-44 层叠保留下来。
// 既有的 git-noninteractive-env.test.ts 只验证了**那个 env 构造函数**本身会保留
// `-i`；它证明不了真正 clone 的时候这份 env 有没有被用上。所以这里断言的是桩 ssh
// **确实收到了** `-i <key>`——那是「部署密钥能不能用」的唯一机器判据。

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { resolveCachedRepo } from '../src/services/gitRepoCache'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// 真 git clone + 真进程，和 git-repo-cache.test.ts 同一档预算。
setDefaultTimeout(60_000)

/** 这台「远端」的主机名是不可解析的保留域：一旦桩 ssh 没被用上，就只能失败。 */
const FIXTURE_HOST = 'ssh-fixture.invalid'

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(' ')} 失败: ${await new Response(proc.stderr).text()}`)
  }
}

/**
 * 桩 ssh：把 `ssh [-o k=v]… <host> <cmd…>` 里的 `<cmd…>` 就地在本机执行。
 *
 * git 侧走的仍是完整的 ssh transport 分支（它并不知道对端是不是真机器），
 * 所以被验证的是产品把 URL 交给 git 的那一段，而不是 openssh 本身。
 * 每次调用把**完整 argv** 追加进日志——`-i <key>` 有没有活着传到这里，是
 * 「部署密钥能不能用」唯一看得见的证据。
 */
function writeStubSsh(dir: string): { path: string; log: string } {
  const log = join(dir, 'ssh-calls.log')
  const path = join(dir, 'stub-ssh')
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "argv: $*" >> ${JSON.stringify(log)}
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -i) shift 2 ;;
    -*) shift ;;
    *) host="$1"; shift; break ;;
  esac
done
printf '%s\\n' "host=$host cmd=$*" >> ${JSON.stringify(log)}
exec /bin/sh -c "$*"
`,
    'utf-8',
  )
  chmodSync(path, 0o755)
  return { path, log }
}

describe('RFC-319 REPO-42 —— ssh 传输的仓库接入', () => {
  let db: DbClient
  let appHome: string
  let fixture: string
  let bare: string
  let stub: { path: string; log: string }
  let prevSshCommand: string | undefined

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-ssh-home-'))
    fixture = mkdtempSync(join(tmpdir(), 'aw-ssh-fixture-'))
    const working = join(fixture, 'src')
    mkdirSync(working, { recursive: true })
    await git(working, 'init', '-b', 'main', working)
    await git(working, '-C', working, 'config', 'user.email', 'aw-test@example.com')
    await git(working, '-C', working, 'config', 'user.name', 'AW Test')
    writeFileSync(join(working, 'README.md'), '# ssh fixture\n', 'utf-8')
    await git(working, '-C', working, 'add', '.')
    await git(working, '-C', working, 'commit', '-m', 'init')
    bare = join(fixture, 'remote.git')
    await git(fixture, 'clone', '--bare', working, bare)
    stub = writeStubSsh(fixture)
    prevSshCommand = process.env.GIT_SSH_COMMAND
  })

  afterEach(() => {
    if (prevSshCommand === undefined) delete process.env.GIT_SSH_COMMAND
    else process.env.GIT_SSH_COMMAND = prevSshCommand
    removeTempDirSync(appHome)
    removeTempDirSync(fixture)
  })

  test('ssh:// 远端能被真的 clone 下来，且确实经由 ssh 传输', async () => {
    process.env.GIT_SSH_COMMAND = stub.path
    const url = `ssh://git@${FIXTURE_HOST}${bare}`

    const r = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url })

    expect(r.cold).toBe(true)
    expect(existsSync(r.cached.localPath)).toBe(true)
    expect(r.cached.defaultBranch).toBe('main')
    // 内容真的取回来了，不只是建了个空目录。
    expect(existsSync(join(r.cached.localPath, 'README.md'))).toBe(true)
    expect(db.select().from(cachedRepos).all().length).toBe(1)

    // 传输确实是 ssh：桩被调用过，而且 git 交给它的是发往**那个主机**的
    // `git-upload-pack`。少了这条，一个把 ssh:// 悄悄改写成本地路径的实现
    // 也能把上面的断言跑绿——而那种实现在真部署里一次都连不上。
    const calls = readFileSync(stub.log, 'utf-8')
    expect(calls, 'GIT_SSH_COMMAND 没有被调用 ⇒ 这次 clone 根本没走 ssh 传输').toContain(
      `host=git@${FIXTURE_HOST}`,
    )
    expect(calls).toContain('git-upload-pack')
  })

  test('运维给的 `-i <私钥>` 一路活到 ssh 手里（本产品交付部署密钥的唯一途径）', async () => {
    // 本仓没有「按仓登记 deploy key」的功能（deploy_key 全仓零命中），私钥只能
    // 从 daemon 环境的 GIT_SSH_COMMAND 进来，由 util/git.ts:38-44 层叠保留。
    const keyPath = join(fixture, 'deploy_key')
    writeFileSync(keyPath, 'not-a-real-key\n', 'utf-8')
    process.env.GIT_SSH_COMMAND = `${stub.path} -i ${keyPath}`

    const r = await resolveCachedRepo(
      { db, appHome, fetchOnReuse: false },
      { url: `ssh://git@${FIXTURE_HOST}${bare}` },
    )
    expect(r.cold).toBe(true)

    const calls = readFileSync(stub.log, 'utf-8')
    expect(
      calls,
      '桩 ssh 没收到 `-i <私钥>` ⇒ util/git.ts 的 `process.env.GIT_SSH_COMMAND ??` 被丢了，' +
        '所有靠部署密钥接入的部署会在毫无预警的情况下全部认证失败',
    ).toContain(`-i ${keyPath}`)
    // 覆盖式替换 vs 层叠：产品追加的非交互选项必须同时还在，否则首次连未知主机
    // 时 ssh 会去读 /dev/tty 把 daemon 挂死（util/git.ts:26-34 记的正是那次事故）。
    expect(calls).toContain('BatchMode=yes')
    expect(calls).toContain('StrictHostKeyChecking=accept-new')
  })

  test('scp 式 `git@host:path` 与 ssh:// 是同一个仓，只落一行缓存', async () => {
    // git-url.ts:280-286 把两种写法归一到同一个 cache key。用户两种写法各填一次，
    // 期望的是「同一个仓」，不是克隆两份、占两份磁盘、各自过期。
    process.env.GIT_SSH_COMMAND = stub.path
    const uri = `ssh://git@${FIXTURE_HOST}${bare}`
    const scp = `git@${FIXTURE_HOST}:${bare.replace(/^\//, '')}`

    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: uri })
    const b = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: scp })

    expect(a.cold).toBe(true)
    expect(b.cold, 'scp 式写法又冷克隆了一次 ⇒ 两种写法没有归一到同一个 cache key').toBe(false)
    expect(b.cached.id).toBe(a.cached.id)
    expect(db.select().from(cachedRepos).all().length).toBe(1)
  })
})
