// RFC-254 T28b — `slow` mode: the port of `stub-opencode-slow.sh` (RFC-054).
//
// A controllable variant used to hold a task in `running` long enough to
// SIGKILL the daemon (crash-recovery), and to drive the failure / no-envelope /
// non-zero-exit paths of the lifecycle spec.
//
// The sleep keeps the shell's SECOND granularity on purpose: the original
// computed `sleep_ms / 1000` with integer division, so 500 ms meant "do not
// sleep at all". Converting to true millisecond precision would silently change
// the timing every existing spec was tuned against.

import { existsSync, writeFileSync } from 'node:fs'
import {
  emitPromptForContractTest,
  emitTextEvent,
  envelope,
  parseInvocation,
  requireOutputOpen,
  writeInventoryIfRequested,
} from './skeleton'

const NAME = 'stub-opencode-slow'

/** Byte-identical to the heredoc the shell stub wrote. */
const INVENTORY = `{
  "schemaVersion": 1,
  "capturedAt": 1700000000000,
  "agents": [
    {"name": "e2e-stub-coder", "mode": "primary", "modelProviderId": "anthropic", "modelId": "claude-opus-4-7", "readonly": true, "source": "inline"}
  ],
  "skills": [],
  "mcps": [],
  "plugins": []
}
`

export async function run(argv: readonly string[]): Promise<void> {
  const call = parseInvocation(argv, NAME)
  if (call.kind === 'version') {
    process.stdout.write('stub-opencode 0.9.0\n')
    process.exit(0)
  }
  emitPromptForContractTest(call.prompt)

  // RFC-319 B37 —— `STUB_OPENCODE_HOLD_FILE`：把「这一回合还在飞」做成**确定性**的。
  //
  // `STUB_OPENCODE_SLEEP_MS` 只是把窗口调宽，赢不赢竞态仍看机器快慢：
  // `e2e/mcp-acl-session-termination.spec.ts` 拿它守「撤权要终止在飞的会话」，
  // 本机稳定绿、CI 上间歇红成 `session-unusable`（那是回合已自然收尾后的形态，
  // 撤权那条事务只处理 `status='active'`，于是什么都没标）。
  //
  // hold 文件给出两个信号，把时序假设整个拿掉：
  //   ① 起来了 —— stub 先落 `<hold>.started`，调用方轮询到它才动手；
  //   ② 一直挂着 —— 文件在就不返回，调用方做完判定再删。
  // 上界仍在（防止调用方崩了把进程永久挂住）。
  //
  // **必须排在 `requireOutputOpen` 之前**：MCP runtime-test 的提示词不带 RFC-200
  // 信封（那是工作流执行链的协议，runtime-test 是另一条 feature），所以那一行会
  // 让 stub 当场 exit 3。实测：turn 76ms 就 failed、stderr 是
  // `prompt is missing the RFC-200 envelope nonce`——扣在信封检查后面的话，
  // 这个 hold 一次也不会执行。
  const holdFile = process.env.STUB_OPENCODE_HOLD_FILE
  if (holdFile !== undefined && holdFile.length > 0) {
    try {
      writeFileSync(`${holdFile}.started`, '')
    } catch {
      /* 观察信号是尽力而为：写不进去也不该把这一回合变成另一种失败 */
    }
    const deadline = Date.now() + 120_000
    while (existsSync(holdFile) && Date.now() < deadline) {
      await Bun.sleep(25)
    }
  }

  const open = requireOutputOpen(call.prompt, NAME)

  const sleepMs = Number(process.env.STUB_OPENCODE_SLEEP_MS ?? '0')
  const sleepSeconds = Number.isFinite(sleepMs) ? Math.floor(sleepMs / 1000) : 0
  if (sleepSeconds > 0) await Bun.sleep(sleepSeconds * 1000)

  writeInventoryIfRequested(INVENTORY)

  if ((process.env.STUB_OPENCODE_SKIP_ENVELOPE ?? '') === '') {
    emitTextEvent(envelope(open, [['answer', 'stub e2e output']]))
  }

  process.exit(Number(process.env.STUB_OPENCODE_EXIT_CODE ?? '0'))
}
