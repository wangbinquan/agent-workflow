# RFC-400 collaboration 经 task 自有参与者写任务、人工门装配归位、public 合同去 legacy Actor（RFC-294 S5 第二步）

- **状态**：Done（2026-10-31；提交 `8ebd3e1e9` + 修复 `01d3788e0`，CI `41220303849` 与 windows-platform `41220303833` 全绿。落档并实施于同日。用户 2026-10-30「你继续推进RFC294，你可以使用codex进行调研和实现，过程中按你的判断来推进，
  不用询问我」：由本会话设计、交 Codex 实施并审核，规则取舍由本会话按推荐决定，见 §6。设计门免：逐处只读研究由 Codex 完成，
  本会话对关键论断逐条对源码复核后定稿；实现门做一轮只审功能的 Codex 检视）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S5；design §3.1
- **前序**：[RFC-399](../RFC-399-context-dag-platform-one-way/proposal.md)（S5 第一步：context 值级 DAG、platform 单向、再导出桶）
- **基线**：HEAD `950f5900b`（RFC-399）；行号只作定位提示，以实施时源码为准
- **落位**：task-execution `public/participants`（task 自有的 tx 参与者合同）与 `infrastructure/`（唯一工厂）；collaboration
  `application/` 与 `infrastructure/`（command context 拆分）；各模块 `public/` 合同改用 identity-access 的公开类型

## 1. 背景

RFC-294 plan §3 S5 的范围里，RFC-399 完成了三条退出门规则（context 值级 SCC 0、越出 DAG 的值级 context 对 0、`platform` →
`modules` 0、无再导出桶）。S5 范围里还剩三项：

1. **collaboration 直接引用 task-execution 内部文件（17 个文件对）。** collaboration 的评审、澄清封存、问题派发、终止清扫等
   写路径在自己的事务里直接调用 task-execution `infrastructure/` 的函数：写节点状态、铸新节点、接受人工门决定、切任务状态、
   追加任务事件、查任务授权。COL→TE 本是 DAG 实线边，但实线只允许经 TE 的 exact `public/*`。
2. **`services/humanGateComposition.ts`**：RFC-333 留下的临时装配桥，把 collaboration 自己的 domain 编解码器、command context
   工厂、默认回滚检查器和 TE 的 `parkPreparedHumanGate` 拼成一个对象，再给 collaboration 的五个实现文件用。collaboration 的实现
   因此经 `services/` 绕回自己的装配，文件头记录了把一个符号改回 barrel 就会重现 9 条 `no-circular`。
3. **模块 `public/` 合同里的 legacy `Actor`**（`@/auth/actor`）：8 个 public 文件直接 import，另有 5 个 `application/ports` 声明经
   public 转出。目标架构要求 public 合同只依赖 identity-access 的公开类型。

这三项都不需要行为变化。

## 2. 目标

- **G1 COL→TE 只经 public**：17 个文件对 → 0；collaboration 只从 TE `public/participants` / `public/queries` / `public/commands`
  取合同，带事务句柄的构造入口只经 TE `composition.ts` 交给 bootstrap，再注入 collaboration。
- **G2 装配桥退役**：删除 `services/humanGateComposition.ts`，collaboration 实现直接引用定义处；command context 的注册表与构造
  拆到 `application/` 与 `infrastructure/`，不重现 9 条环。
- **G3 public 合同去 legacy Actor**：13 个声明源改用 identity-access 的 `AuthenticatedAuthoritySnapshot`；只给装配用的
  `RealtimeCompositionPolicy` 移出 public。
- **G4 不绕门、不回退**：不以 `services/` facade、同形本地类型、类型转导出或扩大兼容账本代替真实改动；其余结构门不升，
  下降的随实测压低上限（预期跨 context 内部文件对 73 → 56、`PUBLIC_SURFACE_DEBT` 137 → 约 120、
  `CAPABILITY_COMPATIBILITY_DEBT` 22 → 约 18、RFC-317 R1 229 → 约 220）。
- **G5 纯结构**：不改任何用户可见行为、错误码与错误文本、事务边界与次序、对象的构造时机与实例范围。

## 3. 非目标

- composition 子文件里的实现迁往正确的层、workgroup 引擎迁入 task-execution（S6）。
- 经 `services/` legacy facade 的间接跨域依赖（W9-D），本 RFC 只删除 `humanGateComposition.ts` 这一个。
- `ReviewActor`、`TaskPortArtifactActor` 等名字带 Actor 但不是 legacy `Actor` 的类型；`public/catalog.ts`、`public/taskRoutes.ts`
  这类非 exact public 入口的既有债。
- 调用上下文模型的重设计（只换类型，不重新构造对象）。
- 安全相关改动。

## 4. 用户可见变化

无。发布二进制、HTTP / MCP / WS 合同、数据库结构与迁移均不变。

## 5. 验收标准

- **AC-1 结构门**：COL→TE 跨 context 内部文件对为 0（总数 73 → 56）；`services/humanGateComposition.ts` 不存在且无引用；
  8 个 public 文件不再 import `@/auth/actor`，public 导出签名的类型闭包里没有 `Actor` / `ActorSource`（新增结构锁锁定，含负例）；
  `rfc294-architecture-preflight` 的 `PUBLIC_SURFACE_DEBT`、`CAPABILITY_COMPATIBILITY_DEBT`、`rfc376-structural-guards` 基线、
  `architecture/counts.json`、`architecture/commons-debt.json` 按实测下调，其余计数不升。
- **AC-2 不绕门**：新增的 TE 参与者合同满足既有能力规则（readonly、私有 brand、唯一 owner 工厂、`Object.freeze`、WeakMap
  注册表），不靠改后缀、搬声明或扩大兼容账本；collaboration 实现不回读自己的 `composition.ts`；不新增 `services/` facade、
  composition 禁止导入文件、模块级可变单例。
- **AC-3 行为不变**：design §3 列出的既有用例全部通过且不改断言意图；因文件移动而改路径的测试只改 import、构造与源码锚点；
  原有负例（含 `fixtures/rfc359-p0-mutations.ts` 的变异）继续作用于搬迁后的真实实现并能失败。
- **AC-4 DAG 文档同步**：不新增 DAG 边；RFC-294 design §3.1「现状偏差」与 plan §3 S5 状态同步。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿（含 PostgreSQL 分片、三平台 e2e 与 windows-platform）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **沿现有 COL→TE 实线改走 TE 自有参与者，不另造 collaboration 的 required SPI**：`rfc294Target.ts` 的 `OFFERED_CONTEXT_EDGES`
   已有 `['collaboration', 'task-execution']`，合同归 task 拥有符合 design §3.1；不新增虚线。
2. **参与者合同放 TE `public/participants`，带事务句柄的构造入口只经 TE `composition.ts` 给 bootstrap**：public 合同不出现
   `PersistenceTx`；collaboration 经内部装配输入拿到工厂，在原调用点、原时机调用。
3. **TE 现有 `TaskDecisionParticipantInTx` 改为与实现一致的异步签名**：它目前是同步声明、没有生产消费者，与实现
   `acceptHumanGateDecisionTx`（`Promise<AcceptedHumanGateDecision>`）不符。
4. **会自行开写事务的铸造（评审路径「无可复用评审行」分支）保留自开事务的形状**：以独立的 operations 合同提供，不改成 InTx、
   不嵌套事务。
5. **`nextRetryIndex` 作为 TE 纯查询经 `public/queries` 提供**，同步调用不变。
6. **legacy `Actor` 统一换成 identity-access 的 `AuthenticatedAuthoritySnapshot`**：字段与 `Actor` 一致（多 readonly），`source`
   联合相同；只换类型标注，不复制、不重新构造对象。identity-access 的 type-only 引用对所有 context 放行（`rfc294Gates.ts`
   `isAuthorityTypeOnly`）。
7. **knowledge-evolution 的 fusion 合同保留在 public，只换类型**：它们被 bootstrap 与路由经 public operations 使用；只搬出 public
   属于未完成清理。runtime-management 的 `RealtimeCompositionPolicy` 只给装配用，移到 `application/ports`，经 RM `composition.ts` 交出。
8. **一个 RFC 两部分**（A：17 对与装配桥；B：Actor 与账本收口），分两次派发 Codex 实施，全部实现与用例完成后集中验证一次。
9. **偏离项**：落档时无；实施中接受的偏差见下条。
10. **实施中接受的偏差**（2026-10-31，本会话审核后决定）：
    - TE 新参与者合同的成员用方法签名，不用函数类型属性：后者会被 W0-R 公共面规则记成 `unsafe/open type FunctionType`
      （Part A 初稿实测多出 6 条，已改）。readonly 要求由 readonly 的 brand 成员满足。
    - `bootstrap/crossContextClosure.ts` 不显式标注 COL `TaskExecutionParticipantBindings` 返回类型，由冻结对象推断：显式 import COL
      infrastructure 会新增一条 RFC-317 R1；COL 消费处仍按装配合同检查类型。
    - `bootstrap/daemonRealtimePolicy.ts` 用既有 `DaemonProviderCoreCommonInput['realtimePolicy']` 标注，不新增对 RM composition 的 import
      （否则多一条 R1）。
    - 接线贯穿 legacy `services/task.ts` 的测试驱动构造入口及其续跑调用方，使既有构造链显式满足新依赖；不新增 `services/` facade，
      RFC-317 R2 不变。
    - 新结构锁「TE 带事务的构造入口不进 public」覆盖本批 E/S/D/M/H/L/A 工厂与底层 mint / lifecycle 构造器；与本 RFC 无关的既有
      TE public 事务 API 仍按 RFC-294 债务管理，不扩大范围。
    - `rfc305-architecture-lock` 的 identity-access 精确消费者清单新增 10 条 type-only AAS 消费路径（清单同步，不是债务）。
    - 集中验证中改定（2026-10-31）：S 参与者成员由 `set` / `transition` 改名为 `setNodeRunStatus` / `transitionNodeRunStatus`。
      RFC-317 转移表预言按被调函数名识别 CAS 站点，通用名 `set` 让 collaboration 的 4 个站点（含 3 条表外边）从语料里消失；
      与内核同名后站点与偏离账本原样回到语料，不放宽扫描器。另有两处随搬迁同步的守卫清单：RFC-371 观测边界的外部
      import 白名单加入 identity-access public participants（type-only），RFC-395 串行化插入源码锁按复核结果更新 `clarify/seal.ts` 的指纹。
    - 集中验证中修复（2026-10-31）：managed-process launcher 库文件 `platform/execution/local/managedProcessLauncher.ts` 的
      `if (import.meta.main) { process.exit(await …) }` 入口块移到新的纯入口文件 `managedProcessLauncherEntry.ts`（没有任何模块 import 它）。
      源码模式的自调用、build-binary 的内嵌 launcher 入口、`BINARY_ENTRIES` 与 `rfc370-native-process-location` 的 local 入口同步改指向它；
      legacy CLI facade `services/execution/managedProcessLauncher.ts` 保持原样（只有 `main.ts` import 它）。
      原因：库文件里的 top-level await 让它和经 task-execution、collaboration 引入它的所有模块都成为异步 ES 模块。删除旧桥后，
      `clarify/autoDispatch.ts` 的初始化落在入口块顶层，要同时等两个异步模块；Bun 1.4.3 打包器为此生成 `await __promiseAll([...])`
      却没有输出这个 helper，编译后的维护 worker 加载即报 `ReferenceError`。
      新增守卫 `rfc400-top-level-await-guard`：带 top-level await 的模块只能被二进制入口 import。
      第一版修法（`8ebd3e1e9`）把入口块改成不 await 的 promise 链，Windows CI 随即证明这个 await 有实际作用：它让 launcher 在等待
      激活帧期间保持存活，去掉后 launcher 以 0 提前退出，Windows 上 RFC-328 launcher 用例与 e2e 全红。现在的做法保留 await 原样。
