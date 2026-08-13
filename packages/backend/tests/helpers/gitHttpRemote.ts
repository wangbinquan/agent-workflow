// RFC-287 T11（G5）—— 后端测试用的**真实远端**（git smart-HTTP）。
//
// 与 `e2e/command.ts` 里那份同源同法，理由也一样：产品侧把 `file://` 判为非法
// 参数后，凡是**经公共 HTTP 面**（`POST /api/tasks`、multipart 启动、定时任务
// payload）启动任务的测试都不能再用它——否则要么测试全红，要么被迫在生产代码里
// 开一个「测试专用旁路」，那等于把刚立的规则自己拆了。
//
// 为什么是 smart HTTP：`git://` 不在后端接受的 scheme 里（只认 ssh/http/https/
// file + scp 形式）；dumb HTTP 只支持 clone/fetch，而有用例要往同一个 URL 推。
//
// 与 e2e 那份的唯一差别：后端测试是 `bun test`，服务与被测代码同进程。这没问题
// ——被测路径里的 git 调用都是 `await runGit(...)`（异步），事件循环不会被占住。
// ⚠️ 但**不要**在这里改用同步 `execFileSync` 去访问本服务，那会立刻死锁。

import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

let server: Server | null = null
let port: number | null = null

function root(): string {
  return realpathSync(tmpdir())
}

/** 起服务（幂等）。测试文件在 `beforeAll` 里 await 一次即可。 */
export async function startGitHttpRemote(): Promise<number> {
  if (port !== null) return port
  const projectRoot = root()
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_HTTP_RECEIVE_PACK: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ''),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: req.headers['content-length'] ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
        REMOTE_USER: 'test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    req.pipe(child.stdin)
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('close', () => {
      const out = Buffer.concat(chunks)
      const crlf = out.indexOf('\r\n\r\n')
      const headEnd = crlf === -1 ? out.indexOf('\n\n') : crlf
      const sepLen = crlf === -1 ? 2 : 4
      if (headEnd === -1) {
        res.writeHead(500)
        res.end()
        return
      }
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of out.subarray(0, headEnd).toString('utf8').split(/\r?\n/)) {
        const idx = line.indexOf(':')
        if (idx <= 0) continue
        const k = line.slice(0, idx).trim()
        const v = line.slice(idx + 1).trim()
        if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10) || 200
        else headers[k] = v
      }
      res.writeHead(status, headers)
      res.end(out.subarray(headEnd + sepLen))
    })
  })
  port = await new Promise<number>((resolve, reject) => {
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('git http remote: unexpected address shape'))
        return
      }
      resolve(addr.port)
    })
  })
  server = srv
  return port
}

export function stopGitHttpRemote(): void {
  server?.close()
  server = null
  port = null
}

/**
 * 夹具仓的可克隆远端 URL。取代 `pathToFileURL(repoPath).href`。
 *
 * 仓库必须在系统临时目录下（夹具仓都是 `mkdtemp` 出来的）；不在就抛错而不是
 * 悄悄退回 `file://`——退回去等于把这条规则又绕过一次。
 */
export function remoteUrlFor(repoPath: string): string {
  if (port === null) {
    throw new Error('remoteUrlFor: startGitHttpRemote() must be awaited first')
  }
  const base = root()
  const real = realpathSync(repoPath)
  if (!real.startsWith(base)) {
    throw new Error(`remoteUrlFor: ${repoPath} is not under ${base}`)
  }
  const rel = real.slice(base.length).replace(/\\/g, '/').replace(/^\/+/, '')
  return `http://127.0.0.1:${String(port)}/${rel}`
}
