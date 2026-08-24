# RFC-317 实施计划：公共内核架构边界加固

> 本仓主干开发、不建分支。下文的「批」= 一次或数次直接落 `main` 的提交组，每批**独立跑满 `bun run gate:local`**、独立推送、独立按 exact SHA 查 hosted CI。
> 不以「大重构最后一起测」作为安全策略（RFC-294 `§G7`）。

## 0. 前置

- ✅ **D1–D7 已裁决**（`design.md §10`）；✅ **能力影响清单 C1–C9 已逐项确认**（`proposal.md §4`）。两条关键取值：C1 **直接收紧、不做迁移**；D4 **核心内核预算直接归零**（非钉住现值）、D7 **fixture 本批全回填**。
- ✅ **B0/T1 已在干净 SHA `efc1bdb01` 的分离 worktree 上采数完成**，正式分母见 `census-2026-08-23.md`。它订正了落档时用 `rg` 估算的三个数字：inbound 66/19 → **94/28**、outbound 33 → **22**、context 12 → **11**（`work-start` 是空目录残骸）。此后一律以该报告为准。

## 1. 批次依赖

```text
B0 采数与账本初版（零改动）
 ├─► B1  P1 安全与数据修复 + 定点守卫        ← 最紧急，先落
 └─► B2  守卫 manifest + 账本高水位（零生产改动）
          └─► B3  边界 scanner 扩面 + 债务 seed（零生产改动）
                   ├─► B4  R4 业务字面量预算 + 相关 P2
                   ├─► B5  R7 站点治理 + 执行/进程 P2
                   ├─► B6  R5/R6/R8 + 数字员工 P2
                   ├─► B7  生命周期公共层（**独占 lifecycle.ts / task.ts，串行**）
                   ├─► B8  transport / platform P2
                   ├─► B9  shared 注册表 P2
                   └─► B10 前端 R9 + FE P2
                            └─► B11 收口（stale 断言 / 索引 / STATE / gotchas / P3 入账复核）
```

B4–B10 之间无依赖，可按工作树占用情况调序；**唯一硬约束是 B7 与任何触碰 `scheduler.ts` / `lifecycle.ts` / `task.ts` 的批不得并行**。

## 2. 任务分解

### B0 — 采数与账本初版（零生产改动）

| id  | 任务                                                                                                                                           | 产出                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| T1  | 在干净 SHA 上复算全部计数：R1 的 inbound 边、R2 的 outbound 边（按 context / 按层）、R4 的逐文件业务字面量基数、各守卫的语料下界、既有账本条数 | 一份可复跑的采数脚本 + 数字 |
| T2  | 落 `architecture/commons-manifest.json`：公共内核清单（含完整性批判点出的 12 个本轮才发现无人审计的内核）                                      | 清单 v1                     |
| T3  | 落 `architecture/commons-debt.json`：R1 94 条 + R2 22 条 + 79 条 P3，每条带 `why` / `removeAfterWave` / `findingId`                            | 账本 v1                     |
| T4  | 落 `architecture/guard-manifest.json`：**116 个**守卫文件逐条登记 + 与磁盘两向钉死（`minCorpusFiles` / R11 fixture 元数据由 B2 补齐）          | 守卫清单 v1                 |

**退出门**：三份 JSON 落地且被至少一条测试读到；`bun run gate:local` 绿。

### B1 — P1 安全与数据修复（最紧急）

| id  | 任务                                                                                                                                                                                                                                                                                                                 | finding | 能力影响 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| T5  | `routes/developmentConfig.ts` 五类资源的写路径由 `requireVisible` 改为 `requireResourceOwner`；读路径不动                                                                                                                                                                                                            | ACL-01  | **C1**   |
| T6  | 新守卫：RouteMeta 含某 ACL 资源 `:update`/`:delete`/`:archive` 点的路由，其 handler 传递闭包必须命中 `requireResourceOwner`，否则入账                                                                                                                                                                                | ACL-01  | —        |
| T7  | 行为用例：被授予 view 的**非 owner** 发 PUT / publish / archive ⇒ 403 **且零写入**（durable 与广播均为零）                                                                                                                                                                                                           | ACL-01  | —        |
| T8  | `employee_definitions` 立为**第 13 类 ACL 资源**（D2(a)）：进 `ACL_RESOURCE_TYPES` / `ACL_TABLES`、列表 `filterVisibleRows`、详情 `canView→404` 同形、写门 `requireResourceOwner`、挂 `/acl` 端点、创建走统一默认三元组。存量行**不回填**；迁移只把 `owner_user_id IS NULL` 的历史孤儿行显式置 `visibility='public'` | ACL-02  | **C2**   |
| T9  | 新守卫（schema 反射）：任何同时声明 `owner_user_id` 与 `visibility` 的表必须是 `AclResourceType`，否则入显式收缩账本                                                                                                                                                                                                 | ACL-02  | —        |
| T9b | ACL 端点入网守卫由字符串正则改为**运行时注册表枚举**：`mountAclEndpoints` 追加导出注册表，起真 app 后断言 `registeredAclMounts` = `ACL_RESOURCE_TYPES` = 矩阵 `CASES`（今天正则只命中 7/12 类）                                                                                                                      | ACL-03  | —        |
| T10 | R8 级联闭包 helper `cascadeClosure(schema, roots)`；归档对账改闭包版；`review_comments` 进 `ARCHIVED_TABLES`（或显式豁免并写清理由）                                                                                                                                                                                 | CC-01   | **C6**   |
| T11 | R8 的孙表 fixture：合成两跳级联表 ⇒ 闭包版红、单跳版绿                                                                                                                                                                                                                                                               | CC-01   | —        |

**退出门**：三条 P1 各有红→绿对且做过变异复跑；C1/C2/C6 的拒绝分支各有用例；门禁 + hosted CI 全绿。

### B2 — 守卫的守卫与账本高水位（零生产改动）

| id  | 任务                                                                                                                                                                                              | finding             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| T12 | `architecture-guard-manifest.test.ts`：守卫文件两向钉死（删/改名 ⇒ 红）                                                                                                                           | CC-07               |
| T13 | 每个源码扫描型守卫导出扫描文件数，manifest 断言 `>= minCorpusFiles`                                                                                                                               | CC-07 / dev-gotchas |
| T14 | 守卫导出 `__mutationFixtures`，manifest 逐条喂给同一 matcher 并断言转红；fixture 一律内存字符串                                                                                                   | G-07                |
| T15 | 按 D7 回填既有 16 个无 fixture 机制                                                                                                                                                               | G-07                |
| T16 | R10 高水位：`KNOWN_VIOLATIONS` / spawn-site / ux-source-ratchets ×3 / rfc143 kind-discrimination / `LEGACY_MIGRATION_HASHES` / rfc294 两条 debt list / `commons-debt.json` 各加 `LEDGER_BASELINE` | CC-06 / CC-03       |
| T17 | 「基线只降」测试（读 `git show HEAD~1:<file>`；无 git 环境显式 skip 并打印原因，不假绿）                                                                                                          | CC-06               |
| T18 | `rfc217` G5：`<=` → `===`、删 `Infinity` 分支（当场收回 3 个免费槽位）                                                                                                                            | G-04                |
| T19 | `rfc143` allowlist 加 stale 检测（当场清掉两条已死条目）                                                                                                                                          | RT-02               |
| T20 | `depcheck-gate` 加元断言：cruiser 规则注释声称「已入账」⇒ 账本必须有对应条目                                                                                                                      | G-11                |
| T21 | R11 自变异：改一条 `mustReport: true` fixture 为合法源码 ⇒ manifest 必须红                                                                                                                        | —                   |

**退出门**：manifest 覆盖全部守卫；每条守卫的变异 fixture 跑过并转红；`LEDGER_BASELINE` 自变异红。

### B3 — 边界 scanner 扩面（零生产改动）

| id  | 任务                                                                                                                                                                                                | finding                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| T22 | R1 inbound 规则落地（census 已备好 `inboundBoundaryEdges`），**94 条边** `toEqual` 精确入账 + 正反 fixture                                                                                          | G-01                        |
| T23 | R2 outbound 规则落地，**22 条边**入账（全部在 application 层，标最短 `removeAfterWave`）                                                                                                            | G-02                        |
| T24 | R3 模块形状：subject 由 `readdirSync(MODULES_ROOT)` 派生；顶层目录集 / 层内矩阵 / composition 纯净 / public 非空；目录缺失**抛错而非返回空**                                                        | G-03 / G-10 / CC-05 / CC-11 |
| T25 | R12：解析语料扩到 `shared/src` + `backend/src/platform`；`FORBIDDEN_TYPE_IMPORT` 补 `@/platform` `@/embed`；public entrypoint 禁非字面量键 `Record`；扩面后新增违规逐条修或入账（**不得调高预算**） | G-05                        |
| T26 | R1–R3、R12 各自的正反 fixture                                                                                                                                                                       | —                           |

**退出门**：四条规则各带正反 fixture；债务账本与实测逐条相等（新增红、销账不改也红）。

### B4 — R4 业务身份字面量预算 + 相关 P2

| id  | 任务                                                                                                                                                                                                                | finding       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| T27 | R4 规则：从各注册表**派生**字面量集（不手抄）；匹配 `BinaryExpression` / `CaseClause` / `includes` / `startsWith`；`toBe` 精确断言；断言消息给出正确形状指引。**D4：`core: true` 内核预算直接为 0**，其余按实测钉住 | G-04 / G-08   |
| T28 | `TerminalWorkspacePrunePolicy` 改返回 `{prune, cause}`；`lifecycle.ts` 内 webhook 选列与 `'webhook-terminal'` 字面量清零                                                                                            | LC-04         |
| T29 | `routes/resourceAcl.ts` 两条 `cfg.type ===` 广播分支移进调用方 `afterUpdate`                                                                                                                                        | ACL-04        |
| T30 | `event-center` 的 `development-missions:launch` 改由 composition 注入 + `Record<TargetKind, LaunchPermissionRef\|null>` 穷尽表                                                                                      | DE-04         |
| T31 | `workspace-boundary-` 前缀握手改闭合联合 `errorClass`；`'platform'` 魔法 slot 改闭合联合/共享常量                                                                                                                   | DE-03 / DE-05 |
| T32 | `genericTypeLiteralBan` 从单词升级为「派生禁用词集 + 精确 allowlist」                                                                                                                                               | DE-07         |
| T33 | `rfc282-single-implementation-lock` 的 `services/runtime/` 整目录豁免收窄为 `opencode/` + `claudeCode/`；共享层重新入扫描，命中逐条修或入账                                                                         | RT-03         |

### B5 — R7 能力站点治理 + 执行/进程 P2

| id  | 任务                                                                                                                                                                 | finding               | 能力影响 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------- |
| T34 | R7：spawn / fs-write / transaction 三类站点 allowlist 值加 `governance`，非 exempt 条目须通过 AST 治理断言                                                           | EK-01 / CC-08 / CC-04 | —        |
| T35 | 两个 RFC-310 runner 接入受管进程（或补 `detached` + `killProcessTree` + 有界读）                                                                                     | EK-01                 | —        |
| T36 | `spawnVersionProbe` 的 `timeoutMs` 改必填，删无 timeout 模式                                                                                                         | EK-02                 | **C4**   |
| T37 | `db/txSync.ts` 导出 `NotPromise`；两个事务端口签名加约束；S-10 词法禁令升级为站点账本                                                                                | CC-04                 | —        |
| T38 | 导出唯一 `repoRelativePathSchema`，两处写侧 `z.string().min(1)` 改 import                                                                                            | CC-08                 | —        |
| T39 | `memoryInject` 的 `envelopeNonce` 去默认值，改必传判别式                                                                                                             | CC-13                 | —        |
| T40 | `development-automation` 第二套 prompt 围栏删除，改用 `shared/promptFencing`；补「含 prompt 结构字面量的文件必须 import 共享围栏」全域棘轮 + 对抗 payload fixture 表 | CC-02                 | —        |

### B6 — 表归属 / 注册表反向完备 / 数字员工 P2

| id  | 任务                                                                                                                                                                       | finding                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| T41 | R5 表归属规则；`DE-01` / `DE-02` 两条互反的私表越界各换 public query port；`ws/registry.ts` 的 raw SQL 读改走 identity-access 既有 port + 补 `no-transport-to-db` dep 规则 | DE-01 / DE-02 / TP-03         |
| T42 | R6 共享 helper `assertEveryRegistryKeyHasAProductionConsumer`，逐注册表套用                                                                                                | G-09                          |
| T43 | 按 R6 结果处置：`REF_DOMAIN_POLICIES` / `EXPORT_CALL_POLICY` 零消费者、`isProcess` 假维度、`code-round` 死行、`INVARIANT_RULES`/`STUCK_RULES` 非穷尽                       | CC-10 / NK-04 / NK-11 / CC-09 |
| T44 | `terminalKind` 定为闭合联合 + route 层校验 + 三份分类表改穷尽 `Record`                                                                                                     | DE-06                         |
| T45 | 删 `task-execution` 手抄的 `implementationSchema`，改 import `execution-contract/public/types`                                                                             | DE-08                         |
| T46 | `LEGACY_MIGRATION_HASHES` 测试改 import 生产常量 + 精确 8 项账本 + 每项 `why`                                                                                              | CC-03                         |

### B7 — 生命周期公共层（**串行，独占 `lifecycle.ts` / `task.ts`**）

| id  | 任务                                                                                                                                  | finding       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| T47 | `allowedFrom` ⊆ 转移表的静态断言；越界站点逐条改对或入账                                                                              | LC-01         |
| T48 | `lifecycle-grep-guard` 的注释标记从「授权」降级为「文档」，改 s14 式逐文件精确计数 allowlist                                          | LC-02         |
| T49 | `allowTerminal` 21 处逐条入账（只锁数量不改语义）；修正 `lifecycle.ts:18` 的**不存在的** ESLint 规则名与「5 个持有者」表述            | LC-03 / LC-07 |
| T50 | 抽 `taskWorkspacePhase(row)`，三处 repo-prep 谓词改 import                                                                            | LC-05         |
| T51 | 从转移表派生 `CANCELABLE_TASK_STATUSES` / `RECOVERABLE_TASK_STATUSES`，六处手抄枚举 + 前端手写终态析取改 import；补「不得再手抄」棘轮 | LC-06         |

### B8 — transport / platform

| id  | 任务                                                                                     | finding | 能力影响 |
| --- | ---------------------------------------------------------------------------------------- | ------- | -------- |
| T52 | 契约覆盖扫描器由正则改为运行时预言（`createApp` 后比对 `allRouteMeta()`）                | TP-01   | —        |
| T53 | 冻结 `EXEMPT_MOUNTS`；`/api/*` 的 ALL 挂载必须入账                                       | TP-02   | **C7**   |
| T54 | `bind` 改「已绑定即抛」；`mountApiRoutes` 里 7 处 `compose*` 提到 `createApp`            | TP-04   | —        |
| T55 | 权限点域归属断言；四条 `/api/digital-employee*` 引用 `development-missions:*` 按 D5 入账 | TP-05   | —        |
| T56 | WS 通道三处手写样本数组改为从 `WS_CHANNELS` 派生                                         | TP-06   | —        |

### B9 — shared 注册表

| id  | 任务                                                                                                                  | finding | 能力影响 |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| T57 | `list<T>` 的 codec 选择下沉到 item handler；registry 级 round-trip 属性测试                                           | NK-01   | **C5**   |
| T58 | `promotedSourceForWrapper` 改 `satisfies Record<WrapperKind, Promoter>`；失败结果 `wrapperKind` 改 `NodeKind \| null` | NK-02   | —        |
| T59 | `rfc147-system-channel-ports` roots 补 frontend；两处命中改 import 常量                                               | NK-03   | —        |

### B10 — 前端

| id  | 任务                                                                                                   | finding | 能力影响 |
| --- | ------------------------------------------------------------------------------------------------------ | ------- | -------- |
| T60 | R9.1/R9.2：原生 `<select>` / `__overlay` 类 / `segmented` / `role=radiogroup\|tablist` 的全域 AST 规则 | G-06    | —        |
| T61 | R9.3 死 class 全域不变量（替换 `rfc286-f1` 的硬编码三名单）；五个死 class 家族逐条修                   | FE-02   | **C8**   |
| T62 | R9.4：`styles.css` 中公共 class 选择器不得被特性名限定（今天 4 处）                                    | FE-\*   | —        |
| T63 | `JoinModeField` 改用 `<Segmented>`                                                                     | FE-01   | —        |
| T64 | 既有四个「迁移白名单」测试各加 stale 断言                                                              | G-06    | —        |
| T65 | 视觉基线：若动到已有 scene，按仓规「首次 hosted run 故意红 → 人工审 PNG → 只提交被接受的 Linux 基线」  | —       | —        |

### B11 — 收口

| id  | 任务                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| T66 | 15 条 family + 4 条 critic 的 stale 断言逐条改对（含 `resourceAcl.ts` 的「六类资源」表述、`ref/resolution.ts:87` 的单一事实源声明、`depcheck.ts:28-30` 的「只能缩不能涨」、`system-commons-unification-audit-2026-08-12.md` 的三处过时计数与前端行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T67 | 79 条 P3 入账复核：`findings.md` 的 gid 与 `commons-debt.json` 条目一一对应                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T68 | `design/plan.md` RFC 索引登记 RFC-317（状态四选一打头）；`STATE.md` 顶部「进行中 RFC」→ 完工后移入已完成表                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T69 | `docs/dev-gotchas.md` 沉淀通用教训：①「守卫只覆盖自己诞生的那一块」的系统性自检定式（写完任一守卫先问「起点面全吗？终点面全吗？subject 是硬编码还是派生？」）；②`<=` 型棘轮会留下可复用的松弛槽位，快照降下去不销账等于白送分支额度；③ 单跳 schema 反射守卫看不见多跳级联；④ 默认参数会让安全语义变成 opt-in，且对导入图 / AST cast 禁令 / 源码文本三类扫描**全部隐形**；⑤ **`git ls-files` 型守卫看不见未跟踪的新文件**——`docs/dev-gotchas.md:12` 已记这条事故，但没写**本地的快解**：`git add` 进索引后 `git ls-files` 就能看见它，不必先提交再验（RFC-317 B1-c 实撞：新错误码守卫因看不见新测试文件而误报）；⑥ **AST 定位路由 handler 必须按 method + path**，只按 path 会永远取到最后注册的那条（同一 path 常有 GET/POST 或 GET/PUT 两条），断言看的是另一个 handler 却恒定「工作正常」；⑦ **正则剥注释会吃掉真代码**——非贪婪块注释正则从字符串里的 `/*` 一路吃到下一个 `*/`，吞掉几百行；判「某个名字有没有被调用」应当用 AST，对注释与字符串天然免疫；⑧ **正向锁也会被注释满足**：`text.includes('someGuardFn')` 会被文档注释里的提及满足，比它的镜像版（注释踩负向锁）更隐蔽，因为它不会让人怀疑；⑨ **design 文档里裸写正则会被 lychee 当成 markdown 链接**——`['"](?:a | b)['"]`这种片段形如`[...](...)`，CI 的 `Markdown link check (design/)`会去请求`(?:a | b)` 并红，本 RFC 落档时实撞（`findings.md` 三处），定式是**正则一律包进反引号** |
| T70 | 若有机制被 R1–R12 完全覆盖，按 `docs/dev-gotchas.md` 三种处置逐条判并记录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| T71 | **B11 收口时补录**：`POST /api/runtimes/probe` 与 `POST /api/runtimes` 预检 smoke 的 `extraArgs` / `isSandbox` 能力门（能力影响 **C3** 已获批准，但任务表里从来没有对应任务；见下方实施记录）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | RT-01                                                                               |

## 3. 冲突矩阵（多人并发树）

| 文件 / 目录                                                    | 占用批                                       | 说明                                             |
| -------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| `packages/backend/src/services/lifecycle.ts`                   | **B7 独占**（B4 的 T28 需先于 B7 或并入 B7） | 高冲突；RFC-294 点名严格串行                     |
| `packages/backend/src/services/task.ts`                        | **B7 独占**                                  | 同上                                             |
| `packages/backend/src/services/scheduler.ts`                   | 本 RFC 不改（仅 R4 计数读取）                | 若 T47 需触碰则并入 B7                           |
| `architecture/**`                                              | B0 建立，各批追加；**单 owner**              | 账本冲突用「按路径精确 `git add`」处理           |
| `.dependency-cruiser.cjs` / `scripts/depcheck.ts`              | B2 / B3 / B6                                 | 单 owner，串行                                   |
| `packages/backend/tests/rfc294-architecture-preflight.test.ts` | B3 独占                                      |                                                  |
| `packages/frontend/tests/ux-source-ratchets.test.ts`           | B10 独占                                     |                                                  |
| `packages/backend/src/routes/developmentConfig.ts`             | B1 独占                                      | RFC-310 仍 In Progress，开工前确认无他人在途改动 |

并发纪律（仓规）：`git pull --rebase` 后立刻推；**绝不** `git reset --hard` / 无参 `git stash pop`；他人未追踪文件不入暂存区；commit message 只描述自己的改动。

## 4. 验收清单

- [x] AC-1 `architecture/commons-manifest.json` 落地且与源码双向闭合（B0；82 个内核 / 31 个 core，闭合断言在 `rfc317-architecture-ledgers.test.ts`）
- [x] AC-2 R1/R2 落地，94 + 22 条边精确入账（B3-a；`rfc317-module-boundary.test.ts` 的 T22/T23「与债务账本**逐条相等**」，不是上限）
- [x] AC-3 R3 覆盖全部 11 个 context，两处具名偏离入账（B3-a；同文件 T24「R3：模块目录形状」）
- [x] AC-4 R4 在清单文件集上生效，`toBe` 精确断言（B4-a；`rfc317-foreign-vocabulary-budget.test.ts` + `rfc317-identity-dispatch.test.ts`，各带自变异边界）
- [x] AC-5 R5–R9 落地，各带正反 fixture（R5 `rfc317-table-ownership.test.ts` T41；R7 T34 spawn 治理形态；R8 `cascadeClosure.ts` 传递闭包；R9 T60–T64 全前端棘轮 + `rfc317-dead-class-invariants.test.ts`）
- [x] AC-6 R10 覆盖仓内每一个 allowlist，基线只降（B2-c；`rfc317-ledger-highwater.test.ts` 34 条，一次性 `allowGrowth` 已完整跑过「声明→用掉→下一笔判过期」的生命周期）
- [x] AC-7 R11 manifest 落地并自变异转红（B2-a/b；`rfc317-architecture-ledgers.test.ts` 两向钉死 + `rfc317-guard-corpus-floor.test.ts` + `rfc317-guard-negative-fixture.test.ts`；guard 分母现 **143**）
- [x] AC-8 R12 语料扩面，扩面后新增违规逐条修或入账（B3-b；T25「public 入口的开放 Record 面精确入账」+ 解析扩面正反 fixture）
- [x] AC-9 52 条 P1/P2 逐条修复 + 红→绿 + 变异复跑确认转红（B11 收口时按 gid 对账发现 **RT-01 从未被任何任务映射**，补为 T71 修掉；`EK-03` 由 R1/R3 承担、`DE-09` 由规则关闭，两者在 `design.md` 有明确处置，非点修）
- [x] AC-10 79 条 P3 逐条入账（B0 入账 + B11 T67 复核：17 条已在本 RFC 内解决，加 `resolvedIn` 并由断言钉死任务号真实存在）
- [x] AC-11 能力影响 C1–C9 各有禁用/拒绝分支覆盖（C3 此前**只有能力影响条目、没有任务**，B11 补 T71 后其两条拒绝分支各有用例，且各自断言「零 spawn」）
- [x] AC-12 `bun run gate:local` 全绿 + 按 exact SHA 的 hosted CI 全绿（含 Playwright / visual）（`a8f36c388` CI **completed/success** 31/31；`7b4076641` 刷完视觉基线后按 exact SHA 复跑 CI + visual 双绿）
- [x] AC-13 19 条 stale 断言逐条改对（B11 T66；并立成 `rfc317-stale-assertion-invariants.test.ts` 的 6 条派生式不变量，规则③另捞出 4 处同类）
- [x] AC-14 索引 / STATE / dev-gotchas 同步（T68 用构造 blob 在共享工作树上只提交自己那几行；T69 追加 13 节）

## 5. 本轮不做（登记）

- RFC-294 W0-R 的其余六份 manifest、SCC 归零、`KNOWN_VIOLATIONS` 归零、route→DB 归零、`AppDeps` 拆解、362 文件完整 owner map、P0-D ownership fence。
- `development-missions:*` 权限点改名（D5，需 grant/PAT 迁移，另立 RFC）。
- RFC-310 的 `os-architecture-manifest.json` 并入 `architecture/`（该 RFC 仍 In Progress，避免撞车；重叠已在 `guard-manifest.json` 登记并标去重波次）。
- 79 条 P3 的实际修复（只入账 + 棘轮锁住不增长）。
- 已归档任务里已丢失的 `review_comments` 的历史恢复（B1 只止血）。

## 6. 实施记录

### B0（2026-08-23）

- **产出**：`packages/backend/tests/architecture/census.ts`（采数内核，守卫与报表共用）、`architecture/{commons-manifest,commons-debt,guard-manifest}.json`、`packages/backend/tests/architecture/rfc317-architecture-ledgers.test.ts`（12 条闭合断言）、`design/RFC-317-*/census-2026-08-23.md`（正式分母报告）。
- **采数环境**：`git worktree add --detach` 物化的分离干净工作树（主树当时带并发 session 的大批未提改动）。
- **数字订正**：inbound 66/19 → **94/28**、outbound 33 → **22**（全部在 application 层）、context 12 → **11**。口径差与原因见 `census-2026-08-23.md §0`。
- **变异实证**：删守卫登记 ⇒ 1 fail；改守卫名 ⇒ 2 fail；账本 baseline 减 1 ⇒ 3 fail；三份文件 `cp` 还原后 `diff -q` 逐字一致，复跑 12/12 绿。
- **偏差**：R1/R2 的**边相等断言**按计划留在 B3（连同正反 fixture 一起落）；B0 只落闭合断言。`guard-manifest.json` 的 `minCorpusFiles` 与 R11 导出式 fixture 元数据留给 B2，条目上以 `classified: false` 让缺口自己可见。
- **顺带发现**：`modules/work-start/` 是零文件、未跟踪、无人引用的**空目录残骸**（不删，按仓规不动未跟踪文件）；生成清单时踩到正则 alternation 顺序 bug（`(?:ts|tsx)` 把 `.tsx` 匹成 `.ts`），漏掉 9 个前端原语，已修并列入 T69。

### B1-a（2026-08-23）—— 两条 P1 + 一条 CI flake

**落地任务**：T5 / T6 / T7 / T10 / T11（T8 / T9 / T9b 留 B1-b）。

- **T5**：`routes/developmentConfig.ts` 新增与 `requireVisible` 对称的写门 `requireOwned`（内部走公共 `requireResourceOwner`），**16 处写路径**（15 处 revise/publish/archive + 1 处 `PUT /api/code/digital-employees/:id/playbook`）切过去；**6 处读路径**原样保留。**能力收缩 C1 生效**。
- **T7**：`tests/rfc317-config-resource-write-gate.test.ts`，五类资源 × 五种情形共 26 条。含**被 grant 的非 owner 写仍 403**——锁死「grant 只授可见、不授写」这条我在 B1 开工前读源码才发现、且与 RFC 初稿写反的事实。正向用例的被测面刻意收在**写门本身**（断言「非 403/404」+ 按实际结果分支断言持久效果），不被各类型的草稿 schema 绑架。
- **T6**：`tests/architecture/rfc317-acl-write-gate-guard.test.ts`，两条不变量 + allowlist stale 检查：①凡**调用** `mountAclEndpoints` 的路由文件必须**调用** `requireResourceOwner`；②`routes/**` 里调用 `canViewResource` 的文件要么也调 owner 判据、要么进带 why 的只读 allowlist。
- **T10/T11**：`tests/architecture/cascadeClosure.ts`（`cascadeEdges` 反射 + `closureOverEdges` 纯图算法分离）；归档对账由**一跳**改**传递闭包**；`review_comments` 进 `ARCHIVED_TABLES`（按 doc_version 归属回到 task 维度的子查询，不用 join 以保持 JSONL 行形状）。**能力收缩 C6 生效**。
- **顺带**：修一条主干既有 CI flake。`local-gate-runner.test.ts` 的三条杀链用例拿 100/150ms 墙钟去赛 `bun -e` 进程启动——本机实测空载 ~20ms、八个忙循环下**达 100ms**，于是在 B0 的 CI run `32619463902` 上红了 `Backend tests (macos-latest shard 4/4)`（杀链本身执行正确，红的是就绪竞态）。按「实测最坏值的数倍」重设预算、保持 kill 时刻与 marker 时刻的相对余量不变，并给就绪断言补前提复核措辞。

**变异实证（每条都做了红→还原→复绿）**

| 变异                                                                                   | 结果                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 16 处写门退回 `requireVisible`                                                         | **恰好 10 条红**（5 条 public-403 + 5 条 grant-403），private-404 与正向组不受影响——预言力对准写门本身 |
| 把 `developmentConfig.ts` 唯一的 `requireResourceOwner` 调用退回（注释里仍提及该名字） | T6 **2 条红**                                                                                          |
| `signalBackendShardProcessTree` 的 `process.kill(-pid)` 改 `process.kill(pid)`         | `local-gate-runner` **3 条红**（含 CI 上红过的那条）——证明加余量没有把预言力抽空                       |
| 从 `guard-manifest.json` 删掉子目录里的守卫登记                                        | **1 条红**（修递归前是静默通过）                                                                       |

**本批踩到并已修的三个自伤**（都写进了对应文件的头注释，供后来者）

1. **守卫枚举不递归**：`guardTestFiles` 初版只扫三个 `tests/` 顶层，而我把第一个新守卫放进了 `tests/architecture/` 子目录 ⇒ 两向钉死看不见它却全绿。这正是 T69 要沉淀的自检第二句（「递归吗？」），写守卫的人当场踩了一次。修成递归后另外还捞出一个**既有**漏网：`tests/integration-opencode/rfc281-boundary.integration.test.ts`。
2. **正向检查被一句注释满足**：T6 第一版用 `text.includes('requireResourceOwner')`，而被测文件的文档注释里提到了这个名字 ⇒ 把导入与调用一起拿掉（事故前形状）仍然全绿。CLAUDE.md 记过它的镜像版（注释里的字面量会踩**负向**锁）；正向锁被注释满足更隐蔽，因为它不会让人怀疑。
3. **正则剥注释会吃掉真代码**：第二版改成「先正则剥注释再匹配调用形态」，非贪婪块注释正则从字符串里的 `/*` 一路吃到下一个 `*/`，把 `tasks.ts` 中间几百行连同真正的 `canViewResource(` 调用一起吞掉，导致 allowlist stale 误报。终版改用 **TS AST 判「被调用过的名字」**，对注释与字符串天然免疫。

**B0 的 CI 结论**：run `32619463902` = **30/31 job 绿**，唯一红格就是上面这条既有 flake，已在本批修复。

### B1-b（2026-08-23）—— ACL 列入网守卫与端点入网预言（零生产改动）

**落地任务**：T9 / T9b。**T8 因发现新事实被拆出，见下。**

- **T9**：`tests/architecture/rfc317-acl-column-enrolment-guard.test.ts`。schema 反射两向锁：①声明了 `owner_user_id` + `visibility` 的表必须是 `AclResourceType`；②每个 ACL 类型对应的表必须真有那两列。实测分母：**13 张表带 ACL 列，12 张已入网**，唯一未入网的是 `employee_definitions`，作为**带具名清偿波次**的豁免入账（`removeWhen: RFC-317 T8`），并额外钉死「待入网集合恰好是这一张」——再多一张就红。
- **T9b**：`rfc099-acl-endpoints-matrix.test.ts` 的入网守卫由**源码正则**换成**运行时预言**。旧版扫 `type: '<literal>'`，而 `developmentConfig.ts` 用工厂 `type: cfg.aclType`（变量）挂载 ⇒ 正则**永远匹配不到**；它恰好命中 7 类，而 CASES 恰好也是那 7 行，于是断言两边相等、全绿，**RFC-310 五类配置资源的跨用户 ACL 端点行为零覆盖**。新版起真 app、从 `allRouteMeta()` 观察实际注册的 `/acl` 端点（与挂载写法无关），再与 `ACL_RESOURCE_TYPES` 和 CASES 三方对齐；同批补上五类的 CASES 行，该文件用例数 **33 → 51**，全绿——说明这五类的 `/acl` **行为本来就是对的，洞在覆盖**。

**变异实证**：删掉 `PENDING_ENROLMENT` 里的 `employee_definitions` ⇒ T9 规则①红；删掉一行 CASES ⇒ T9b 的「CASES 覆盖全部 AclResourceType」红。两者均还原逐字一致后复绿。

### T8 的阻塞点（**需用户裁决**，2026-08-23 读源码后发现）

D2(a)「把 `employee_definitions` 立为第 13 类 ACL 资源」在批准时被理解为「让三列不再惰性」。实际落地时发现它还牵一个**权限模型**决策：

- 今天 `/api/digital-employee-types/:typeRef/employees` 这组员工定义路由用的是 **`digital-employees:read/create/update`**；
- 而 `digital-employees` 这个权限前缀**已经**属于 RFC-310 的另一样东西——`digital_employee` **配置资源**（`digital_employees` 表，`/api/code/digital-employees`，已是 ACL 类型之一）；
- `mountAclEndpoints` 的权限点由 `${resource}:update` 推导，因此给 `employee_definition` 挂 `/acl` 必须二选一：
  - **(i) 复用 `digital-employees:*`** —— 零新权限点、零 preset 变更、零 grant/PAT 迁移，但两样不同的东西共用一个点名，语义混淆（且与 `findings.md TP-05` 记的「权限点名归属」是同一类问题）；
  - **(ii) 新增 `employee-definitions:*` 点族** —— 语义干净，但要动权限目录、角色 preset、用户权限目录顺序表（RFC-305 有硬性顺序门）、存量用户 grant 与 PAT scope 迁移。形态等同 RFC-315，属**独立的产品/权限变更**，不该塞进一个治理批。

在拿到裁决前，`employee_definitions` 由 T9 的豁免账本锁住（不会再多一张同形表），越权面维持现状并如实记录。

### B1-c（2026-08-23）—— T8：`employee_definitions` 立为第 13 类 ACL 资源

**用户裁决**：复用既有的 `digital-employees:*` 前缀，不新开点族，本批落地。

- **内核入网**：`ACL_RESOURCE_TYPES` / `ACL_TABLES` / `resource_grants.resource_type` 枚举 / `ACL_PERMISSION_PREFIX` 四处。第四处是**编译期强制**的——`mountAclEndpoints` 的 `Record<MountedAclResourceType, …>` 让新增一类直接编译报错，正是它逼出了权限点归属这个决策。
- **判据接线（全部留在 transport，ACL 不下沉进模块）**：三个列表面走 `filterVisibleRows`；详情走「不可见 ⇒ 404 与不存在同形」；`PUT /api/digital-employees/:id` 走 `requireResourceOwner`；`/acl` 挂在 `/api/digital-employees/:id/acl`。RFC-310 PR-28 已删除用户手工 `POST …/employees/:id/upgrade` 路由，类型兼容升级改由领域 bootstrap 自动完成。
- **新增窄查询 `getEmployeeDefinitionAcl`**（port + sqlite 实现 + composition 暴露）：只选三列、**不解析配置内容**。落地时实撞两次才定到这个形状——`service.getEmployeeDefinition` 对 `currentRevision === null` 的半成品行抛 not-found；`store.getEmployeeDefinition` 会 zod 解析 `configuration_json`，内容不合 schema 时抛 ⇒ 授权判据会 500。**授权判据必须对任何存在的行可答**，否则半成品行与内容漂移行会从「谁都改不动」退化成 500 甚至绕过判据。
- **迁移 `0204`**：零 schema 改动。存量行不回填（用户裁决），唯一补丁是把 `owner_user_id IS NULL` 的历史孤儿行显式置 `public`——当前写路径产不出这种行，但列可空且唯一索引用了 `COALESCE`，若真有而保持 `private`，入网后它对所有人不可见、无人能修。沿用 RFC-231「框架 built-in 显式保持 public」的口径。
- **覆盖**：新增 `rfc317-employee-definition-acl.test.ts`（8 条：404 同形含**响应体逐字相等**、public 行不被误伤、可见非 owner ⇒ 403 零写入、不可见 ⇒ 404 零写入、owner/admin 放行、三个列表面的 AST 接线断言）；`rfc099` 矩阵补第 13 行，用例数 51 → 61。
- **T9 账本清空**：`PENDING_ENROLMENT` 归空，「待入网集合」断言由 `['employee_definitions']` 改为 `[]`——这是**目标态**，再新增一张未入网的表就红。

**变异实证**：拆掉 `loadVisibleEmployee` / `requireOwnedEmployee` 两处调用 ⇒ 4 条红（3 条行为 + 1 条 AST 接线），还原逐字一致后 8/8 绿。

**本批的一个自伤**：AST 定位 handler 时**只按 path 匹配**，而同一 path 上常有两条路由（GET 列表 / POST 创建、GET 详情 / PUT 更新），于是永远取到最后注册的那条——断言看的是创建/更新 handler，而不是它以为在看的列表/详情 handler。这类「锚错了但恒定错在同一处」的断言比漏测更坏，因为它看起来一直在工作。改成按 **method + path** 定位，教训已写进该文件头注释。

### B1-d（2026-08-23）—— 账本采数 SHA 订正 + 可复算守卫

并发 session 在 `STATE.md` 里指出三份账本记的 `recordedAtSha: efc1bdb01` 走不到。查证属实：那是 rebase **前**的本地 commit，publish 出去的是 `b04cf0eb0`，`efc1bdb01` 从未进过 origin。已核对 `git diff efc1bdb01 b04cf0eb0 -- packages/{backend,shared}` 为空（采数内容逐字相同，只是 SHA 记错），三份账本改记 `b04cf0eb0` 并加 `recordedAtShaNote` 说明 rebase 由来。

**新守卫**：`rfc317-architecture-ledgers.test.ts` 增「每个采数 SHA 都在当前历史上可达」。无 git 环境（shallow clone）显式 skip 并打印原因，不假绿。

**本批的一个自伤**：守卫初版用 `git cat-file -e <sha>` 判存在——变异回 `efc1bdb01` 后**照绿**，因为 rebase 前的对象在本地仓库里仍然存在，只是不可达。可达性必须用 `git merge-base --is-ancestor <sha> HEAD` 判，「对象还在」与「历史上走得到」是两回事。改判据后同一变异 13 pass / 1 fail。教训已写进该 describe 的注释。

### B2-a（2026-08-23）—— T13 / T21：扫语料型守卫必须自证「语料还在」

**动机（findings G-07 / CC-07 实测）**：源码扫描型守卫的绿有两种来源——真没违规，或**扫描根失效 / walk 提前 return / 后缀过滤把语料筛成空**。二者在断言层面完全同形，后者是**永久静默**的假绿：它每次 CI 都绿，还在守卫清单里占着名额。实测把 `rfc294-architecture-preflight.test.ts` 的 `MODULES_ROOT` 指到一个不存在的目录，它 6 条测试里 **5 条照绿**。

- **判据下沉进 `census.ts`**（与账本共用单一实现，不再长第二判据）：`isCorpusScanner`（AST 调用名，注释 / 字符串里提到 `readdirSync` 不算）+ `corpusFloor`（`toBeGreaterThan(n)` 记 `n+1`、`toBeGreaterThanOrEqual(n)` / `toBe(n)` 记 `n`，同文件取最大）。
- **新守卫 `rfc317-guard-corpus-floor.test.ts`**：①凡枚举文件的守卫都必须断言 `>= 1` 的语料下限；②磁盘上「谁在扫语料」与账本 `corpusScanner` 逐条相等；③账本 `minCorpusFiles` 与文件里的下限逐条相等（**静默调低就红**）；④非扫描型守卫不得记 `minCorpusFiles`；⑤豁免账本 `NO_FLOOR_YET` 空表即目标态，且过期 / 无具名波次都红。
- **T21 判据自变异**：11 条内存字符串 fixture 喂回同一份判据（真枚举 / 注释提及 / 字符串提及 / 各 matcher 形态 / `Set.size` / 非规模接收者 / `toEqual([])` 不算下限 / 两判据互相独立）。fixture 一律内存字符串，不依赖仓内某文件恰好保持某形状。
- **回填 22 个守卫**：扫语料型守卫 37 个，原本只有 14 个带下限。其余 22 个（`rfc294` / `rfc305` / `rfc284` / `ux-source-ratchets` 等最吃重的 ratchet 全在内）各补一条语料下限；`rfc217` 的扫描器都是 test 内部局部 walk，改为在同形 walk 上断言 `ROOT` 这个共享前提。
- **清单**：`guard-manifest.json` 全量重算，`classified` 全部转 true，新增 `corpusScanner` / `minCorpusFiles` 两列，守卫数 120 → 121。

**变异实证（5 条，逐条 `diff -q` 还原）**：

1. `rfc294` 扫描根指向空目录 ⇒ 新增的语料下限红（且暴露出它另外 5 条测试仍照绿——正是本批要消灭的形态）；
2. 静默把 `rfc294` 下限 120 → 1、账本不动 ⇒ 两向钉死红；
3. 整块删掉 `rfc305` 的语料下限 describe ⇒ 2 红（缺下限 + 账本漂移）；
4. 削弱判据：删 `corpusFloor` 的 `toBeGreaterThanOrEqual` 分支 ⇒ 6 红（含 4 条 T21 fixture——**判据变弱会先咬到自己**）；
5. 放宽判据：`isCorpusScanner` 退回文本判据 ⇒ T21 的「注释里提到 readdirSync 不算」红。

### B2-b（2026-08-23）—— T14 / T15 / T21：断言「不存在」的守卫必须证明自己还咬得动

**动机（findings G-07）**：T13 挡的是「扫了个寂寞」；这一批挡的是另一半——**语料还在，但 matcher 不咬了**。正则被「整理」掉一支、AST 判据漏掉一种语法形态、needle 被改名，违规集合同样回到空，而语料下限还绿着，扫描器看上去健康得很。G-07 原话是三条最吃重的 ratchet 在**散文**里声称做过变异实证，但仓里没有一条今天还能复跑的 fixture；它还给了具体证伪方式：把 `rfc284` 的 `SPAWN_PATTERNS` 改成匹配不到任何东西、再清空 `ALLOWLIST`，整个 suite 照绿。

- **判据（`census.ts`，与账本共用）**：`assertsAbsence`（有没有 `toEqual([])` / `toHaveLength(0)` / `toBe(0)` / `not.toMatch` 形态的断言）+ `negativeFixtureAssertions`（把**伪造输入**喂给某个决定过程、且**完全不碰真实语料**的断言）。
- **受管面刻意收窄**：只管「扫语料 **且** 断言不存在」的守卫（37 个里 34 个）。只断言**存在**的守卫（`expect(sites.length).toBeGreaterThanOrEqual(4)`）自带证明——扫描一失效就掉到 0、当场转红，再要求配 fixture 就是纯仪式。判据窄一点但每条都必要，比宽而掺水更耐用；后者会让豁免账本慢慢变成停车场。
- **新守卫 `rfc317-guard-negative-fixture.test.ts`**：受管守卫必须至少有一条负 fixture；`assertsAbsence` 与 `negativeFixture` 两向钉进账本（**删掉一条 fixture 必须是一次有记录的决定**）；豁免账本 `NO_FIXTURE_YET` 空表即目标态。
- **回填 34 个守卫，豁免为零**。其中 **12 个**是先把判据从 test 体里提到模块顶层 / 抽成纯函数才有得喂——`NAKED_STATUS_WRITE`、`countOccurrencesIn`、`DISJUNCTION`、`FORBIDDEN_TASK_INTERNALS`、`reviewedCallCounts`、`spawnHitsIn`、`sourceHasCodePattern`、`isSchedulerSourceLock`、`heavyColumnsIn`、`RETIRED_TRIGGER_SYMBOLS`、`isAgentMultiOffender`、`mentionsDeadClass`、`usesVariant`、`WG_CONSTANT_IMPORT`。**判据各留一份拷贝的话，fixture 证明的只是拷贝还活着**，这一步不是顺手重构而是前提。

**变异实证**：

1. **G-07 点名的那次证伪**：`SPAWN_PATTERNS` 全部改成匹配不到任何东西 + `ALLOWLIST` 清空 ⇒ 从「整个 suite 照绿」变成 **2 红**；
2. 整块删掉 `rfc292` 的负 fixture ⇒ 2 红（缺 fixture + 账本漂移）。

**判据本身写了四版，前三版都判错，两个方向的错都出现过**——每一版的错法都固化成了 T21 的 fixture：

| 版本 | 错法                                                       | 后果                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v1   | 要求断言里语法上出现顶层 matcher 名                        | 判**紧**：matcher 藏在局部 `probe()` / describe 作用域 helper / `Object.fromEntries` 外壳下的合格 fixture 全被判成不合格                                                                                     |
| v2   | 只把**顶层**名字算作语料                                   | 判**松**：`const offenders = files.filter(…includes('function describeError('))` 里的 `offenders` 被当成 fixture 载体，于是 `expect(offenders).toEqual([])` 这条彻头彻尾的**规则**断言被记成「有负 fixture」 |
| v3   | 语料只传播一跳                                             | 判**松**：`files → offenders → filtered` 链条上后段脱管                                                                                                                                                      |
| v4   | 不要求具名 matcher；语料传播跑到不动点；伪造文件名也算输入 | 26 → 34 且假阳性归零                                                                                                                                                                                         |

判**松**的方向更坏：缺 fixture 的守卫凭空达标，判据自己成了假绿源。所以 T21 的 fixture 表里两个方向各留了样本，任何一版回归都会当场红。这也是本 RFC 反复讲的那件事的又一次实例——**判据比现实窄，就会逼着后来的人把代码写成判据认得的样子**；判据比现实宽，豁免面就会悄悄扩大。

**顺带发现（他人在制品，非本批引入）**：并发 session 未提交的 `digitalEmployeeBuiltinToolCatalog.ts` 里新增的 `agentParts.join(':')` 触发 `rfc254-platform-surface-guard` 的 `posix-path-list` 规则。`origin/main` 上该守卫 4 pass / 0 fail，属未落地改动踩到既有守卫——看起来是误报（拼的是 agent id 而非 PATH 列表），需要一条带 why 的 allowance，留给该改动的作者处置。

#### B2-b 的两个自伤（都由既有门禁当场抓住）

1. **fixture 自己触发了别的守卫**。给 `agent-multi-grep-guard` 写负 fixture 时，样本路径随手写成 `'packages/backend/src/services/scheduler.ts'`。该文件本来就调 `readFileSync`，于是它同时满足 `rfc287` 清单判据的两支（读文件 + 点名 scheduler.ts），被判成一条新的「scheduler.ts 源码文本锁」，`scanActual()` 与钉死的清单不再相等 ⇒ 全量门禁 shard 3 红。
   **正确处置是改 fixture、不是改清单**——那个文件并不锁 scheduler.ts 源码，把它加进清单等于让清单开始说谎。样本路径改成 `services/nodeExecutor.ts` 即可。这条恰好演示了钉死清单的价值：**一个纯属巧合的字符串**都能让清单发现有东西变了。
   一般教训：**fixture 里的伪造样本仍然是仓里的真实文本**，会被别的源码扫描型守卫看见。写样本时避开其它守卫的 needle（尤其是文件路径、退役标识符这类高辨识度字符串）。

2. **脚本化插入的代码不过 prettier**。本批多数编辑是脚本按行拼接进去的，11 个文件的格式与 prettier 不一致 ⇒ `format:check` 红。`bun run format` 修完后 **必须重算账本**——`guard-manifest.json` 记了每个守卫的 `lines`，重排会让它漂移。顺序是：改代码 → format → 重算账本 → 再跑门禁。

### B2-c（2026-08-23）—— T16–T21：账本只许缩，棘轮不留免费槽位

**T18 `rfc217` G5（findings G-04）**：原棘轮是 `toBeLessThanOrEqual` + `strategies/ ⇒ Infinity`，两处都漏水。`<=` 让收敛出来的差额变成**可复用的免费槽位**——实测漏了 3 个（`room.ts` 记 1、`dwActions.ts` 记 2，两者都已收敛到 0）；`Infinity` 让 `strategies/` 整个目录不设上限（「新增比较必须落在 strategies/」是**放置规则**，不等于放进去就不用记账）。改成 `toEqual` 逐字相等：**增**是新散射，**减**是收敛了、去把账本改小，收敛必须留下一次提交记录。变异实证：往 `strategies/freeCollab.ts` 与 `room.ts` 各加一处 `mode === '`，两次都红（改之前两次都绿）。

**T19 `rfc143` 豁免表（findings RT-02）**：三条豁免里**两条已死**（`routes/runtimes.ts` / `services/runner.ts` 早已不含任何 kind 判别）。死豁免不是「多余的一行」，是**空白许可证**——那两个文件里以后新长出来的 kind 判别会被直接跳过。清掉两条，新增 stale 检测（豁免必须仍对应一处真实违规），并把**原本各写一遍**的判别正则提到模块顶层（扫描与自检共用一份，否则自检证明的只是拷贝还咬得动）。

**T16/T17 高水位（findings CC-06 / CC-03）**：十二份债务账本各有精确相等或 stale 检测，挡得住「悄悄加一条**违规**」，挡不住「加一条**豁免**」——同一个 PR 里两边一起改，全绿。更根本的是「账本整体在长」此前没有任何地方看得见：加一条只是 diff 多两行，没有一个数字会变。新增 `architecture/ledger-baselines.json` + `rfc317-ledger-highwater.test.ts`：条目数与源码逐字相等，且相对上一个 commit **只降不升**（要升须显式 `allowGrowth` 并点名 RFC，且在下一个不涨的 commit 上被判过期、强制清理）。

**T20 cruiser 声明**：四条规则的注释声称存量债「已入账」。实测 `no-auth-to-services` 的声明**已过期**——T24 把 `authLoginPolicy` 迁进 `auth/loginPolicy.ts` 后 `auth/` 对 `services/` 已零值边，`KNOWN_VIOLATIONS` 里一条都没有，而注释仍宣称债是有人管的。改为 `@ledger KNOWN_VIOLATIONS` **机器标记**双向钉死（有标记必须有条目，有条目必须有标记）。

#### B2-c 的四个自伤（三个被自己抓住，一个被门禁抓住）

1. **守卫自己静默跳过**。T17 初版把「比对上一版基线」写在 test 里，读不到上一版时 `return`。写这条守卫的当下 `ledger-baselines.json` 还没进过任何 commit，`git show HEAD~1:` 读不到 ⇒ 整条检查静默跳过，**实测「加豁免 + 把基线一起改大」照绿**——守卫犯了它要防的那个错。改：比对逻辑抽成纯函数（fixture 直接喂，不依赖 git）+ 「历史比对确实跑了」自陈断言，跑不成时把原因打印出来。
2. **静态清点与运行时背离**。`ledgerEntryCount` 数语法元素，`KNOWN_VIOLATIONS` 因此得 20，运行时是 35——两处 `...ARRAY.map()` 展开没被展开计数。**展开内部从 15 条涨到 30 条时那个 20 纹丝不动**，正是本棘轮要堵的通路。改：展开按源数组长度计数，并加一条「静态清点 === 运行时 `.length`」对账断言。
3. **散文判据分不出断言与其否定**。T20 初版用正则找「已入账 / Ledgered / KNOWN_VIOLATIONS」。把过期声明**改正**成「T24 已落地，KNOWN_VIOLATIONS 里不再有本规则的条目」之后，那段话仍命中同一个正则——一句断言和它的否定在正则眼里同形。改用 `@ledger` 机器标记。这条正是本 RFC 的核心命题在自己身上的实例：**要判定的东西必须机器可读，不能是写给人看的话**。
4. **注释块用固定窗口取会串味**。T20 初版取「`name:` 行上下固定行数」，串到隔壁规则，把 `no-shared-to-app` 误判成「声称入账却没条目」。改为按规则块边界取。

**顺带修掉的清单盲区**：`rfc317-ledger-highwater.test.ts` 放在 `tests/architecture/` 下，但文件名不含 `guard|lock|ratchet|architecture` 任一关键词，于是**没进 `guard-manifest.json`**——一条崭新的守卫从第一天起就能被静默删除，而两向钉死那条断言照绿（磁盘侧与清单侧同时看不见它）。改 `guardTestFiles`：`tests/architecture/` 下的每个测试都算守卫，**目录本身就是声明**。

**留给 B3 的缺口**：`GUARD_FILE_NAME_PATTERN` 仍以文件名关键词圈定 `tests/` 顶层的守卫。实测 `rfc143-runtime-driver-capability.test.ts` 是扫语料 + 断言不存在的守卫，却因名字不含关键词而不在清单里、也不受 T13/T14 约束。放宽这个 pattern 会大量改变清单规模，需要单独测量后再动。

### B3-a（2026-08-23）—— T22/T23/T24/T26：模块边界三条规则落地

**R1（inbound，94 条）/ R2（outbound，22 条）**：与 `commons-debt.json` **逐条 `toEqual`**。用相等而非 `<=`，理由同 T18：`<=` 会把收敛出来的差额变成下一个人的免费槽位。R2 另加一条层别断言——B0 采数时 22 条全在 `application`，一旦出现 `domain` / `engine` 反向依赖 legacy，那比 application 严重得多，必须单独审而不是混进同一个数字里。

**R3（模块形状，12 个模块）**：subject 由 `readdirSync(MODULES_ROOT)` 派生且**目录缺失必须抛错**（返回空 = 规则静默失效，本 RFC 通篇在防的形态）。量出两个非常规形状，均入账而非放过：`intent`（只有一个 domain 文件、无 public 合同）、`integration`（非 exact public 入口 `mrTerminalControl.ts`，与 rfc294 的 `PUBLIC_SURFACE_PILOT_DEBT` 同源）。

**`work-start` 的处理**：`modules/work-start/` 是**零追踪文件的空目录残留**（git 追踪不了空目录，CI 的干净 checkout 根本没有它）。若直接进 subject，本地与 CI 的模块集合会不一致——规则本身变成环境依赖。处置：按 `git ls-files` 判定追踪面，零文件目录排除并打印警告，同时加一条**反向断言**「零文件目录必然零追踪文件」防止这个口径本身坏掉。

**变异实证（3 条，均双向）**：

1. 账本删一条 R1 ⇒ 红（模拟「新增越界边没入账」）；
2. 账本加一条不存在的边 ⇒ 红（模拟「债还掉了没销账」）；
3. 删掉 `importEdges` 的动态 `import()` 一支 ⇒ **只红 T26 那条 fixture，R1 主断言仍绿**——因为当前生产代码没有一条动态 import 越界边。**这正是 fixture 不可替代的实证**：真实语料证明不了「判据能处理一种当前没人用的写法」，而那恰恰是最容易被"整理"掉的一支。

#### 本批的两次「被自己的机制抓住」

1. **新守卫没登记进清单 ⇒ 五条断言同时红**。B2 建的两向钉死（清单↔磁盘、语料下限、负 fixture）在我自己身上生效了。重算清单后 124 个守卫、36 个受管、零缺口。
2. **`bun test` 21 条全绿，门禁 `tsc` 红**。`edgeKey` 的参数写成 `Pick<BoundaryEdge, …>`，吃不下从 JSON 读出来的账本条目（`edgeKind` 那边是 `string`）；另有两处 `Record<string, number>` 索引在 `noUncheckedIndexedAccess` 下是 `number | undefined`。**运行时不做类型检查，这类错只有 `tsc` 抓得到**——教训写进了 `edgeKey` 的注释。

**门禁归属**：首轮全量门禁 13 条后端失败 + 1 条前端失败。逐条核实**无一属于本批**——本批只动 2 个文件（清单 JSON + 新守卫）。后端 13 条是负载（抽 `rfc258-file-symbols` 隔离跑 12 pass / 0 fail；无争用重跑 **11932 pass / 0 fail**），且负载有我一份责任：杀掉上一轮门禁后立刻重跑。前端 1 条是 `responsibility-swimlane-auxiliary-cards.test.tsx`，该文件**正被并发 session 编辑**（有未提交改动），组件本身与远端一致。

### B3-b（2026-08-23）—— T25：R12 解析语料扩面

**扩面本身比预想小**：解析器早就会跟 `export * from` 链，唯一缺的是 `resolveUnit` 认不出 `@agent-workflow/shared`（模块里 72 处这样的 import）。补上它 + 把 `shared/src`、`backend/src/platform` 加进**解析**语料（subject 不变，各规则内部仍按 `moduleLocation` 只认 `modules/**`）+ `FORBIDDEN_TYPE_IMPORT` 补 `@/platform` `@/embed`。

**扩面后浮出 9 条**，逐条查证后的处置**与 design 原文有两处偏离**（已记进 `design.md` R12 的偏离栏）：

1. **8 条 `unsafe/open type TypeQuery` 是判据假阳性，不是违规**。shared 的 740 个导出类型别名里 **586 个**是 `z.infer<typeof …>`，全仓另有 **85 处** `(typeof CONST)[number]`、6 处 `keyof typeof`；而**裸 `typeof value`**（真正开放的形态）全仓只有 **2 处**且都不在 public 链上。不加豁免 ⇒ 规则与「shared 可解析」结构性冲突；把它们当债务入账 ⇒ 把用了 586 次的单一事实源写法记成债，污染账本含义。新增「确定性 typeof 派生」豁免，只认那三种形态，裸 `typeof` 一个不放。
2. **`Record` 从「禁令」改为「精确账本」**。public 入口 13 处 `Record<…>`，4 处键是穷尽联合（正解），9 处 `Record<string, …>` 里多数**本就该开放**（任意 YAML frontmatter / 用户自定义 trigger 参数 / 错误 details 包 / 外部系统标识键值对 / 泛型 merge 助手）。硬禁 ≈ 89% 假阳性。**判据宽而掺水与判据窄而漏，坏处不对称；而「制造假阳性逼人绕过」是最坏的一种——它训练所有人学会忽略这条规则。** 账本里点名了唯一值得改的一处：`integration/public/events.ts` 同文件 34 行已用穷尽键、50 行却退回 `string` 键。

**唯一真违规已入账**：`identity-access` 的 public 合同 `insertInitialUserAccessInTransaction` 把 `@/platform` 的 `TransactionScope` 摆进签名，两个 legacy 消费者（`auth/loginPolicy.ts`、`services/userIdentities.ts`）因此必须认识平台层持久化类型——public 合同不自洽。修法要给 identity-access 定义模块自有事务端口，属该 context 的架构决策，本批只入账不代改。这条让债务表 1 → 2，**触发了 B2-c 建的 `allowGrowth` 闸门**：涨账必须写具名声明。机制反过来约束了作者本人。

**预算一字未动**。扩面后 god-surface **仍然通过**——design 担心的「解析不到导致预算失明」属实（fallback 成 1 片叶子），但那个 mega-DTO 实例被真正解析后依然在 24 片叶子内。如实记录，不夸大。

#### 本批最重要的一次自我暴露：改动在写出来的当天就是**不可证伪**的

T25 落地后跑两条变异——**两条都没被抓住**：①撤掉 `resolveUnit` 对 shared 的识别（退回扩面前的失明）；②把豁免放宽成「任何 typeof 都放行」。全部断言照绿。原因与 T26 撞到的那次同源：**真实语料证明不了它当前没有触及的性质**——今天没有一条公共合同里躺着裸 `typeof value`，叶子数即使被低估也仍在预算内。

补三组 fixture（27 字段的 shared DTO 嵌进 public 合同 / 三种确定性派生 / 裸 typeof）后，**三个方向全部转红**：撤掉扩面红、豁免放宽红、豁免收得过窄红（fixture 与真实棘轮同时红）。

**教训**：给扫描器扩面时，「扩面后仍然全绿」既可能是「真的没有新违规」，也可能是「扩的那部分根本没被任何断言用到」。两者同形。**扩面必须同批给出一条会因为扩面而变色的 fixture**，否则这次扩面从第一天起就可以被无痕撤回。

**门禁归属**：backend 4 分片全过、frontend 过、typecheck / format / depcheck 过；lint 红一条——`BoundaryEdge` 在我把 `Pick<BoundaryEdge,…>` 换成结构化类型后成了死引用（`--max-warnings 0`，正是 CLAUDE.md 记的 RFC-140 教训）。已删。另有一条 typecheck 错在 `execution-contract-platform.test.ts`，该文件有并发 session 未提交的 17 行新增，不属本批。

### B4-a（2026-08-23）—— T27（R4）：身份分派必须编译期穷尽

**测量先于结论**。D4 原本裁的是「`core: true` 内核的业务身份字面量预算直接归零」。实测 31 个 core 内核里有 **18 处**身份字面量、涉及 6 个文件；逐条读过之后，「归零」这个口径需要修正——因为这 18 处分属**三种性质完全不同**的形态：

| 站点                                                          | 形态                                                      | 判定                         |
| ------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------- |
| `executor.ts#startExecution`                                  | 3 分支，兜底**静默当成 workflow**                         | 真隐患 → 本批修              |
| `outcome.ts#projectExecutionOutcome`                          | 4 分支 + `const unhandled: never`                         | 前人已按 RFC-304 事故修好 ✅ |
| `workflowScope.ts#promotedSourceForWrapper`                   | 3 分支，兜底 `return null`（**失败关闭**）                | 入册留痕，不要求穷尽         |
| `nodePorts.ts` / `wrapperFanout.ts` / `systemChannelPorts.ts` | `Record<NodeKind,…>` 穷尽表，或跨不同注册表的**合取守卫** | 不适用                       |

**判据落在「兜底」而不是「字面量」**。危险的从来不是代码里出现 `=== 'workgroup'`，而是**分派链的兜底会把新种类静默当成某个旧种类**。`outcome.ts` 里前人留的注释就是这个事故的一手记录：code-round 曾掉进 workgroup 分支，`workgroupModeOf(null)` 返回 null，结果是 `status: 'done'` + `outputs: {}` + 一条 `workgroup-config-unparsable` 警告——**一个看起来成功、实则空输出、还赖在它根本没有的配置头上的结果**；原话「the failure was in the arm NOBODY would think to check」。

**生产改动（1 处）**：`executor.ts#startExecution` 的 `if` 链改为 `switch` + `const _exhaustive: never`（本仓既有写法，`shared/src/lifecycle.ts` 用了 5 处）。行为逐字不变。**变异实证**：给 `StartExecutionRequest` 加第四个变体 ⇒ 编译报错 `Type '{ kind: "probe-new-kind"; … }' is not assignable to type 'never'`；**改之前**同样的新增会被静默路由到 `startTask`（当成 workflow），编译与测试**零反应**。

**判据三条边界，各配正反 fixture**（每条都对应判据实际犯过的错）：

1. 字面量从注册表**派生**，不手抄——手抄的集合会随注册表增长而过期，而过期的表现是「扫不出违规」，与合规同形。另加一条自检：注册表派生不出值时**先红**（改名 ⇒ 三条断言同时红，实证过）。
2. 按**判别表达式**分组，不是数字面量总数。初版数总数，把 `isAggregatorAgentNode`（`node.kind !== 'agent-single'` 加 `agent.role === 'aggregator'`，先判种类再判角色）误报成分派——那是**合取**，根本没有分支。
3. 失败关闭的兜底入册即可。`return null` 与「被当成 workflow 启动」不是一个量级。

#### 顺带修掉自己守卫的一个判据缺陷（用起来才暴露）

T17 的「基线只降不升」初版一律拿 `git show HEAD~1:` 比。**CI 里工作树 == HEAD，比 HEAD~1 是对的；本地带着未提交改动时，它跳过了 HEAD**——上一笔已经提交过的涨账会被重复算成「本次增长」，一次性的 `allowGrowth` 也就永远判不了过期。改为按**评估对象**选基准：基线文件脏 ⇒ 比 `HEAD`，干净 ⇒ 比 `HEAD~1`。

**一次性许可完成了一个完整生命周期**：B3-b 涨账时声明 `allowGrowth` ⇒ 通过；本批不涨账，许可按 T17 收回 ⇒ 通过；把许可加回来（未涨账）⇒ **判过期转红**。机制刚刚约束了它的作者本人。

### B11（2026-08-24）—— 收口：T66 / T67 / T69 / T70

**落地任务**：T66 / T67 / T69 / T70（T68 见下一条提交，需在他人在改的共享索引文件上落笔）。

- **T66（AC-13）**：19 条 stale-assertion 里 6 条已在前批修掉（LC-07 / NK-04 / NK-11 / CC-10 / DE-07 / G-11），本批改对剩下 13 条。新增 `tests/architecture/rfc317-stale-assertion-invariants.test.ts`（6 条规则 + 语料下限），每条判据的一端都是**活的源码**：`ACL_RESOURCE_TYPES` 长度 / `db/schema.ts` 的 `builtin` 列数 / 真实 import / `services/lifecycle.ts` 是否导出同步内核入口 / `ws/registry.ts` 是否挂了 upgradeGate / `design/plan.md` 的 RFC 索引状态。
- **T67**：79 条 P3 的 gid 与 `commons-debt.json` 本就两向钉死且绿。真正的问题是**账本自己成了过期断言**——79 条统一写着「本 RFC 只登记不修」，而收口时其中 **17 条已在本 RFC 内被修掉**。已解决的加 `resolvedIn` 并改写 `why`，部分解决的写明「修了哪半、没修哪半」（ACL-05 / LC-12 / TP-12）；新增断言钉死 `resolvedIn` 必须点名**真实存在于本 plan.md 的任务号**。
- **T69**：`docs/dev-gotchas.md` 追加 12 节。除计划列出的 9 条外，另沉淀本批实撞的三条：账本类的数只信程序打印的值（`grep -c` 数不到 `...ARRAY.map()` 展开，22 vs 真值 37）；订正过期断言时复述旧措辞会踩到自己刚写的守卫（定式：历史措辞进引号 + 扫描前剥引号 + 归属按注释块）；`:has()` 是 (0,2,0)，换成单类修饰符会被后面的基类规则压掉。
- **T70**：见下。

#### T70 —— 退役判定：**无一条机制被 R1–R12 完全覆盖，全部保留**

判法不是读判据措辞，而是**删掉旧守卫后，新规则对同一变异还红不红**。逐条实测：

| 候选                                                                       | 新规则                     | 同一变异下的实测                                                                                                  | 判定                                     |
| -------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `rfc286-f1-dead-class-extinction`                                          | R9.3 全域死 class 不变量   | 重新引入 `error-text` ⇒ **两者都红**；但把 `form-error` 放进**非 ScriptEdit** 文件 ⇒ RFC-286 F1 红、**R9.3 照绿** | **保留**（判的不是同一件事）             |
| 前端 `dialog-grep`                                                         | R9.1 modal chrome 全域规则 | R9.1 是**否定式**（不许自造 chrome），dialog-grep 还有**肯定式**断言（那三个文件必须 import 并渲染 `<Dialog>`）   | **保留**（T64 已加头注 + coverage 自证） |
| `data-table-callsite` / `empty-loading-callsite` / `btn-variants-callsite` | R9                         | 同上：迁移白名单是「已迁移的不许退回」的**肯定证据**，R9 是「新写的不许跑偏」的否定规则                           | **保留**                                 |
| `rfc294-architecture-preflight` 的两条 debt list                           | R1 / R2 精确边账本         | design §6 已定「原样保留」；R1/R2 记的是**边**，debt list 记的是**规则级存量**，粒度不同                          | **保留**                                 |

`form-error` 那一条值得单独记，它是本次判定里唯一一个「看起来该退役、实测不能退」的：
**R9.3 判的是「这个 class 在 CSS 里有没有定义」，RFC-286 F1 判的是「这个定义在这个语境里生效吗」**。`.script-env-table__row .form-error` 是一条**嵌套**定义——token 在 CSS 里确实存在，所以 R9.3 认为它已定义；但它只在 ScriptEdit 的 DOM 语境下生效，别处用就还是无样式裸文本。两条规则一强一弱不成立，是**正交**。

顺带一条一般性教训（已进 `docs/dev-gotchas.md`）：判「新规则是否覆盖旧规则」不能比较判据的措辞，要比较**同一变异下的红绿**——措辞上「全域 ⊇ 三个文件」看起来天经地义，实测却是两条正交的判据。

#### T71（补录）—— C3 有能力影响条目，却从来没有任务（B11 逐条对账才发现）

收口时按 gid 把 `findings.md` 的 52 条 P1/P2 与任务表对了一遍，发现 **`RT-01` 不被任何任务行引用**。回看 `proposal.md §能力影响清单`，它就是 **C3**——用户在开工时已逐项确认过的九条之一：

> **C3** | `POST /api/runtimes/probe` 的 `extraArgs` / `isSandbox` | **无能力门**：请求可对任意 runtime 带上这两个字段并真实拉起子进程

也就是说：**它在批准清单里，却没落进任务分解**。AC-9 与 AC-11 都会因此在「看起来都做完了」的状态下静默不成立。这正是本 RFC 一直在讲的形态，只是这次账本是它自己的 `plan.md`。

**修法**（按 finding 的拟建守卫）：

- `runtimeRegistry.ts` 新增导出 `assertRuntimeSpawnCapabilities(protocol, {extraArgs, isSandbox})`（内部复用既有的 `validateExtraArgs` + 此前**未导出**的 `validateIsSandbox`）；
- `routes/runtimes.ts` 的**三处** `smokeRuntime(` 站点各自在 spawn **之前**过门。第三处（`/api/runtimes/:name/probe`）入参来自已持久化的行、不是 RT-01 点名的请求体通道，仍然过门是有意的：driver 的能力声明可能在该行写下之后**被收回**，那时按旧行去 spawn 就成了绕过；三站点判据一致也让源码棘轮不必区分「哪些站点算数」；
- 用例四条 + 源码棘轮一条 + matcher 自证两条。行为用例的要点不是状态码而是**零 spawn**——`422` 分不出「拒绝了」与「跑完才拒绝」，而 C3 的危害恰恰在于后者（预检 smoke 跑在 `createRuntime` 之前，"保存时会校验"救不了它）。

**变异实证**

| 变异                                  | 结果                                                 |
| ------------------------------------- | ---------------------------------------------------- |
| 撤掉 `/probe` 的门                    | **3 fail**（2 条行为 + 棘轮）                        |
| 撤掉预检 smoke 的门                   | **2 fail**（1 条行为 + 棘轮）                        |
| 撤掉具名 probe 的门                   | **1 fail**（只有棘轮——该站点无行为用例，与设计一致） |
| 合成样本：无门的 spawn / 有门的 spawn | matcher 自证正反各一，判据既咬得动也不误伤           |

**一般性教训**（已进 `docs/dev-gotchas.md`）：**能力影响清单与任务分解是两份账本，它们之间没有任何机器判据。** 逐项确认过的能力收缩会在写 `plan.md` 时漏掉一条而不留痕迹——两份都在仓里、都被 review 过、都看不出少了什么。收口前拿 gid / 编号做一次两向对账，成本是几分钟。

#### T65（2026-08-24）—— 视觉基线：按仓规「先红、审图、只提交被接受的 Linux 基线」

B10 的 T61 补齐五族「有调用无定义」的 CSS 之后，`visual-regression-nightly` 在
`4b72bb325` 上红了三个场景。其中两个（`RFC-199 editor 1179 / 390 inspector`）是 T62 引入的
**真几何回归**，已在 `117767435` 修掉并复绿；剩下一个 `/code/policies (light)` 是**真实
外观变化**（35,673 px / ratio 0.04）。

审图结论（已呈用户并获接受）——差异有**两个来源，都已在 main 上**：

- **副标题**由正文大小的裸文本变为更小、更淡、贴紧标题，下方整块上移约 37px。这就是 T61
  的修复本体：`.page__subtitle` 此前有 5 处调用、`styles.css` 里**零定义**，也就是说这行字
  一直是没有样式地渲染出来的。新外观才是与 `/agents`、`/workflows` 一致的档位。
- **左侧导航** `Run outcomes` → `Event Center`、底部新增 `KNOWLEDGE` 分组、两个图标更换，
  来自并发 session 的 RFC-310（`8504d7e7a`，早于 B10）。该提交与 B10 之间**没有 visual
  运行**，于是两处独立改动在同一次运行里一起变红——这一点值得记：视觉门是**按提交触发、
  按路径过滤**的，两个改动之间若没有一次运行，红格的归因就必须靠读图而不是靠 blame。

处置：只刷 `/code/policies` 一个场景（其余 9 个本来就绿），且**只刷 Linux**——darwin 基线
没有任何 CI 消费者，而在这棵混着他人未提改动的共享工作树上本地重生成会把别人的在制状态
烤进基线。新基线取自 hosted run `32670431322` 的产物，与 `code-policies-actual.png`
**逐字节相同**（sha256 前 16 位 `023ee3b76001fc68`，67658B），不是本地重跑的结果。

### B4-b～B10（2026-08-23／24）—— 提交索引（补录）

收口时发现实施记录停在 B4-a，中间五批只有 commit、没有本文件里的条目。**记录缺失本身就是
账本问题**（这正是本 RFC 治的那一类），补一份按批次的提交索引；每笔的详细依据与变异实证在
各自的 commit message 里，此处只做导航。

| 批次 | 提交                                                        | 内容要点                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B4-b | `fd5bf53cf` `ec0be2628` `78b483911` `f8a5eb6c0`             | T30（DE-04 响应目标启动权限门改注入的穷尽表）/ T31（DE-03 失败类别 + DE-05 平台 slot 显式契约）/ T32（DE-07 通用词汇禁令由**一个单词**改为派生词汇集）/ T33（RT-03 runtime 围栏豁免由整目录收窄为两个驱动实现目录）                                                      |
| B5   | `6a16bcaa7` `583e7ffc2` `6545db54d` `6c8b00e24`             | T36/T38/T39 三处「默认值即逃生门」收口 / T37（CC-04 事务端口加 `NotPromise` 约束，S-10 词法禁令升级为站点账本）/ T34·T35（EK-01 spawn 站点声明治理形态，两个 RFC-310 runner 接入组治理）/ T40（CC-02 删除第二套提示词围栏内核 + 全域采用率棘轮）                         |
| B6   | `8d9a24013` `d9100832a` `fdcb72e58` `270fead5b` `51cdc96e1` | T42·T43（注册表反向完备守卫 + 处置四处死声明）/ T45（DE-08 删手抄 implementation 联合）/ T44（DE-06 终态种类收成一份词汇 + 一份分类表，**修两个真 bug**）/ T46（CC-03 历史迁移别名表去重 + 会自己过期的存活判据）/ T41（R5 表归属规则 + 三处跨界直查收口为 public 端口） |
| B7   | `b67fb839c`                                                 | T47–T51 生命周期公共层：转移表变成**真预言**（CAS 站点的 `allowedFrom` 必须能从表推出来）、三处逃生口收成只减不增账本                                                                                                                                                    |
| B8   | `8cd175c6b`                                                 | T52–T56 transport/platform：契约覆盖由正则改为**问框架**（运行期预言）、路由门两个洞上棘轮、修掉 `work-start` 静默重绑                                                                                                                                                   |
| B9   | `4168315ea`                                                 | T57–T59 shared 注册表：`list<markdown>` 落库前被按行切碎（**数据损坏**），codec 下沉进 handler                                                                                                                                                                           |
| B10  | `4b72bb325` + `117767435`                                   | T60–T64 前端：五族 class 有调用无定义（渲染成裸文本）、设计系统约束由逐文件白名单改成全域棘轮；`117767435` 修 T62 引入的覆盖层特异度与遗漏调用点两处几何回归                                                                                                             |

#### T73（2026-08-24）—— 替并发 session 的 `70ddac983` 止血（用户批准后代修）

`7b4076641` 的 CI 红两格，且 **ubuntu / macos 同一分片同时红**（确定性，不是抖动）。归因：
两条都出自并发 session 的 `70ddac983`（RFC-310 T232/T233）——**那笔自己没跑过 CI**，第一次
带上它代码的 run 就是我的。用户拍板由我代修两条。

**① `RFC-254 platform surface guard`**：`modules/integration/composition/codeHostEffects.ts`
的 `` `${parsedPrefix.path}/` ``。**守卫的建议措辞（「use isLexicallyInside()」）在这里是错的**，
照做会引入新 bug：两侧都是 **URL path** 而不是宿主文件系统路径——`parsedPrefix.path` 来自
`new URL(url).pathname`（WHATWG URL 恒 `/` 分隔、百分号编码，`\` 不可能出现），`parsed.path`
来自 `parseGitUrl`。`isLexicallyInsideForHost` 会在 Windows 上把路径小写化并把 `/` 换成 `\`，
于是两个不同 namespace 的 code-host project 会被判成同一个。正确处置是走守卫自带的
**permanent: posix-by-contract** 一档逐处入账，`why` 写清这个契约。

> 一般性教训：**源码扫描型守卫的失败信息里那句「改用 X」是一条经验法则，不是判决**。
> 它按**词法形态**匹配，分不出「宿主路径」与「URL path / 仓库相对路径」。照着改之前先问
> 「这两个操作数到底是什么」——本仓 ALLOWANCES 里已有的 4 条 posix-by-contract 豁免全是
> 这个原因。

**② `RFC-317 T23 R2`**：`mrFacts.ts → @/services/codeHost/connections`（`probeCodeHostConnection`）
是一条新增的 module→legacy 反向值边。与同文件既有的 `@/services/codeHost/call` 同形、同波次，
按 R2 逐条入账；`introducedByRFC` 如实写 **RFC-310 T232/T233** 而不是「存量」，
`outboundEdges` 22 → 23。替代它的 public 合同属于 integration context owner 的决定，
本条只记账、不替人做架构决策。

**顺带修掉 T72 判据自己的一个覆盖缺口**：`rfc254-platform-surface-guard` 的豁免表叫
`ALLOWANCES`，而 T72 的账本词汇表里没有 `ALLOWANCE` 这个词——于是那份账本在覆盖规则眼里
**根本不存在**。这个漏词是在**往那张表里加条目时**才发现的：判据的词汇表本身也会有覆盖缺口，
而它和它要防的东西是同一个失效类。补词后该表入网（baseline 19）。
