# RFC-208 · 请求截止时间与卡死逃生口 —— proposal

## 背景

2026-07-20 用户实报：**「在创建 agent 的时候，点击创建 agent 就会卡在创建中」**，追问后补充 **「卡死之后，整个系统都卡死了，只能重启解决」**。

复现与定位分两层：

**第一层（已修，`96ddc3a3` / `1680a1ca`，不在本 RFC 范围）** —— TanStack Query 默认
`networkMode: 'online'`。`onlineManager` 从不读 `navigator.onLine`，只跟随 window 的
`online` / `offline` 事件，而 daemon 在 `127.0.0.1`，这个信号与 API 可达性无关。浏览器抛过
一次 `offline` 之后，所有 mutation 停在 `status:'pending'`、所有 query 停在
`fetchStatus:'paused'`——**请求根本没有发出**，无错误、无超时。已通过
`networkMode:'always'` 修复并实机验证。

**第二层（本 RFC）** —— 修完第一层之后，同一个"永久卡死"的形状仍然可以从另一个方向复现：
**请求发出去了，但永不返回**。四路并行审计（传输层 / UI 冻结模式 / react-query 逐调用 /
daemon 侧）一致指向同一个系统性缺口：

> `packages/frontend/src/api/client.ts` 的四个入口（`apiRequest` / `apiPostMultipart` /
> `apiGetBlob` / `fetchOrNetworkError`）**没有任何超时或截止时间**。全仓
> `grep AbortSignal.timeout` **零命中**；`signal` 是可选调用方参数，99 个 mutation 中只有
> 1 个传了。不止 `fetch` 本身——`res.json()`、`res.blob()`、`cappedErrorText` 的 reader
> 循环同样无界：响应头到了但 body 永不结束，一样永远挂起。

浏览器不会替应用施加响应超时。所以任何半开 TCP（daemon 事件循环被同步 git/exec 阻塞、
笔记本睡眠唤醒、代理黑洞、dev 模式下 daemon 重启换端口）都会产生一个**永不 settle 的
promise**，而当前架构里没有任何一层能兜住它。

### 为什么一个请求挂住会升级成"整个系统卡死"

三个放大器把单点停顿放大成全站锁死，缺一不可：

1. **busy 令牌 → 路由器全局导航拦截。**
   `components/split/UnsavedChangesGuard.tsx:47` 的 `if (busy) return true` 喂给
   `useBlocker`，这是**路由器全局**拦截器（拦侧边栏、卡片、深链、浏览器后退），不是路由内的。
   `:88` 的 `{!busy && (...)}` 在 busy 时**隐藏 Discard 按钮**，弹窗只剩「留下」。而导航永远
   完不成 → `ResourceSplitPage` 永不卸载 → 拦截器永不解除。`:59` 还给刷新武装了原生
   beforeunload 确认。
   *这个阻断本身是有意设计*（注释：客户端取消无法证明服务端没写入），也有测试锁定——
   问题不在"它拦"，而在"它可以无限期地拦，且不给知情逃生口"。

2. **react-query 救不回来**（对 `@tanstack/query-core@5.100.10` 源码逐条核对）：
   - `query.js:186-194` —— 只有 `state.data !== undefined && cancelRefetch` 才取代在途请求。
     **首次加载中挂起（尚无 data）的 query 永远无法被取代**：`invalidateQueries`、`refetch`、
     `refetchInterval`（`queryObserver.js:214-216` 不传 `cancelRefetch`）全部返回同一个永不
     settle 的 promise。
   - `query.js:161-162` —— 只有 `#abortSignalConsumed` 为真才 abort。**未传 `signal` 的 query
     在组件卸载后重新导航回来，拿到的仍是同一个挂起 promise**，只有整页 reload 能清。
   - mutation 层**完全没有 AbortController**，`isPending` 无法以任何手段取消。

3. **modal 的所有出口被同时封死。**
   `components/Dialog.tsx` 的 ESC / overlay 点击 / × 三个出口全由 `dismissDisabled` 一刀切；
   `components/ConfirmDialog.tsx:62` 的 pending 标志**只在 `catch` 里清、没有 `finally`**。
   请求挂起时 modal 盖住视口、焦点被 trap、五个出口（ESC / overlay / × / Cancel / Confirm）
   同时失效，页内零出口。

### 一条不需要网络异常就能触发的实例

`routes/skills.detail.tsx:141-152` 持有的是**绑定在 state 上的持久 busy 令牌**（而非绑在
promise 上），释放条件是"一次稳定的对账清掉 outcomeUnknown"。而
`lib/skill-composite-draft.ts:350` 判定「确定性失败」**只认 4xx**：

```ts
return error instanceof ApiError && error.status >= 400 && error.status < 500
```

于是 5xx 或 `ApiError(0,'network-unreachable')` → 归为 ambiguous → `outcomeUnknown` →
**永久持有全局导航令牌**。触发条件是日常开发循环里必然发生的事：**保存技能的同时 daemon
重启**（`bun run --watch` 下改一行后端代码就会重启）。且 `:283` 的 discard 在
`aggregate.busy || aggregate.outcomeUnknown` 时直接 bail——连"放弃"都是空操作。

## 目标

1. **有界性**：任何单个 HTTP 请求都不得让 UI 永久卡死。挂起必须在有限时间内转化为一个正常的、
   可呈现的 `ApiError`。
2. **可自救**：用户在长时间等待期间必须有**可发现**的出口——取消请求，或知情地离开当前页——
   而不是只能刷新/重启。
3. **不误杀**：不得因为加超时而打断任何今天能正常返回的合法长请求。
4. **失败分类正确**：传输层失败与 5xx 不应被当作"结果未知"而**永久**扣留导航权。

## 非目标

- **不改 daemon 的 `idleTimeout: 255`**（`cli/start.ts:394`）。它是本 RFC 的锚点，不是改动对象。
- **不实现请求重试、离线队列、乐观更新**。
- **不推翻 "busy 时阻断导航" 的默认安全语义**。该语义的理由（客户端取消无法证明服务端没提交）
  依然成立；本 RFC 只把"无限期静默阻断"改成"有界 + 知情选择"。
- **不做 WebSocket 心跳**。审计确认 WS 半开只会让实时推送静默失效，20+ 处
  `refetchInterval` 轮询仍能刷新数据，属于降级而非卡死——单独立项。
- **不处理 dev 模式 daemon 换端口导致 vite 代理失效**（`cli/start.ts:380` 的 `?? 0` +
  `vite.config.ts:75` 一次性解析）。已核实 vite 会快速回 500（`dep-Dm0c1Wj2.js:34844`），
  是响亮失败而非卡死；给 `config.json` 加固定 `bindPort` 即可，属独立小改。

## 用户故事

- **US-1** 我点了「创建代理」，daemon 恰好卡住。等待若干秒后，界面明确告诉我"仍在处理"，并给我
  一个**取消**按钮；我点取消，表单立刻解冻，我的输入原封不动还在，可以重试。
- **US-2** 我点了保存，请求一直没回来。我想去别的页面看一眼。系统告诉我"这次写入结果未知，
  离开可能导致你看到的状态与服务端不一致"，并让我**选择**留下或仍要离开——而不是只给一个
  「留下」按钮把我锁死。
- **US-3** 我在删除确认框里点了确认，请求挂住。我可以按 ESC 或点取消退出这个框，而不是被一个
  五个出口全封的全屏遮罩困住。
- **US-4** 我保存技能时 daemon 正好重启（5xx）。系统提示我结果未知、给我「重新检查」，但**不会**
  因此永久没收我的导航权。
- **US-5**（不回归）我触发一次插件升级，它合法地跑了 60 秒 `npm install`。它**照常成功**，
  没有被任何新加的超时打断。

## 验收标准

- **AC-1** 存在一条自动化回归：mock 一个**永不 settle** 的 `fetch`，创建代理后在硬截止到达时
  mutation 以 `ApiError` 收场，表单解冻、可再次提交。（修复前该用例会挂到测试超时。）
- **AC-2** 截止时间分两档且都可测：档 A（体积有界的 JSON 接口）为固定常数并严格大于 daemon 的
  `idleTimeout: 255s`；档 B（上传 / blob 下载）由 `payloadDeadlineMs(bytes)` 纯函数推导，
  200 MiB（`services/upload.ts:42` 的默认 `perRequest`）对应的截止必须远大于档 A。
  **设计门修正**：初稿误把 `idleTimeout`（空闲上限）当作请求总时长上限，据此断言"构造上
  不可能误杀"——该断言已撤销，见 design §6-1。
- **AC-3** 软阈值到达后，被冻结的表单/弹窗渲染出可用的取消控件；点击后请求真被 abort
  （`AbortSignal` 生效），UI 立即恢复可编辑，草稿不丢。
- **AC-4** busy 状态下的未保存守卫在软阈值后渲染出「仍要离开」，并带明确风险文案；
  点击后导航成功。软阈值之前维持现状（只有「留下」）。
- **AC-5** `ConfirmDialog` 的 pending 在 `finally` 中清除；请求 reject / abort 后 ESC、overlay、
  ×、取消四个出口全部恢复可用。
- **AC-6** 失败分类按**幂等性**而非 HTTP 状态切分：4xx = 确定性失败；传输失败发生在幂等调用上
  = 可重试；**非幂等写**遇传输失败 / 超时 / abort = 结果未知（服务端可能已提交）。
  「保存技能时 daemon 重启不再永久锁死」由 **unknown 不再等于永久**（有界 + 逃生口 + 重新检查）
  达成，**不得**靠把它重分类为"安全"来达成。**设计门修正**：初稿把整个 `status 0` 判为安全
  重试，会跳过对账、可能重复启动任务，已撤销，见 design §6-2。
- **AC-7** `hooks/useActor.ts` 等全局 queryFn 补上 `signal`，使 react-query 的取代/卸载
  abort 路径真正可用；有测试锁定 `signal` 被消费。
- **AC-8** 门禁全绿：`bun run typecheck && bun run lint && bun run test && bun run format:check`，
  且 CI 的单二进制 build smoke 与 Playwright e2e 不红。

## 影响面与风险

| 风险 | 缓解 |
| --- | --- |
| 超时值选小 → 误杀合法长请求 | 硬截止锚定在 daemon `idleTimeout: 255s` **之上**，构造上不可能早于服务端自己的天花板触发；AC-2 用测试锁死该不等式 |
| 放开 busy 逃生口 → 用户在写入未决时离开，看到不一致状态 | 逃生口**不是默认**：软阈值之后才出现，且必须带明确风险文案；默认路径与今天完全一致 |
| 改动触及被测试锁定的既有安全语义（`unsaved-guard.test.tsx`） | plan 里显式列出需要更新的锁定测试，并要求在测试注释中写明"为什么这条断言变了"，而非静默删除 |
| 同时并发 session 在改前端 | 按仓库多人协作规则精确 `git add` 路径，不碰他人改动 |
