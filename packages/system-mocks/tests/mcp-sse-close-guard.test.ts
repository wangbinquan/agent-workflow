// 为什么有这条测试（2026-08-26，起草 RFC-319 B106 时撞到）：
//
// `src/mcp/server.ts` 的 SSE 分支里 `transport.onclose` 调 `server.close()`，而 SDK 的
// `Protocol.close()` 会再次 `transport.close()`，`SSEServerTransport.close()` 又无条件
// 回调 `onclose` —— 互相重入直到爆栈。单跑一条走 SSE 的 e2e，共享 mock 进程刷出 152 条
// `RangeError: Maximum call stack size exceeded`；用例照样绿，所以它从落地起没被发现。
//
// **这条守卫的诚实边界**：它是 CLAUDE.md 允许的「源代码层文本断言兜底」，不是行为断言。
// 我试过三种在进程内复现递归的写法（裸 fetch + cancel、真 MCP 客户端 connect/close、
// 监听 uncaughtException / unhandledRejection），**全部修前修后都绿**——递归的拒绝发生在
// 独立的 mock 进程里、且被外层 `.catch(() => {})` 吞掉，进程内测不到。与其留一条修前修后
// 都绿的假守卫，不如留这条只能挡住「有人把闸删掉」的文本断言，并在此写明它挡不住什么。
//
// 真正的回归信号是**量**：`bunx playwright test -g "RFC-319 RES-20"` 之后
// `grep -c 'Maximum call stack size exceeded'` 必须是 0（修复前是 152）。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.ts')

describe('system mock 的 MCP SSE 分支：close 幂等闸不得被摘掉', () => {
  test('onclose 里先用 Map.delete 的返回值早退，再调 server.close()', () => {
    // 先剥注释再匹配：闸旁边那段说明文字里就含 `server.close()`，
    // 不剥的话取到的窗口会落在注释内部（第一版就是这么红的）。
    const src = readFileSync(SRC, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    const at = src.indexOf('transport.onclose')
    expect(
      at,
      'SSE 分支的 onclose handler 没了 ⇒ 这条守卫失去锚点，请改锚点而不是删测试',
    ).toBeGreaterThan(0)
    const gate = src.indexOf('#sse.delete', at)
    const close = src.indexOf('server.close()', at)
    expect(
      gate > 0 && /if \(!this\.#sse\.delete\([^)]*\)\) return/.test(src.slice(at, close)),
      '幂等闸被摘了 ⇒ server.close() 会经 Protocol.close() 回头再触发 onclose，' +
        '递归到爆栈；夜跑日志会被 RangeError 淹掉',
    ).toBe(true)
    expect(
      gate < close,
      '闸排到了 server.close() 之后 ⇒ 第一次重入时会话还在 Map 里，闸形同虚设',
    ).toBe(true)
  })
})
