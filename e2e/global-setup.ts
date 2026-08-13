// RFC-287 T11（G5）—— e2e 的真实远端。
//
// 产品侧从此把 `file://` 判为非法参数；e2e 全程走公共 HTTP 面（最像真实用户的
// 那条通道），继续用 `file://` 就等于让这条规则在最该生效的地方被绕过。这里起
// 一个进程内的 git smart-HTTP 服务，各 worker 通过环境变量拿到端口。
import { startGitHttpServer } from './command'

export default async function globalSetup(): Promise<void> {
  const port = await startGitHttpServer()
  process.env['AW_E2E_GIT_HTTP_PORT'] = String(port)
}
