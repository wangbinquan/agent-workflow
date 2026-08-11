# RFC-282 · 任务分解

状态：Draft（待用户批准 → Codex 设计门 → 实现）

**PR 拆分原则**：主干开发直推 `main`，每批独立 `gate:local` 全绿、独立可回滚、推完按
exact SHA 查 CI。**批次顺序 = 防护先行**（决策 11）：A 批把四道守卫建在现状之上并列出
存量例外清单，之后每收敛一批就从清单里划掉一条，**清单归零 = 完工**。

**每批都对拍**（决策 19）：任何换掉装配路径的批次，先写新旧双实现对拍测试证明等价，
再在同一 PR 内删旧实现；对拍用例随旧实现一同删除，覆盖意图由 golden 锁承接。

## 任务表

### 批次 A — 防护先行（守卫建在现状上，允许例外清单）

| 编号 | 任务 | 依赖 | 交付 |
|------|------|------|------|
| A1 | **ESLint import 边界**：`no-restricted-imports` 分层规则（`services/**` 除 `services/runtime/**` 外禁止 import `runtime/{opencode,claudeCode}/*`）；存量违规逐条进 `RFC282_IMPORT_EXCEPTIONS`，每条注明归属批次；**正向证明**：fixture 越界 import 断言报错 | — | PR-A1 |
| A2 | **源码层 grep 锁**：`tests/rfc282-single-implementation-lock.test.ts` —— 八类资源转换的定义点唯一 + 调用点白名单 + 禁止词族（`OPENCODE_CONFIG_CONTENT`/`--mcp-config`/`.claude/` 不得出现在 driver 目录外）。锁的是**现状**，后续批次逐步收紧白名单 | — | PR-A2 |
| A3 | **启动期自检骨架**：boot 校验 `DeclarationFace` 覆盖 + `startupObservation` 合法 + `DISABLED_RESOURCE_POLICY` 覆盖；**正向证明**：mock driver 少一个面 → 断言拒绝启动。此批先引入 `RuntimeCapabilities` 类型与两个 driver 的表态（值照抄现状行为），**不改任何消费方** | — | PR-A3 |

### 批次 B — 注入装配层（核心）

| 编号 | 任务 | 依赖 | 交付 |
|------|------|------|------|
| B1 | **driver 契约三合一**：`AgentSpawnContext` / `SpawnPlan.declared` 必填 / 单一 `buildSpawn`；删 `buildBusinessSpawn` + `renderInjection`；五条链路调用方改造。**对拍**：新旧装配对 argv/env/stdin/files/declared 逐字段相等（矩阵：2 runtime × {业务全量, persona-only, 测试台} × {有/无 boundary}）。**§7 变更 1、6 在此落地** | A3 | PR-B1 |
| B2 | **解析层归位**：`prepareNodeRunInjection` + `resolveSkills` → `services/execution/resolveInjection.ts`；skill 门 throw → typed failure；6 入口全走它（commit-push / merge 的资源从 agent 定义推导）。**对拍**：同一 agent 在新旧解析下的 spec 逐字段相等；失败归属逐条比对（RFC-130/253 skill 失败用例） | B1 | PR-B2 |
| B3 | **disabled 规则表 + 行为变更**：`resourcePolicy.ts` 单一表；plugin 改 skip-and-declare；**删除 `plugin-disabled` 错误码**；声明面 `skippedDisabled` 按类型分组（保留旧字段，读端取并）。**§7 变更 2、5 在此落地**；反向回归锁：disabled plugin 能跑通且产告警 | B2 | PR-B3 |
| B4 | **driver 内重复消除**：memory 织入两份 → 一份；claude mcp-config 落盘两份 → 一份；plugin enabled 过滤三四份 → 一份；`declareSkills` 谓词内联 4 处 → 复用；**plugin 去重键统一**；**subagent root 排除对称**；删死代码 `toClaudeMcpConfig`。A2 白名单同步收紧 | B1 | PR-B4 |

### 批次 C — runtime 围栏

| 编号 | 任务 | 依赖 | 交付 |
|------|------|------|------|
| C1 | **二进制解析下沉**：`opencodeCmd` 从 12 个入口 + `RunTaskOptions` + scheduler 6 处 + runner 全链剔除；driver 自解析（config 键 + registry binaryPath）；保留 `binaryOverride` 作 test-only 通道。**§7 变更 3 在此落地**。**对拍**：改造前后解析出的 argv head 逐字节相等（覆盖 config.opencodePath / registry binaryPath / PATH 三种来源） | B1 | PR-C1 |
| C2 | **显式能力声明接线**：`runner.ts:1828/1836` 的 `readInventory` 代理判据改 `capabilities.startupObservation` 穷尽 switch；`mcpRuntimeTest.ts:2570` 同款拷贝一并改；`DRIVERS[kind] ?? opencodeDriver` → 显式报错 | A3 | PR-C2 |
| C3 | **opencode 专属代码搬迁**（约 1300 行）：`sessionCapture.ts` / `subagentLiveCapture.ts` / `inventory.ts` / `distillSessionCapture.ts` / `util/opencode*.ts` / `src/opencode-plugin/` → `services/runtime/opencode/`；`runtime/types.ts:28` 与 `runner.ts:90` 的反向依赖解除。**对拍**：搬迁前后模块导出面逐符号相等（纯移动的等价证明面，见 design §9-4）。A1 例外清单同步划掉 | C2 | PR-C3 |
| C4 | **boundary 拆分下沉**：`composeOpencodeBoundary` → `runtime/opencode/boundary.ts`；`composeClaudeBoundarySettings` / `claudeExpressibleAuthorDirs` → `runtime/claudeCode/boundary.ts`；runtime 无关部分留统一层。**§7 变更 4 在此落地（只改 import 路径，断言内容不改）**；RFC-281 全部行为锁必须原样通过 | C3 | PR-C4 |

### 批次 D — 资源抽象

| 编号 | 任务 | 依赖 | 交付 |
|------|------|------|------|
| D1 | **ACL 判据收敛**：`canViewResourceInTx` 四份手写副本（`agent.ts:838` / `workflow.ts:1006` / `workgroups.ts:856` / `scheduledTasks.ts:389`）→ 复用 `resourceAcl` 单点；**注意 scheduledTasks 那份遮蔽同名导出且只支持 3/6 类型**；严格 vs 宽松 visibility 判据统一为共享版语义 | — | PR-D1 |
| D2 | **importRefs 共享底层**（决策 18）：grant 查询改调 `listGrantedResourceIds`；可见性判据复用 `resourceAcl`；selector 语义层保留独立 | D1 | PR-D2 |
| D3 | **ref codec 三域接上生产**（决策 12）：`freezeCallClosure`（`execution/closure.ts:240/247/284-290/357/380/401`）改走 `decodeCallRef`/`encodeCallRef`；importSelector 与 intent 同理；删 `agentRefs.ts:22-24` 的 `m:`/`p:` 前缀键第二份；`RefResolver` 接口给出实现或删除 | — | PR-D3 |
| D4 | **引用校验 fail-open 修复**：`resolveRefsUsableByName` 补 `grandfatheredIds` 参数（与 id 域对称）；`RefCheckGroup.domain` 去掉 `'id'` 默认值改必填（漏标从静默通过变成编译报错） | D3 | PR-D4 |

### 批次 E — 收尾

| 编号 | 任务 | 依赖 | 交付 |
|------|------|------|------|
| E1 | **收口**：A1 例外清单归零验证；A2 白名单收紧到目标态；`runner.ts` 的 `pumpLines`/`LinePump` 死代码与 `FINAL_REAP_MARGIN_MS` 双写清理；`runtime/types.ts:533` 残留的 `RuntimeMcpTestCapabilityV1` 注释；`docs/OPENCODE_CONFIG.md` / `docs/dev-gotchas.md` 增补；STATE.md 与 `design/plan.md` 索引置 Done | A–D 全部 | PR-E1 |

## 关键顺序说明

- **A3 先于 B1/C2**：`RuntimeCapabilities` 类型要先存在（值照抄现状），B1 才能在三合一
  时顺带接上，C2 才能改消费方。A3 本身不改任何行为。
- **B1 是全局枢纽**：C1/C3/C4 都依赖它确定的 `AgentSpawnContext` 形状。
- **B2 依赖 B1**：解析层的输出是 `AgentInjectionSpec`，形状由 B1 定死后再搬家，避免
  搬完又改签名。
- **C3 依赖 C2**：先把 `readInventory` 从「判据」降级为「实现细节」，搬迁才不会牵动
  runner 的判定逻辑。
- **C4 依赖 C3**：boundary 下沉的目标目录在 C3 建立起完整的 opencode 目录之后。
- **D 批与 A/B/C 无耦合**，可与任一批并行推进（若并发 session 抢工可先做 D）。

## golden / source-lock 归属表（决策 16：必然打红的既有断言逐项归属）

| 既有断言 | 打红原因 | owning | 新断言 |
|---|---|---|---|
| `runtime-buildspawn.test.ts` 系统面精确形状 | §7-1 统一产出多出字段 | B1 | 按统一产出重锁，逐字段说明 |
| `rfc143-runtime-driver-capability.test.ts` 接口面 | §7-6 driver 三方法 → 一个 | B1 | 锁单一装配方法 + capabilities 表态 |
| scheduler `plugin-disabled` 用例 | §7-2 错误码删除 | B3 | 反转为「能跑通 + 产告警」 |
| startup-verification 形状断言 | §7-5 skippedDisabled 分组 | B3 | 扩展为分组形状 + 旧字段兼容 |
| `opencodeCmd` 传参 / mock 注入断言 | §7-3 剔除 | C1 | 改走 `binaryOverride` |
| RFC-281 boundary 测试 import 路径 | §7-4 下沉 | C4 | **只改 import，断言内容一字不改** |
| `rfc223-pr6-injection-identity.test.ts` | **不打红** | — | 原样保留（围栏语义不变） |
| `runner-stream-bounds.test.ts` | E1 删死代码 | E1 | 锁迁到 managedProcess 的 pump |

## 验收清单（对应 proposal §8）

**归一（机器可校验）**

- [ ] ESLint 例外清单归零
- [ ] 八类资源转换各唯一实现（grep 锁断言 + 调用点白名单）
- [ ] `RuntimeDriver` 只剩单一装配方法（类型层核验）
- [ ] 启动自检：每个 driver 的 `declarationFaces` 覆盖全集，缺面拒绝启动
- [ ] `DISABLED_RESOURCE_POLICY` 覆盖 `InjectableResourceKind` 全集
- [ ] `prepareNodeRunInjection` 在 `services/execution/`，6 入口全走它
- [ ] `canViewResourceInTx` 全仓一个实现
- [ ] call / importSelector / intent 三域 codec 有生产调用点
- [ ] 约 1300 行 opencode 专属实现全在 `runtime/opencode/`
- [ ] `DRIVERS[kind]` 未知值显式报错；`readInventory` 不再作 runtime 判据

**功能不受影响（决策 21，同等硬指标）**

- [ ] 每个换装配路径的 PR 都含新旧对拍测试，等价证明后同 PR 删旧实现
- [ ] 既有测试零改动通过，唯一例外是上方归属表逐条登记的断言
- [ ] RFC-280 / RFC-281 / RFC-223 行为锁不改断言通过
- [ ] 关键业务链路 e2e 绿：业务节点带 MCP/skill/plugin、fan-out、commit-push、merge、
      intent 回合、MCP 测试台
- [ ] 四道守卫各有「能抓到违规」的正向证明（不是未用函数假装有保障）
- [ ] `bun run gate:local` 全绿 × 每个 PR；推完按 exact SHA 查 CI

## 交付前必过清单

- [ ] Codex 设计门（本三件套请批前）+ 实现门（declare done 前）各跑一次并修 findings
- [ ] design §9 的 5 项重点复核项逐条有结论
- [ ] `design/plan.md` RFC 索引登记；`STATE.md` 顶部「进行中 RFC」指向本目录
- [ ] 完工后索引置 Done，STATE.md 已完成表加一行
