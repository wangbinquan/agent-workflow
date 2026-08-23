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

| id | 任务 | 产出 |
| --- | --- | --- |
| T1 | 在干净 SHA 上复算全部计数：R1 的 inbound 边、R2 的 outbound 边（按 context / 按层）、R4 的逐文件业务字面量基数、各守卫的语料下界、既有账本条数 | 一份可复跑的采数脚本 + 数字 |
| T2 | 落 `architecture/commons-manifest.json`：公共内核清单（含完整性批判点出的 12 个本轮才发现无人审计的内核） | 清单 v1 |
| T3 | 落 `architecture/commons-debt.json`：R1 94 条 + R2 22 条 + 79 条 P3，每条带 `why` / `removeAfterWave` / `findingId` | 账本 v1 |
| T4 | 落 `architecture/guard-manifest.json`：**116 个**守卫文件逐条登记 + 与磁盘两向钉死（`minCorpusFiles` / R11 fixture 元数据由 B2 补齐） | 守卫清单 v1 |

**退出门**：三份 JSON 落地且被至少一条测试读到；`bun run gate:local` 绿。

### B1 — P1 安全与数据修复（最紧急）

| id | 任务 | finding | 能力影响 |
| --- | --- | --- | --- |
| T5 | `routes/developmentConfig.ts` 五类资源的写路径由 `requireVisible` 改为 `requireResourceOwner`；读路径不动 | ACL-01 | **C1** |
| T6 | 新守卫：RouteMeta 含某 ACL 资源 `:update`/`:delete`/`:archive` 点的路由，其 handler 传递闭包必须命中 `requireResourceOwner`，否则入账 | ACL-01 | — |
| T7 | 行为用例：被授予 view 的**非 owner** 发 PUT / publish / archive ⇒ 403 **且零写入**（durable 与广播均为零） | ACL-01 | — |
| T8 | `employee_definitions` 立为**第 13 类 ACL 资源**（D2(a)）：进 `ACL_RESOURCE_TYPES` / `ACL_TABLES`、列表 `filterVisibleRows`、详情 `canView→404` 同形、写门 `requireResourceOwner`、挂 `/acl` 端点、创建走统一默认三元组。存量行**不回填**；迁移只把 `owner_user_id IS NULL` 的历史孤儿行显式置 `visibility='public'` | ACL-02 | **C2** |
| T9 | 新守卫（schema 反射）：任何同时声明 `owner_user_id` 与 `visibility` 的表必须是 `AclResourceType`，否则入显式收缩账本 | ACL-02 | — |
| T9b | ACL 端点入网守卫由字符串正则改为**运行时注册表枚举**：`mountAclEndpoints` 追加导出注册表，起真 app 后断言 `registeredAclMounts` = `ACL_RESOURCE_TYPES` = 矩阵 `CASES`（今天正则只命中 7/12 类） | ACL-03 | — |
| T10 | R8 级联闭包 helper `cascadeClosure(schema, roots)`；归档对账改闭包版；`review_comments` 进 `ARCHIVED_TABLES`（或显式豁免并写清理由） | CC-01 | **C6** |
| T11 | R8 的孙表 fixture：合成两跳级联表 ⇒ 闭包版红、单跳版绿 | CC-01 | — |

**退出门**：三条 P1 各有红→绿对且做过变异复跑；C1/C2/C6 的拒绝分支各有用例；门禁 + hosted CI 全绿。

### B2 — 守卫的守卫与账本高水位（零生产改动）

| id | 任务 | finding |
| --- | --- | --- |
| T12 | `architecture-guard-manifest.test.ts`：守卫文件两向钉死（删/改名 ⇒ 红） | CC-07 |
| T13 | 每个源码扫描型守卫导出扫描文件数，manifest 断言 `>= minCorpusFiles` | CC-07 / dev-gotchas |
| T14 | 守卫导出 `__mutationFixtures`，manifest 逐条喂给同一 matcher 并断言转红；fixture 一律内存字符串 | G-07 |
| T15 | 按 D7 回填既有 16 个无 fixture 机制 | G-07 |
| T16 | R10 高水位：`KNOWN_VIOLATIONS` / spawn-site / ux-source-ratchets ×3 / rfc143 kind-discrimination / `LEGACY_MIGRATION_HASHES` / rfc294 两条 debt list / `commons-debt.json` 各加 `LEDGER_BASELINE` | CC-06 / CC-03 |
| T17 | 「基线只降」测试（读 `git show HEAD~1:<file>`；无 git 环境显式 skip 并打印原因，不假绿） | CC-06 |
| T18 | `rfc217` G5：`<=` → `===`、删 `Infinity` 分支（当场收回 3 个免费槽位） | G-04 |
| T19 | `rfc143` allowlist 加 stale 检测（当场清掉两条已死条目） | RT-02 |
| T20 | `depcheck-gate` 加元断言：cruiser 规则注释声称「已入账」⇒ 账本必须有对应条目 | G-11 |
| T21 | R11 自变异：改一条 `mustReport: true` fixture 为合法源码 ⇒ manifest 必须红 | — |

**退出门**：manifest 覆盖全部守卫；每条守卫的变异 fixture 跑过并转红；`LEDGER_BASELINE` 自变异红。

### B3 — 边界 scanner 扩面（零生产改动）

| id | 任务 | finding |
| --- | --- | --- |
| T22 | R1 inbound 规则落地（census 已备好 `inboundBoundaryEdges`），**94 条边** `toEqual` 精确入账 + 正反 fixture | G-01 |
| T23 | R2 outbound 规则落地，**22 条边**入账（全部在 application 层，标最短 `removeAfterWave`） | G-02 |
| T24 | R3 模块形状：subject 由 `readdirSync(MODULES_ROOT)` 派生；顶层目录集 / 层内矩阵 / composition 纯净 / public 非空；目录缺失**抛错而非返回空** | G-03 / G-10 / CC-05 / CC-11 |
| T25 | R12：解析语料扩到 `shared/src` + `backend/src/platform`；`FORBIDDEN_TYPE_IMPORT` 补 `@/platform` `@/embed`；public entrypoint 禁非字面量键 `Record`；扩面后新增违规逐条修或入账（**不得调高预算**） | G-05 |
| T26 | R1–R3、R12 各自的正反 fixture | — |

**退出门**：四条规则各带正反 fixture；债务账本与实测逐条相等（新增红、销账不改也红）。

### B4 — R4 业务身份字面量预算 + 相关 P2

| id | 任务 | finding |
| --- | --- | --- |
| T27 | R4 规则：从各注册表**派生**字面量集（不手抄）；匹配 `BinaryExpression` / `CaseClause` / `includes` / `startsWith`；`toBe` 精确断言；断言消息给出正确形状指引。**D4：`core: true` 内核预算直接为 0**，其余按实测钉住 | G-04 / G-08 |
| T28 | `TerminalWorkspacePrunePolicy` 改返回 `{prune, cause}`；`lifecycle.ts` 内 webhook 选列与 `'webhook-terminal'` 字面量清零 | LC-04 |
| T29 | `routes/resourceAcl.ts` 两条 `cfg.type ===` 广播分支移进调用方 `afterUpdate` | ACL-04 |
| T30 | `event-center` 的 `development-missions:launch` 改由 composition 注入 + `Record<TargetKind, LaunchPermissionRef\|null>` 穷尽表 | DE-04 |
| T31 | `workspace-boundary-` 前缀握手改闭合联合 `errorClass`；`'platform'` 魔法 slot 改闭合联合/共享常量 | DE-03 / DE-05 |
| T32 | `genericTypeLiteralBan` 从单词升级为「派生禁用词集 + 精确 allowlist」 | DE-07 |
| T33 | `rfc282-single-implementation-lock` 的 `services/runtime/` 整目录豁免收窄为 `opencode/` + `claudeCode/`；共享层重新入扫描，命中逐条修或入账 | RT-03 |

### B5 — R7 能力站点治理 + 执行/进程 P2

| id | 任务 | finding | 能力影响 |
| --- | --- | --- | --- |
| T34 | R7：spawn / fs-write / transaction 三类站点 allowlist 值加 `governance`，非 exempt 条目须通过 AST 治理断言 | EK-01 / CC-08 / CC-04 | — |
| T35 | 两个 RFC-310 runner 接入受管进程（或补 `detached` + `killProcessTree` + 有界读） | EK-01 | — |
| T36 | `spawnVersionProbe` 的 `timeoutMs` 改必填，删无 timeout 模式 | EK-02 | **C4** |
| T37 | `db/txSync.ts` 导出 `NotPromise`；两个事务端口签名加约束；S-10 词法禁令升级为站点账本 | CC-04 | — |
| T38 | 导出唯一 `repoRelativePathSchema`，两处写侧 `z.string().min(1)` 改 import | CC-08 | — |
| T39 | `memoryInject` 的 `envelopeNonce` 去默认值，改必传判别式 | CC-13 | — |
| T40 | `development-automation` 第二套 prompt 围栏删除，改用 `shared/promptFencing`；补「含 prompt 结构字面量的文件必须 import 共享围栏」全域棘轮 + 对抗 payload fixture 表 | CC-02 | — |

### B6 — 表归属 / 注册表反向完备 / 数字员工 P2

| id | 任务 | finding |
| --- | --- | --- |
| T41 | R5 表归属规则；`DE-01` / `DE-02` 两条互反的私表越界各换 public query port；`ws/registry.ts` 的 raw SQL 读改走 identity-access 既有 port + 补 `no-transport-to-db` dep 规则 | DE-01 / DE-02 / TP-03 |
| T42 | R6 共享 helper `assertEveryRegistryKeyHasAProductionConsumer`，逐注册表套用 | G-09 |
| T43 | 按 R6 结果处置：`REF_DOMAIN_POLICIES` / `EXPORT_CALL_POLICY` 零消费者、`isProcess` 假维度、`code-round` 死行、`INVARIANT_RULES`/`STUCK_RULES` 非穷尽 | CC-10 / NK-04 / NK-11 / CC-09 |
| T44 | `terminalKind` 定为闭合联合 + route 层校验 + 三份分类表改穷尽 `Record` | DE-06 |
| T45 | 删 `task-execution` 手抄的 `implementationSchema`，改 import `execution-contract/public/types` | DE-08 |
| T46 | `LEGACY_MIGRATION_HASHES` 测试改 import 生产常量 + 精确 8 项账本 + 每项 `why` | CC-03 |

### B7 — 生命周期公共层（**串行，独占 `lifecycle.ts` / `task.ts`**）

| id | 任务 | finding |
| --- | --- | --- |
| T47 | `allowedFrom` ⊆ 转移表的静态断言；越界站点逐条改对或入账 | LC-01 |
| T48 | `lifecycle-grep-guard` 的注释标记从「授权」降级为「文档」，改 s14 式逐文件精确计数 allowlist | LC-02 |
| T49 | `allowTerminal` 21 处逐条入账（只锁数量不改语义）；修正 `lifecycle.ts:18` 的**不存在的** ESLint 规则名与「5 个持有者」表述 | LC-03 / LC-07 |
| T50 | 抽 `taskWorkspacePhase(row)`，三处 repo-prep 谓词改 import | LC-05 |
| T51 | 从转移表派生 `CANCELABLE_TASK_STATUSES` / `RECOVERABLE_TASK_STATUSES`，六处手抄枚举 + 前端手写终态析取改 import；补「不得再手抄」棘轮 | LC-06 |

### B8 — transport / platform

| id | 任务 | finding | 能力影响 |
| --- | --- | --- | --- |
| T52 | 契约覆盖扫描器由正则改为运行时预言（`createApp` 后比对 `allRouteMeta()`） | TP-01 | — |
| T53 | 冻结 `EXEMPT_MOUNTS`；`/api/*` 的 ALL 挂载必须入账 | TP-02 | **C7** |
| T54 | `bind` 改「已绑定即抛」；`mountApiRoutes` 里 7 处 `compose*` 提到 `createApp` | TP-04 | — |
| T55 | 权限点域归属断言；四条 `/api/digital-employee*` 引用 `development-missions:*` 按 D5 入账 | TP-05 | — |
| T56 | WS 通道三处手写样本数组改为从 `WS_CHANNELS` 派生 | TP-06 | — |

### B9 — shared 注册表

| id | 任务 | finding | 能力影响 |
| --- | --- | --- | --- |
| T57 | `list<T>` 的 codec 选择下沉到 item handler；registry 级 round-trip 属性测试 | NK-01 | **C5** |
| T58 | `promotedSourceForWrapper` 改 `satisfies Record<WrapperKind, Promoter>`；失败结果 `wrapperKind` 改 `NodeKind \| null` | NK-02 | — |
| T59 | `rfc147-system-channel-ports` roots 补 frontend；两处命中改 import 常量 | NK-03 | — |

### B10 — 前端

| id | 任务 | finding | 能力影响 |
| --- | --- | --- | --- |
| T60 | R9.1/R9.2：原生 `<select>` / `__overlay` 类 / `segmented` / `role=radiogroup\|tablist` 的全域 AST 规则 | G-06 | — |
| T61 | R9.3 死 class 全域不变量（替换 `rfc286-f1` 的硬编码三名单）；五个死 class 家族逐条修 | FE-02 | **C8** |
| T62 | R9.4：`styles.css` 中公共 class 选择器不得被特性名限定（今天 4 处） | FE-* | — |
| T63 | `JoinModeField` 改用 `<Segmented>` | FE-01 | — |
| T64 | 既有四个「迁移白名单」测试各加 stale 断言 | G-06 | — |
| T65 | 视觉基线：若动到已有 scene，按仓规「首次 hosted run 故意红 → 人工审 PNG → 只提交被接受的 Linux 基线」 | — | — |

### B11 — 收口

| id | 任务 |
| --- | --- |
| T66 | 15 条 family + 4 条 critic 的 stale 断言逐条改对（含 `resourceAcl.ts` 的「六类资源」表述、`ref/resolution.ts:87` 的单一事实源声明、`depcheck.ts:28-30` 的「只能缩不能涨」、`system-commons-unification-audit-2026-08-12.md` 的三处过时计数与前端行） |
| T67 | 79 条 P3 入账复核：`findings.md` 的 gid 与 `commons-debt.json` 条目一一对应 |
| T68 | `design/plan.md` RFC 索引登记 RFC-317（状态四选一打头）；`STATE.md` 顶部「进行中 RFC」→ 完工后移入已完成表 |
| T69 | `docs/dev-gotchas.md` 沉淀通用教训：①「守卫只覆盖自己诞生的那一块」的系统性自检定式（写完任一守卫先问「起点面全吗？终点面全吗？subject 是硬编码还是派生？」）；②`<=` 型棘轮会留下可复用的松弛槽位，快照降下去不销账等于白送分支额度；③ 单跳 schema 反射守卫看不见多跳级联；④ 默认参数会让安全语义变成 opt-in，且对导入图 / AST cast 禁令 / 源码文本三类扫描**全部隐形**；⑤ **design 文档里裸写正则会被 lychee 当成 markdown 链接**——`['"](?:a|b)['"]` 这种片段形如 `[...](...)`，CI 的 `Markdown link check (design/)` 会去请求 `(?:a|b)` 并红，本 RFC 落档时实撞（`findings.md` 三处），定式是**正则一律包进反引号** |
| T70 | 若有机制被 R1–R12 完全覆盖，按 `docs/dev-gotchas.md` 三种处置逐条判并记录 |

## 3. 冲突矩阵（多人并发树）

| 文件 / 目录 | 占用批 | 说明 |
| --- | --- | --- |
| `packages/backend/src/services/lifecycle.ts` | **B7 独占**（B4 的 T28 需先于 B7 或并入 B7） | 高冲突；RFC-294 点名严格串行 |
| `packages/backend/src/services/task.ts` | **B7 独占** | 同上 |
| `packages/backend/src/services/scheduler.ts` | 本 RFC 不改（仅 R4 计数读取） | 若 T47 需触碰则并入 B7 |
| `architecture/**` | B0 建立，各批追加；**单 owner** | 账本冲突用「按路径精确 `git add`」处理 |
| `.dependency-cruiser.cjs` / `scripts/depcheck.ts` | B2 / B3 / B6 | 单 owner，串行 |
| `packages/backend/tests/rfc294-architecture-preflight.test.ts` | B3 独占 | |
| `packages/frontend/tests/ux-source-ratchets.test.ts` | B10 独占 | |
| `packages/backend/src/routes/developmentConfig.ts` | B1 独占 | RFC-310 仍 In Progress，开工前确认无他人在途改动 |

并发纪律（仓规）：`git pull --rebase` 后立刻推；**绝不** `git reset --hard` / 无参 `git stash pop`；他人未追踪文件不入暂存区；commit message 只描述自己的改动。

## 4. 验收清单

- [x] AC-1 `architecture/commons-manifest.json` 落地且与源码双向闭合（B0；82 个内核 / 31 个 core，闭合断言在 `rfc317-architecture-ledgers.test.ts`）
- [ ] AC-2 R1/R2 落地，94 + 22 条边精确入账
- [ ] AC-3 R3 覆盖全部 11 个 context，两处具名偏离（`intent` 无 public / `integration/public/mrTerminalControl.ts` 非 exact）入账
- [ ] AC-4 R4 在清单文件集上生效，`toBe` 精确断言
- [ ] AC-5 R5–R9 落地，各带正反 fixture
- [ ] AC-6 R10 覆盖仓内每一个 allowlist，基线只降
- [ ] AC-7 R11 manifest 落地并自变异转红
- [ ] AC-8 R12 语料扩面，扩面后新增违规逐条修或入账（预算未调高）
- [ ] AC-9 52 条 P1/P2 逐条修复 + 红→绿 + 变异复跑确认转红
- [ ] AC-10 79 条 P3 逐条入账
- [ ] AC-11 能力影响 C1–C9 各有禁用/拒绝分支覆盖
- [ ] AC-12 `bun run gate:local` 全绿 + 按 exact SHA 的 hosted CI 全绿（含 Playwright / visual）
- [ ] AC-13 19 条 stale 断言逐条改对
- [ ] AC-14 索引 / STATE / dev-gotchas 同步

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
