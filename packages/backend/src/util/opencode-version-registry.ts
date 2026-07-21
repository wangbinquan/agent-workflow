// opencode binary → probed-version registry（2026-07-21 机器级故障的桥接件）。
//
// WHY: opencode 1.18.0 把 `run --dangerously-skip-permissions` 改名为 `--auto`
// （纯改名——describe 文案逐字相同；旧拼写被整个移除）。顶层解析器是 .strict()，
// 未知 flag 走自定义 .fail()（opencode/src/index.ts:104-114），它对
// "Unknown argument" 前缀的消息只 showHelp、**不打印错误行**——于是 1.18 二进制
// 上每个业务/系统 spawn 都以「stderr 只有一整块 run usage + exit 1」收场，
// 全机任务瘫痪且极难归因（本仓当时的失败形态正是如此）。
//
// spawn 侧要按二进制版本选 flag 拼写，但 buildCommand 是 golden 锁定的纯函数、
// 系统代理路径 driver.buildSpawn 又是同步的——都不能现场探测。这个注册表就是
// 桥：每次 probeOpencode() 成功都记录（daemon 启动在监听前必探默认二进制；
// per-runtime 行在保存时与 /api/runtimes/status 轮询时被探），driver 组装
// spawn 时查表把版本传进 buildCommand。
//
// key = 与 spawn 头一致的二进制记号（PATH 上就是 'opencode'，覆写时是绝对
// 路径）——probeOpencode 解析出的 `binary` 字段与 pickRuntimeHead 的 head[0]
// 天然同源。
//
// 已知边界（接受并记录，不在此处修）：
//  - daemon 运行期间原地升级二进制 → 表项过期，直到下一次探测（boot / 行保存 /
//    status 轮询）自愈；失败形态与修复前相同，不会更糟。
//  - 自定义 binaryPath 的 runtime 行在 daemon 重启后、首次被探测前 spawn →
//    查不到 → 按旧拼写（见 resolveAutoApproveFlag 的未知默认），1.18 定制
//    二进制会失败一次，status 轮询后自愈。
//
// Leaf module: zero imports（util/opencode.ts 与 runtime/opencode/driver.ts
// 两侧都要引它，不能带任何可能成环的依赖）。

/** binary head token → 最近一次成功探测的版本（'X.Y.Z'；输出不可解析时为 null）。 */
const versions = new Map<string, string | null>()

export function recordOpencodeBinaryVersion(binary: string, version: string | null): void {
  versions.set(binary, version)
}

/** null ⇒ 从未探测过 或 探测到但解析不出版本——调用方一律按「未知」处理。 */
export function getOpencodeBinaryVersion(binary: string): string | null {
  return versions.get(binary) ?? null
}

/** 仅测试卫生用。 */
export function resetOpencodeBinaryVersionsForTests(): void {
  versions.clear()
}
