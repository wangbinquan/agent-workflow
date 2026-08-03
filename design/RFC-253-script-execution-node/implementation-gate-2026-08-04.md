# RFC-253 实现门（Codex，2026-08-04）

对抗式实现门，评审对象是精确提交范围 `802741ec..f864d30c`（不读工作树 —— 共享树上并发
session 的脏改动会污染 review，见 `docs/dev-gotchas.md:109`）。

## 0. 作业本身失败了，但**不能当作没跑**

Codex 作业 `task-msdh29e2-pbm5lu` 最终 **failed**：provider 连续三次把评审内容判为
`This content was flagged for possible cybersecurity risk` 并拒绝，turn 失败。这是本 RFC 的评审
提示词性质决定的 —— 它通篇在要求「构造绕过」「沙箱逃逸」「攻击式检查」。

但日志尾部留下了 **stall 前的部分结论**，按 `docs/dev-gotchas.md:110`（rescue job 僵尸时从日志
抢救 pre-stall finding 并独立复核）必须捞出来验，而不是因为作业失败就跳过：

> 目前已确认不是「补齐若干测试」级别：**权限投影、只读执行、`network: deny` 的 `off` 模式、
> 依赖安装隔离和端口落盘路径**都出现了可构造的边界突破。

下面是**我自己逐条实读源码复核**的结果。**3 条属实并已修复 + 突变实证**，2 条经复核不成立。

## 1. 属实并已修复（均为 P0/P1 安全缺陷）

### F1 (P0) — `network:'deny'` 在 `off` 模式下产出「声称有围栏、实际无围栏」

**链路**（逐环实读确认）：

1. 管理员把 `sandboxMode` 设为 `off`（合法配置）
2. 节点声明 `network: 'deny'` ⇒ 走 `admit('outer-netless-v1')`
3. 我原来的 `failClosed` 实现**跳过了两处 `off` 短路**，让它落到 qualification
4. 宿主 provider 若能力合格 ⇒ `qualified === true` ⇒ `decision = 'contained'` ⇒ `admit` **不抛错**
5. 但返回的 `SandboxProvider` 带着 `mode: 'off'`（coordinator 把 `this.#mode` 传进
   `bwrapSandbox`/`seatbeltSandbox`），`buildRunSandboxCtx` 原样拷进 `ctx.mode`
6. `sandboxActive(ctx)` 判 `ctx.mode !== 'off'` ⇒ **false** ⇒ `wrapSandbox` **原样返回 argv**
7. 脚本以**零围栏**运行，而 receipt 说它 contained

这正是 D23 要防的提权，只是从另一个方向到达 —— 我原来只修好了 `warn` 档的判定表。

**修法**：`off` 从**结构上**就交付不了 fail-closed 束（因为决定「围栏是否被套上」的正是 mode），
所以能力是否具备无关紧要。新增 `fenceUndeliverable = failClosed && mode === 'off'` 参与
`qualified`，并新增 reason code `containment-mode-off` —— 不复用
`required-capability-missing`，因为那会让运维去找一个**明明在场且已合格**的 bwrap。

**顺带修掉一处真实漂移**：`ContainmentReasonCode` 的取值在
`runtime/opencode/verifiedManifest.ts` 被**手抄成 zod enum**（讽刺的是紧邻一行注释正写着
「derived from the closed registry, never re-listed」）。加一个 code 就让三个文件编译失败，
证明这份手抄已经是活的漂移源。改为导出 `CONTAINMENT_REASON_CODES` 常量数组、类型由它派生、
manifest 的 zod enum 直接消费它。

**突变实证**：把 `fenceUndeliverable` 改成 `false` ⇒ `rfc233-containment-coordinator.test.ts`
2 条红；还原 ⇒ 14/14 绿。

### F2 (P0) — `readonly: true` 没有强制只读，反而比默认档更危险

`isReadonly` 只被用来**跳过 iso 创建**，而工作区仍然经 `buildRunSandboxCtx` 的 `taskWorktrees`
拿到**读写** allow-back。净效果：`readonly` 节点直接在 **canonical** 工作区里可写，且没有
默认档的隔离 + merge-back 纪律 —— 这个开关把节点变得比不开更危险，而 AC-10 声称
「脚本对 canonical 工作区的写入尝试被容器边界拒绝」。**文档声称与实现不符**。

**修法**：`computeSandboxPolicy` 新增 `readOnlyWorktrees`，为真时 `allowSubtrees` **只剩本次
运行的私有 run 目录**，工作区与 `${appHome}/repos` 一并移入 `readOnlyAllowSubtrees`。git 镜像
必须一起降级（设计门 P1 已点过这条）：只锁工作树而留着镜像可写，`git update-ref` 与写 repo
config 照样成立。Linux 侧另需跳过镜像的无条件 `--bind`，否则后面的 `--ro-bind` 会被它撤销
（正是该文件自己警告的 mount 顺序陷阱）。

**突变实证**：把 `readOnlyWorktrees` 常量化为 `false` ⇒ `rfc253-script-execution.test.ts` 相关
用例红；还原 ⇒ 绿。测试断言的是「读写形式的 bind **完全不存在**」而不只是「顺序靠前」。

### F3 (P1) — 端口落盘存在路径穿越

`assembleScriptEnv` 用 `join(input.inputDir, spill.portName)` 落盘，而 `portName` 是**入边的
target 端口名**，由工作流作者控制。一个叫 `../../../../tmp/evil` 的端口会让这次
`writeFileSync` 带着**上游可控内容**、以 **daemon 身份**落到 run 目录之外。

**修法**：端口名永远不做路径分量。改用已经折叠成 `[A-Z0-9_]`、且按构造**单射**的 env 后缀
（校验器已拒绝两个折叠后撞车的端口），`AW_PORT_NAMES` 仍携带原名→后缀映射，脚本照样找得到
自己的文件。

**突变实证**：改回原名拼接 ⇒ 穿越用例红；还原 ⇒ 绿。

## 2. 复核后不成立

- **「权限投影有可构造突破」** —— 未复现。投影已含脚本节点自身字段 + **指向它的入边** +
  **包含它的 wrapper 归属与 `maxIterations`**（设计门 P1 已折入）。评审在 stall 前未给出具体
  构造路径，我自行尝试的几条（换上游 agent、改 boundary 字段、改 workflow inputs 默认值）
  要么本就落在投影内（入边变化），要么不改变**这个脚本节点**执行什么。**留作后续复验**：
  这条是 stall 前的断言，缺少可复跑判据，不能算已澄清也不能算已证伪。
- **「依赖安装隔离有突破」** —— 部分基于对现状的误解。安装器确实**不是** jail（Linux
  `--bind / /` 可写、macOS `(allow default)`），但这一点 RFC 已在 AC-15 与
  `docs/audit-backlog.md` 显式声明为**与今天的 agent 同档**、收紧属 RFC-252 G2/G3 范围，
  不是本 RFC 引入的缺口。安装期不执行任何包自带脚本这一条经复核成立
  （`--only-binary=:all:` / `--ignore-scripts`）。

## 3. 结论与门的状态

- **实现门作业本身失败**（provider 安全策略拒绝），**不构成通过**。
- 但抢救出的 pre-stall 结论**含 3 条真缺陷**，已全部修复、补回归测试并做**突变实证**
  （摘掉修复必红）。这三条里有两条是 P0 级安全缺陷，其中 F2 属于「文档声称与实现不符」。
- **仍欠一次完整的实现门**：需要换一种不触发 provider 安全过滤的表述重跑，或改用
  非 Codex 的对抗评审（RFC-240 曾在 Codex 故障当日改用独立子代理评审并如实记档，有先例）。
  在那之前，本 RFC 的实现门状态是 **未完成**，不是 approved。
