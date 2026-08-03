# RFC-252 ↔ RFC-253 出网围栏接口约定（2026-08-03）

> **给 RFC-253 owner**：这份是按你 `design.md:563`「落地时须在 RFC-252 的 design 里登记
> 外层围栏机制由本 RFC 交付」的要求写的回执，外加**三条需要你回应的接口问题**。
> RFC-252 侧的登记已同步进 `design.md §4.2b`。
>
> 你们的目录当前还是未跟踪状态，所以这份放在 RFC-252 目录里（避免把你们的
> `git add` 面搅乱），不是要另起炉灶。

## 1. 分工：接受你们的 D17，不重复建设

| 交付方 | 内容 |
| --- | --- |
| **RFC-253** | 能力 `outerNetworkDeny`；profile `outer-netless-v1`（`childBoundary:'none'`，外层进程完全无网）；**`failClosed: true` 作为 profile 注册表字段** + coordinator `#evaluate` 的统一改判；资格试跑钩子 `qualifyBwrapNetless` / `qualifySeatbeltNetless` |
| **RFC-252** | 能力 `modelChildLoopbackDeny`；profile `model-child-egress-v1`（`childBoundary:'model-controlled'`，**公网可达但 loopback 拒**）；Linux 用户态网络栈（pasta / slirp4netns）选型与资格探测 |

两者**需求真正不同**（一个是「完全无网」、一个是「有网但不得触达本机」），按注册表自己的
契约（`containmentCoordinator.ts:13-26`「只有需求真正分歧才拆」）应当并列，不是重复。

**RFC-252 明确复用、不再自建的部分**：

- `failClosed` 字段与 `#evaluate` 的三档改判。RFC-252 design §4.3 原本写「在 `#evaluate`
  里显式表达并单测锁定」，现改为**声明 `failClosed: true` 即可**，coordinator 里只保留
  你们那一处 fail-closed 逻辑。⇒ **依赖顺序：RFC-253 的该字段先落，RFC-252 PR-3 才能消费。**
- 可注入 trial 钩子的形态（结构性试跑 + 既有 reason code，不做真实外网探针）。

## 1b. 一条待办：`main` 的 Markdown link check 正因你们的目录未入库而红

`design/plan.md:286` 的 `[RFC-253](./RFC-253-script-execution-node/proposal.md)` 链接由
commit `fb423368` 引入，但 `design/RFC-253-script-execution-node/` 至今**未跟踪** ⇒
CI 的 `Markdown link check (design/)` job 在 `9f296872` 上红（同批的 RFC-250 断链已由
`5a1f6993` 提交目录后自动修复）。

我不代提交他人的未跟踪文件（CLAUDE.md 多人协作原则），所以这条只能由你们收口：
**要么把 RFC-253 目录提交，要么先把 `design/plan.md` 里的链接降级为纯文本**。

## 2. 三条需要回应的接口问题

### Q1（最重要）：`network:'allow'` 档的 loopback 面

你们的默认档复用 `runner-filesystem-v1`，Linux 侧不带 `--unshare-net`（`policy.ts:176-207`
是 `--bind / /` + 宿主 netns），macOS 侧外层 Seatbelt 无网络规则。⇒ **脚本节点默认可达
`127.0.0.1:<daemon 端口>`、本机数据库、以及用户局域网**。AC-12 只断言「能访问外网」，
全文未提 loopback。

RFC-252 这边用户已明确要求 agent 的出网是「任意公网 + **拒 loopback**」。两边落地后会出现
一个不对称：**更容易被指向 localhost 的脚本节点反而默认全开**，而脚本正文是用户可写的
（`scripts:author`），SSRF 面比 agent 大。

**建议**（按代价从低到高，任选其一即可，不必现在做完）：

1. 至少在 RFC-253 的残留风险里**显式登记**这一条，别让它以「默认安全」的印象落地；
2. AC 里补一条负向断言，把「`allow` 档可达 loopback」变成**已知且被测到**的事实，而不是
   没人想过的空白；
3. 后续复用 RFC-252 的 `modelChildLoopbackDeny`——如果你们愿意，我可以把它做成 outer 版
   （`outerLoopbackDeny`），两档共用同一份 Linux 网络栈资格探测。

我不认为这该阻塞你们的交付；但它应当是一个**被记录的取舍**，不是遗漏。

### Q2：`network` 字段默认极性相反，两边都要写死

- 脚本节点：默认 **`allow`**（D4，典型用途是调 API）
- agent：默认 **`deny`**（RFC-252 D7，存量 agent 行为必须字节不变）

字段名、取值词汇（`'deny' | 'allow'`）建议保持一致，但**载体不同**（工作流节点 vs agent
资源），默认相反是有意的。请在 RFC-253 里也写一句，否则后人很容易把两处「统一」成一个
默认，从而**要么悄悄给全部存量 agent 开网、要么悄悄让脚本节点断网**。

### Q3：错误码与 reason code

你们用 `script-network-fence-unavailable`，我用 `execution-identity-egress-unavailable`。
两个 consumer 面的码各自保留没问题（一个是脚本节点、一个是执行身份链），只要 coordinator
侧的 `ContainmentReasonCode` 仍是同一套（你们已说沿用既有 reason code）。这条只是登记，
无需改动。

## 3. 顺手给你们两条 RFC-252 侧的实测结论

1. **`businessContainmentProfile` 看不见 `dependsOn` 闭包**（`runtime/types.ts:643-645`
   入参只有 `'agent' | 'mcps' | 'runtimeCmd'`），而 RFC-251 之后整条闭包**共用同一个
   shell wrapper**。如果你们要动 profile 选择的 seam，这个入参最好一次扩到位。
   顺带一个既有缺口：root `bash:'deny'` + 闭包成员 `bash:'allow'` 时会落
   `childBoundary:'none'`，模型可控的 shell 因此拿不到 netless 边界（已登记
   `docs/audit-backlog.md`）。
2. **`gitHardening.ts` 的 `commit` 豁免**：你们在 `design.md:155` 引用了 filter 以 daemon
   身份执行那条——补充一点，`commit` 子命令**豁免** hooksPath 压制（RFC-252 D9，用户拍板
   的功能优先取舍，因为 `rfc210-publish-failure-hard-fails` 把「仓库钩子拒绝平台自动提交」
   当 everyday setup）。所以脚本节点若在快照/合回链路上依赖钩子行为，语义是：
   `commit` 跑仓库钩子，其余子命令不跑。

## 4. 一处交叉引用勘误

RFC-253 `proposal.md` D23 写「与 RFC-252 **D8** 同构」——RFC-252 的 D8 是「macOS child
默认禁写」，fail-closed 那条在 RFC-252 是 **design §4.3 + AC-8**（决策清单里没有单独编号）。
建议改引 `RFC-252 design §4.3`，免得后人顺着 D8 找不到东西。
