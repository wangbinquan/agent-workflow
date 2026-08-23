# RFC-317 技术设计：公共内核架构边界加固

## 1. 在 RFC-294 目标架构中的落位（CLAUDE.md §RFC workflow 第 8 条）

### 1.1 归属

本 RFC 的**主体是跨 context 的治理层**，不属于任何单一 bounded context：新增代码落在

- `architecture/**` —— 仓根新建目录，存放机器可读账本。**这是 RFC-294 `plan.md §4 W0-R` 指定的 manifest 位置**（该节点名 `architecture/public-surfaces.json`、`architecture/module-symbol-owners.json`），本 RFC 是第一次向它真实沉积。
- `packages/backend/tests/architecture/**` —— 新增守卫与共享 matcher。
- `packages/frontend/tests/**` —— 前端侧规则（前端跑 vitest，与后端 `bun:test` 不同 runner，见 §4.9）。

**生产改动**（52 条 P1/P2 的修复）**各自落在自己的 owner context**，逐条归属见 §5。本 RFC 不新建任何横向层、不新建 facade。

### 1.2 承担 W0-R 的哪一步

RFC-294 `plan.md §4` 的 W0-R 动作清单里，本 RFC **承担**：

- [x] 「把 gate source 从 `modules/**` 扩到 inbound/legacy callers」——R1，94 条边入账
- [x] 「给 `modules/*/{domain,application,engine,public}` 加出方向规则」——R2，22 条边入账（全部出自 application 层）
- [x] 「新 `modules/**` 启用层级规则，domain/application 立即 fail-closed」——R3，扩到全部 11 个 context
- [x] 「扩 exact exception schema：`rule/from+symbol/to+symbol/edgeKind/owner/why/introducedByRFC/removeAfterWave/expiresOn/mutationTest`；禁 glob/目录豁免，unknown/stale/expired 全红」——R10 账本 schema
- [x] 「给每条新 dependency rule 做配置变异测试，证明规则真的能红」——R11 守卫 manifest，并**回溯适用于全部既有机制**
- [x] 「type-only 仅可指向 exact `public/{types,events,participants}`」的语料修正——R12
- [x] `module-symbol-owners.json` 的**公共内核子集**——`architecture/commons-manifest.json`

**明确不承担**（仍归后续波次，不得因本 RFC 落地就宣称 W0-R 完成）：

- 七份完整 manifest（`mutation-entrypoints` / `tx-external-effects` / `background-jobs` / `public-surfaces` / 完整 `module-symbol-owners`）；
- 值级 SCC 归零、`KNOWN_VIOLATIONS` 归零、route→DB 归零、`AppDeps` 拆解；
- 362 个 service 文件的完整 owner map（本 RFC 只给公共内核那部分 owner）；
- P0-D durable ownership fence；
- `node_runs INSERT` 全量 inventory 与单 writer 负扫描。

### 1.3 偏离项（须确认）

| 偏离 | 理由 |
| --- | --- |
| 规则主体仍以**路径**（`services/` / `modules/` / `ws/` …）而非「层」为单位 | 目标架构要求按层治理，但 362 个 legacy 文件尚无 owner/layer 标注（那是 W0-R 主体）。本 RFC 用「公共内核清单」显式列举替代，等 owner map 落地后 R1–R4 的 subject 切换到 layer 即可，规则本身不必重写 |
| 新增 `architecture/` 顶层目录，而 RFC-310 的同类 manifest 在 `design/RFC-310-*/` 下 | RFC-294 W0-R 指定的就是 `architecture/`；RFC-310 的是 vertical-slice manifest，RFC-294 已声明它「不替代 canonical 七份」。本 RFC **不搬** RFC-310 的文件（它仍 In Progress，搬会撞车），只在 R3 里让形状规则覆盖它已覆盖的三个 context，并在账本里登记这处重叠与去重波次 |
| 本 RFC 同批修 52 条 P1/P2，不是纯零行为批 | 用户已就此拍板。理由：把越权（ACL-01）与数据丢失（CC-01）登记成「精确债务」再等下一个波次，等于用账本把缺陷合法化——这正是本 RFC 要消灭的模式 |

## 2. 三层防护体系

```text
L3  守卫的守卫            architecture/guard-manifest.json
    ├─ 守卫文件两向钉死（删 / 改名 ⇒ 红）
    ├─ 每个扫描器断言 filesScanned > 0（挡「扫了个寂寞」）
    └─ 每条守卫导出 __mutationFixtures，由 manifest 逐条跑过并断言转红
                    ▲
L2  账本纪律              architecture/commons-debt.json + 各既有 allowlist
    ├─ 精确相等（toEqual / toBe），不用 <=
    ├─ 双向：新增违规红、违规消失不销账也红
    └─ 高水位基线，且基线本身只能下降
                    ▲
L1  边界规则              R1..R12（AST / dep-graph / 类型层 / 源码文本）
    └─ 每条规则的 subject 由 architecture/commons-manifest.json 声明
```

三层缺一不可：只有 L1 ⇒ 违规可在同一 PR 里加豁免洗白；有 L1+L2 ⇒ 守卫被删/被改空/正则失配时无人知晓（`docs/dev-gotchas.md` 已记录两次此类事故）。

## 3. 三份机器账本

### 3.1 `architecture/commons-manifest.json` —— 公共内核清单

它回答「哪些文件是公共内核、它们各自是什么的单一事实源、允许出现什么」。是 R4 的 subject、是 R11 的一部分输入、是接手者读的第一份文件。

```jsonc
{
  "schemaVersion": 1,
  "kernels": [
    {
      "id": "task-lifecycle-writer",
      "title": "任务 / 节点生命周期唯一写点",
      "owner": "task-execution",          // 目标 bounded context
      "layer": "application",             // 目标层
      "files": [
        "packages/backend/src/services/lifecycle.ts",
        "packages/shared/src/lifecycle.ts"
      ],
      "singleSourceOf": "task/node_run 状态迁移判据、CAS 写点、转移表",
      "businessLiteralBudget": { "packages/backend/src/services/lifecycle.ts": 0 },
      "forbiddenVocabulary": ["webhook", "schedule", "intent", "mission", "review", "clarify"],
      "guards": ["lifecycle-grep-guard", "rfc316-commons-business-literals"],
      "introducedByRFC": "RFC-097",
      "notes": "业务差异只能以注入的 policy / 返回值携带，见 R4 的正确形状"
    }
  ]
}
```

**双向闭合**（R11 的一条断言）：清单里的 `files` 必须存在；R4 扫描命中的文件必须在清单里；`guards` 里的每个 id 必须存在于 `guard-manifest.json`。

初版覆盖范围（依 §5 的 owner 归组确定，最终清单在实现时按实测生成）：执行内核 / 生命周期 / 资源 ACL 与 ref / runtime driver 共享层 / shared 图模型注册表 / transport 与 composition root / platform 持久化与事务 / 数字员工三 context 的公共面 / 前端公共原语与数据层，外加完整性批判点出的 12 个**本轮才被发现无人审计**的内核（prompt 围栏、路径 containment、schema admission、taskArchive 级联表、memoryInject、lifecycleInvariants 规则表、txSync、redact、gc space-kind、secretBox、transactionScope、ref/resolution）。

### 3.2 `architecture/commons-debt.json` —— 精确债务账本

承载 R1/R2/R3 的存量边与 79 条 P3。schema 直接采用 RFC-294 W0-R 规定的 exact exception schema：

```jsonc
{
  "schemaVersion": 1,
  "baseline": { "entries": 178, "recordedAt": "2026-08-23", "recordedAtSha": "<exact sha>" },
  "entries": [
    {
      "rule": "R1-inbound-module-internals",
      "from": "packages/backend/src/routes/developmentMissions.ts",
      "fromSymbol": "mountDevelopmentMissionRoutes",
      "to": "packages/backend/src/modules/development-automation/infrastructure/sqliteMissionStore.ts",
      "toSymbol": "createSqliteMissionStore",
      "edgeKind": "value",
      "owner": "development-automation",
      "why": "RFC-310 vertical slice 尚未给 mission 提供 public/queries 入口",
      "introducedByRFC": "RFC-310",
      "removeAfterWave": "RFC-294 W4-E",
      "findingId": "G-01"
    }
  ]
}
```

**硬规则**（沿用 RFC-294 W0-R 与 `depcheck-gate.test.ts` 的既有纪律）：禁 glob、禁 `pathNot`、禁目录级豁免；`why` 与 `removeAfterWave` 非空且 `removeAfterWave` 必须点名具体波次 / RFC 号；unknown、stale、expired 三类全红。

### 3.3 `architecture/guard-manifest.json` —— 守卫清单

```jsonc
{
  "schemaVersion": 1,
  "guards": [
    {
      "id": "rfc294-architecture-preflight",
      "file": "packages/backend/tests/rfc294-architecture-preflight.test.ts",
      "runner": "bun",                       // bun | vitest
      "mechanism": "ast",                    // ast | source-text | dep-graph | eslint | type-level | boot-selfcheck
      "kind": "absolute",                    // absolute | ratchet
      "corpus": "packages/backend/src/modules/**",
      "minCorpusFiles": 150,                 // 语料非空断言的下界，挡「扫了个寂寞」
      "mutationFixtures": 5,                 // 该文件导出的 __mutationFixtures 条数
      "guardsInvariants": ["cross-context-edge", "public-entrypoint-exactness", "type-taint", "capability-forge", "god-surface"]
    }
  ]
}
```

## 4. 十二条规则

每条规则给出：**不变量 / 机制 / 语料 / 账本 / 变异 fixture / 关闭哪些 finding**。

### R1 — inbound：legacy 层不得深入 module 内部

- **不变量**：`packages/backend/src` 中**任何不在 `modules/` 下**的文件，若 import `@/modules/<ctx>/…`，目标必须是 `public/{commands,queries,participants,events,types}`；只有 bootstrap（`server.ts` / `cli/start.ts`）可额外指向 `<ctx>/composition`。
- **机制**：AST。复用 `rfc294-architecture-preflight.test.ts` 已有的 `importEdges()`（它已覆盖 static / `import type` / `export … from` / `import()` / `require()` 五种形态——这正是 dependency-cruiser 看不见的四种），把 `productionModuleUnits()` 拆成 `moduleUnits()` + `backendUnits()`，规则二用后者做起点。
- **语料**：`packages/backend/src/**`（`minCorpusFiles` 按实测下界）。
- **账本**：**94 条边 / 28 个文件**逐条入 `commons-debt.json`，`toEqual` 精确相等（正式分母见 `census-2026-08-23.md §2`）。
- **变异 fixture**：合成一个 `routes/x.ts` import `@/modules/task-execution/domain/y` ⇒ 必须报；合成一个指向 `public/queries` 的 ⇒ 必须不报。
- **关闭**：`G-01`（P1）、`DE-09`、`CC-11`，以及「空 context 被判干净」的一半。

### R2 — outbound：module 的上层不得依赖 legacy 神模块

- **不变量**：`modules/*/{domain,application,engine,public}/**` 不得 import `@/services/**`、`@/routes/**`、`@/ws/**`、`@/mcp/**`、`hono`、`drizzle-orm`。`infrastructure/` 与 `composition/` 暂不入网（它们是适配层，按 RFC-294 允许触碰具体实现），但其边同样入账以便后续波次收敛。
- **机制**：同 R1 的 AST 通道；`domain` 额外禁 `node:fs` / `node:child_process` / `bun:sqlite`（RFC-294 `§G1` 的 domain 纯净要求）。
- **账本**：**22 条**（code-capability 9 / task-execution 8 / integration 5），**全部出自 `application` 层**——`domain` / `engine` / `public` 今天零违规；11 条是 `drizzle-orm`、11 条是 `@/services/*`。逐条带 `removeAfterWave`。
- **关闭**：`G-02`（P1）。

### R3 — 模块形状 + 层内矩阵 + composition 纯净 + 非空 public

- **不变量**（对 `modules/` 下**每一个** context 生效）：
  1. 顶层条目 ⊆ `{domain, application, engine, ports, infrastructure, public, composition, inbound}` + `composition.ts`（`inbound` 按 D3 已承认为合法层）。实测 11 个 context **零个**出现集合外目录。
  2. 层内导入矩阵：`domain` 不得导入本模块任何其它层；`application` / `engine` / `public` 不得导入 `infrastructure`；`composition/required-ports` 只能被 `composition` 与指定 provider adapter 导入。
  3. `composition.ts` 无业务分支（语句起始位置无 `if` / `switch`）、无 `@/db` 值导入。
  4. 每个 context 必须有非空 `public/`，否则显式标 `status:'skeleton'` + `removeWhen`。
- **机制**：数据驱动，subject 来自 `readdirSync(MODULES_ROOT)`（**不是**硬编码清单——硬编码正是 `rfc310-architecture-lock.test.ts:27` 只覆盖一个模块的成因）。目录遍历必须在**目标目录缺失时抛错而非返回空**（`rfc310-architecture-lock.test.ts:55-62` 的 `try { … } catch { return out }` 使三条锁在模块改名后静默变绿——`G-10`）。
- **关闭**：`G-03`（P1）、`CC-05`、`CC-11`、`G-10`。实测偏离两处：`intent` 无 `public/`（仅 1 个文件）、`integration/public/mrTerminalControl.ts` 非 exact 入口。
- **与 RFC-310 的重叠**：`rfc310-architecture-lock` / `rfc310-digital-employee-os-architecture` 的形状半边被 R3 覆盖；本 RFC **不删**它们（RFC-310 仍 In Progress），在 `guard-manifest.json` 里登记重叠与去重波次。

### R4 — 公共内核业务身份字面量预算（本 RFC 的核心新机制）

- **不变量**：`commons-manifest.json` 声明的每个内核文件，对**业务身份字面量**的比较次数必须**精确等于**账本记录值。
- **业务身份字面量**的定义（从源码派生，不手抄——手抄的清单必然漂移）：
  - node kind：`packages/shared/src/node-kind-behavior.ts` 的 `NODE_KIND_BEHAVIORS` 键集
  - task / node_run status、merge_state：`packages/shared/src/lifecycle.ts` 的状态联合
  - runtime kind：`RUNTIME_KINDS`
  - resource type：`ACL_RESOURCE_TYPES`
  - launch origin / space kind / wrapper kind / employee type id / event target kind：各自注册表
- **匹配形态**：TS AST 的 `BinaryExpression`（`===` / `!==` / `==` / `!=`）与 `CaseClause`，任一侧是上述字面量；外加 `.includes('<literal>')` / `startsWith('<literal>')` 这两种在审计里真实出现过的变体（`DE-03` 的 `errorCode.startsWith('workspace-boundary-')`）。
- **断言**：`expect(count).toBe(budget)`——**涨要红、降到位不销账也要红**。这是对 `rfc217-architecture-locks.test.ts:176-210` 用 `<=` + `Infinity` 的直接纠正（`G-04`：实测今天有 3 个免费槽位）。
- **正确形状**（规则红时给出的指引，写进断言消息）：
  - 需要按身份分流 ⇒ 用 `as const satisfies Record<K, V>` 穷尽表 + `never` 兜底，**不是** if 链；
  - 业务差异属于调用方 ⇒ 由调用方注入 policy / 由 port 返回闭合联合（`LC-04`：`TerminalWorkspacePrunePolicy` 应返回 `cause`，而不是让 kernel 自己铸 `'webhook-terminal'`）；
  - 跨 context 的判据 ⇒ 用导出常量或闭合联合，**不是**前缀字符串握手（`DE-03` / `DE-05`）。
- **范围**：仅 `commons-manifest.json` 声明的文件集（用户拍板）。领域模块不入网。
- **初值（D4 裁决）**：清单里标 `core: true` 的内核——生命周期写点、资源 ACL 判据、执行内核、runtime 共享层、transport 骨架、shared 图模型注册表——预算**直接为 0**，本 RFC 内把它们的业务字面量清空（对应 §5 的 LC-04 / ACL-04 / DE-03·04·05 / RT 字面量族等修复）；其余内核按实测精确钉住。
- **关闭**：`LC-04`、`LC-08`、`ACL-04`、`RT-*` 的 runtime 字面量族、`DE-03` / `DE-04` / `DE-05` / `DE-07`、`G-04`、`G-08`。

### R5 — 表归属：一张 drizzle 表只属于一个 context

- **不变量**：`db/schema.ts` 的每个表符号，在 `modules/**` 中只能被**唯一一个** context 引用（`db/schema.ts`、`db/migrations/**`、`tests/**` 除外）。
- **机制**：AST 收集 `from '@/db/schema'` 的具名导入，按 context 聚合，冲突集必须为空或入账。
- **为什么需要**：所有表活在同一个 `@/db/schema` 命名空间里，「读别人的私表」与「读自己的表」在导入图上完全同形——这是审计里 `DE-01` / `DE-02` 两条互相反向的越界能长期存在的结构原因。
- **关闭**：`DE-01`、`DE-02`、`TP-03`（`ws/registry.ts` 手写 raw SQL 读 identity-access 的 `users.access_revision`）。
- **落地时的规则修正（T41 实测后补）**：原文写的「只能被唯一一个 context 引用」在真实语料上**判错方向**。实测反例：`employeeRoundWorkspaceStates` 明明是 digital-employee 的表（与其余 13 张 `employee*` 同批建、同一个 store 写），却**只**被 development-automation 引用过——按「唯一一个 context」判据它完全合法，而这恰恰是最坏的一种越界（另一个 context 独占了你的表）。因此归属必须**声明**而非推断：落地为 `TABLE_OWNER_PREFIXES`（表名前缀 → 拥有它的 context），判据变成「带前缀的表只能被它的 owner context 引用」。没有专属前缀的域（tasks / workflows / memories …）目前还在 `services/` 横向层、尚未模块化，暂不纳入判据（纳入会一次报出几百条与本 RFC 无关的噪音，规则会因此失去「只减不增」的意义）；它们随 RFC-294 迁入 module 时在前缀表里加一行即可。
- **T41 的实际收口范围**：
  - `TP-03` —— **全部关闭**。identity-access 新增同步 public 端口 `UserAccessFenceReader`（`readAuthorityFence`），SQL 回到拥有 `users` 表的 context；`ws/registry.ts` 的 raw client 用量归零。同批新增 dep 规则 `no-transport-to-db`（`^packages/backend/src/(ws|mcp)/` → `^packages/backend/src/db/`）——此前 `no-routes-to-db` 的 `from` 只写了 `routes/`，ws/ 与 mcp/ **不被任何规则覆盖**；开账当天真实存量 2 条，逐条带 `why`/`removeWhen` 入 `scripts/depcheck.ts`，账本基线 35→37 并声明 `allowGrowth`。**同步是硬约束**：WS 发帧要在当前 tick 内定夺，异步化会让判定落到帧发出之后，围栏就此失效。
  - `DE-01` —— **全部关闭**。`LegacyMissionDrainPort`（合同在 digital-employee、实现在 development-automation），四张 Mission 表与「已了结审批状态」词表回到 owner 侧。`openMissionCount` 收**事务读句柄**而非自取 db：计数与 `employeeOsWriterState` 的写必须原子，否则记下的 `legacyOpenMissionCount` 会与同一行的 `mode` 不一致。
  - `DE-02` —— **关闭 finding 逐条点名的两处读**（`planJson` 泄漏、`state === 'completed'` 枚举泄漏），落为 `EmployeeReactionRoundQueryPort.frozenPlan / lastSettledRound`。**未关闭的更深一层**：development-automation 还在 insert/update `employeeCaseWorkspaces` 与 `employeeRoundWorkspaceStates`（**共同写**，不是借读），以及读 `employeeApprovalSagas` / `employeeChangeCandidates`。这需要先裁决工作区持久化归属哪一侧，是一次独立设计决策，不该塞进 T41——连同 `integration → development*Adapter*` 两条，共 8 条逐条入 R5 账本，各带 `why` + 指向 B7 / B10 的 `removeWhen`。
  - **遗留债（已记）**：`frozenPlan` 返回的仍是 `planJson` 原文，消费方用自己那份 zod 视图 parse。文档契约与 `ReactionExecutionPort.launch` 携带的是同一份，但没有声明成 DTO；收敛它需要 OS 侧提供运行期 schema，留给 B7。

### B9 落地记录（T57–T59，findings NK-01 / NK-02 / NK-03）

- **T57（NK-01，能力影响 C5）**：`list<T>` 的线格 codec 下沉进 handler。改造前 `ListHandler.validate` 无条件用一行一条的 `splitListItems`，而它 **trim 每一行、丢掉所有空行**——`list<markdown>` 的文档正文在**落库前**就被改写（段落间距、缩进、代码块相对缩进全没）。同一个文件的 `bulletSuffix` / `buildPromptGuidance` **是**按 item kind 分支的，还告诉 agent「你的文档是多行的、用边界行分隔」：协议这一半知道，校验那一半不知道；而 `envelope.ts` 原样返回 `body`、`runner.ts` 直接写进 `node_run_outputs`，**被改写的内容就是落库的内容**。更糟的是下游按边界行切（分片、评审多文档），于是「落库切几条」与「分片切几条」对不上。处置：`ParametricOutputKindHandler` 加 `splitItems` / `joinItems`（默认一行一条，markdown 覆盖），四个调用点统一走 `splitPortItems` / `joinPortItems`；实测**两处**（`list.ts validate`、`portArtifacts.ts`）此前完全没分支，另两处（scheduler、review）各写各的。加注册表级往返性质测试 + codec 站点棘轮（`review.ts` 一条带 why/removeWhen 的豁免：它的分支不只是「怎么切」，还要区分切出来的是正文还是路径，手上没有 ParsedKind）。
- **T58（NK-02）**：`promotedSourceForWrapper` 从 if-chain + 隐式默认改为 `satisfies Record<WrapperKind, Promoter>`，`wrapper-git` 那条从「掉进默认」变成显式 `() => null` 并带理由。另把失败结果的 `wrapperKind` 改为 `NodeKind | null`——改造前两处把 `'wrapper-git'` 当占位符（`wrapper?.kind ?? 'wrapper-git'` 与直接写死），而该字段**原样**渲染进用户可见诊断（validator ×3、scheduler ×1），于是一条「这个父节点根本不是 wrapper」的错误会告诉用户问题出在一个 git wrapper 上。四处统一走新的 `describeWrapperKind`（未知说通名「wrapper」）。同批删掉 T27 里那条因此过期的失败关闭豁免——那条豁免的存在前提就是「这里是兜底而非穷尽」。
- **T59（NK-03）**：`rfc147-system-channel-ports` 的标题写着「五端口字面量比较式全仓禁绝」，而扫描根只有 backend + shared；前端当时确实躺着两处违例（`sourceHandle === '__clarify__'`、`fields.sourcePortName === 'to_designer'`）。补上 frontend 根并把两处改 import 共享常量。对照 `rfc146-kind-predicate-guard` —— 它一直走全部三个根。一条声称「全仓」却只扫两个包的规则比没有规则更糟：它让人以为这件事已经有人管了。变异（把常量改回字面量）实测变红。

### B8 落地记录（T52–T56，findings TP-01 / TP-02 / TP-04 / TP-05 / TP-06）

- **T52（TP-01）**：契约覆盖改用**运行期预言**。旧扫描器的两条正则都要求 `path: '<字面量>'`，而 `developmentConfig.ts` 用 `path: cfg.base` 注册一个六路由家族并挂了 5 次——四十来个端点从未进入视野；**它自己的盲点元守卫也看不见**（检测器的 `[^}]*?` 跨不过 `${cfg.base}` 里的 `}`），于是「所有盲点都已登记」照绿，正是那个文件头注释自己命名过的 silent completeness。新守卫在 `createApp` 之后问框架的 `allRouteMeta()`：462 条声明 vs 420 条契约，**43 条缺契约**（finding 估的 ~41 精确命中），逐条入只减不增的账本；旧扫描器保留为源码侧快速检查，但其「LOCKS every endpoint」的头注释已更正为「覆盖面不完整」。
- **T53（TP-02，能力影响 C7）**：判据从「按动词」换成「按路径」。`method === 'ALL'` 一刀切放行的理由是「中间件不是端点」，但 `app.all('/api/mcp', handler)` 就是真正处理请求的端点——作者当时也知道，所以又塞进 `EXEMPT_MOUNTS` 兜了一道；也就是说任何未来的 `app.all('/api/x', …)` 都会无声绕过启动自检。现在 `/api/` 下的**精确路径** ALL 挂载必须声明或入账，通配挂载仍视为中间件（通配段本身就是「拦一片」的结构性表达）。`EXEMPT_MOUNTS` 导出并冻结为 3 条。
- **T54（TP-04）**：修掉一个**真 bug**。`mountApiRoutes` 每进程被调用两次（REST app + MCP dispatcher 的私有 app，后者在第一次 MCP 请求时懒建），而它里面那句 `deps.digitalEmployeeWorkStart.bind(...)` 绑的是**进程级** deferred participant——webhook dispatcher 拿的就是它。`bind` 当时是一句裸赋值：一旦有人发过一次 MCP 请求，此后所有 webhook / 事件驱动的工作启动都改道到 MCP 那套私有 runtime 上，无日志、无报错、无测试会红。处置：`bind` 改「已绑定即抛」+ dispatcher 传 `digitalEmployeeWorkStart: undefined`。**未修的那一半**（装配仍在路由函数里，14 次 compose）钉成只减不增的数字——彻底做法是把装配提到 bootstrap，那是一次独立重构。
- **T55（TP-05）**：通用 Digital Employee 面引用类型专属权限点（`development-missions:*`）的账本，今天 8 条。判据**没有**采用 finding 提的通用形式「路径域 == 点域」——那条在真实语料上报出 53 种错配，其中绝大多数正当（`reviews ← tasks` 是评审路由由任务权限守门、`memories ← memory` 是单复数），一条会报五十几处误报的规则最终只会被豁免糊住。
- **T56（TP-06）**：WS 通道的样本改为**从注册表派生**——`ChannelSpec` 新增必填 `samplePath`，两条守卫改为遍历 `WS_CHANNEL_KINDS`。改造前三处手写样本数组，RFC-312 的 presence 通道同时逃过全部三处（而同一次改动里双射断言**是**被更新了的）。另外把 `TOKEN_ALLOWED_WS_CHANNELS` 从 `ReadonlySet<string>`（零测试引用、注释说排除两个而实际四个）改为穷尽 `Record<WsChannelKind, boolean>`，并把「排除了哪四个」钉成显式清单——新增通道对 token 可达性的表态从此是编译期决定。

### B7 落地记录（T47–T51，findings LC-01 / LC-02 / LC-03 / LC-05 / LC-06 / LC-07）

- **T47（LC-01）**：把「转移表是超集」那句 docstring 变成可执行判据——AST 抽出所有**静态可知**的 `(to, allowedFrom)` CAS 站点（74 个），逐个要求 `allowedFrom ⊆ 以 to 为目标的全部事件的 allowed-from 之并`。实测**23 处越界**（finding 说的「≥5」是低估），全部集中在终态改写一件事上，与 `allowTerminal` 账本高度重合。本次**不改语义**（修复动作把卡住的终态行拉回可续跑、调度器重新认领被打断的 run、评审 supersede 作废已完成轮次——都是产品行为，去留是独立决策），逐条入偏离账本、只减不增。已知盲区明写在负向 fixture 里：`allowedFrom: SOME_CONST` 之类的动态形态抽不到。
- **T48（LC-02）**：`lifecycle-grep-guard` 的注释标记从**授权**降级为**文档**。改造前只要在前 5 行写下标记，任意文件、任意状态、任意次数的直写都会从扫描结果里消失——而它的两个兄弟棘轮（`tasks.status` 的 s14、`merge_state` 的 rfc144）都是逐文件精确计数的硬 allowlist。现在计数表说了算（`lifecycle.ts:3 / terminalSweep.ts:3 / clarify/seal.ts:1`），标记仍必须写（说明是有意为之）但不再放行。变异（加一处带标记的 `to:'running'` 直写）实测变红。
- **T49（LC-03 / LC-07）**：`allowTerminal` 逐文件精确账本（21 个生产站点，AST 计数免疫注释），每条写清它改写的是哪种终态→X；同时更正内核里两处过期声明——「五个具名持有者」与**一条并不存在的 ESLint 规则**。后者是最坏的一类过期断言：审内核是否密封的人第一眼读到它，会据此认定存在 lint 级不可绕过的守卫，从而不再去查真正的（可被注释 opt out 的）防线。守卫顺带断言那个规则名在全仓零命中，避免同一句谎话被复述。
- **T50（LC-05）**：抽出 `taskWorkspacePhase`（shared，纯函数，四相）。改造前三处手写、三处不同，其中两处的注释还各自声称与第三处同源。统一到最严格的那一份——它是唯一考虑过**存量物化失败行**的：那种行空路径、无墓碑、也从来没有过 `__repo_prep__` 行，此前在三处得到三种结论（410 归因错误 / 被路由到一个对它不存在的重试入口 / S4 告警被静音 45 分钟）。这**改变了 autoResume 与 stuckTaskDetector 对存量行的行为**，那正是要修的 bug。
- **T51（LC-06）**：`CANCELABLE_TASK_STATUSES` / `RESUMABLE_TASK_STATUSES` 从转移表派生，`LIVE_WORKTREE_TASK_STATUSES` 显式声明为「可取消集 ∪ interrupted」并写清 interrupted 为何在内（唯一一个已是终态却从没走过收尾的状态）。六处手抄全部改 import，另外发现并迁移两处（`pluginGenerationGc` / `workgroup/room`）。棘轮判据几经收窄：初版「≥3 个任务状态字面量」在真实语料上报出 **24 处误报**（NodeRunStatus 清单、schema 列声明、语义不同的子集），最终定为**集合精确相等** + 三条带 `why`/`removeWhen` 的豁免，并加「豁免必须承重」自证——该自证当场抓出我自己写的两条空豁免。
- **划分闭包**：`TASK_STATUS` 的每个成员必须落在「可取消」或「终态」之一且仅一个。变异（往 `TASK_STATUS` 加 `'paused'`）实测变红——而 finding 的证伪方式明确记着，改造前做同一件事「一条不红」。

### R6 — 注册表 → 消费者反向完备

- **不变量**：`commons-manifest.json` 中标记 `registry: true` 的每个导出注册表，其**每个键**都必须有生产消费者；每个**维度**（行为表的列）都必须被生产代码读过至少一次。
- **机制**：把 `rfc305-architecture-lock.test.ts:541-550` 已经验证可行的做法抽成共享 helper `assertEveryRegistryKeyHasAProductionConsumer(keys, root)`，逐注册表套用。
- **为什么需要**：`satisfies Record<K,V>` 只保证「表对 union 完备」，**看不见没人读的行**。实测：`shared/ref/resolution.ts:87` 自称单一事实源，`REF_DOMAIN_POLICIES` 生产消费者为零；`NODE_KIND_BEHAVIORS.isProcess` 是零消费者的假维度；`code-round` 仍占一整行描述 RFC-310 已删除的执行链。
- **关闭**：`G-09`、`CC-10`、`CC-09`、`NK-04`、`NK-11`。
- **落地时的规则细化（T42 实测后补，非放宽）**：落地跑真实语料时发现原文表述的两处不够，都是实测逼出来的：
  - **判据必须分两层，且顺序不能反**。只查「每个键有没有消费者」会被一类巧合骗过：一张**整体没人引用**的表，键名往往恰好以别的身份出现在别处（另一张表的键、一个局部变量名）。实测 `REF_DOMAIN_POLICIES` 在声明文件外零引用，键级判据却只报出 1 个死键——差一点整张死表就放行了。故先查**表级**（符号在声明文件外有无引用），再查**键级**。
  - **消费有两种合法形态**：`direct`（声明文件外直接引用）与 `{ via: 访问器 }`（只经同文件的一个访问器出去）。后者在本仓有四个真实例子——`REPAIR_OPTIONS → listRepairOptionsForAlert → routes/tasks.ts`、`SYSTEM_CHANNEL_PORTS → PROMPT_INJECTED_PORT_NAMES → shared/prompt.ts`、`INVARIANT_RULES → runLifecycleInvariants`、`NODE_KIND_BEHAVIORS.isAgent → isAgentNodeKind`，把它们判死会逼着后来的人拆掉正当的封装。但 `via` **必须两半都验**：访问器真的读了这张表，**且**访问器自己在声明文件外有消费者。只验前半，一张死表配个恰好活着的同文件函数就能蒙混；只验后半，`isProcess` 那种「访问器自己也是死的」就漏了——那正是它当年混进准入标准的方式（它的注释写着 `Consumed via isProcessNodeKind`，而那个谓词零生产调用者，只有测试在拿它断言它自己读的那一列）。
- **T43 各项的实际处置**（与 finding 的措辞有两处出入，记在此以便追溯）：
  - `REF_DOMAIN_POLICIES` / `RefDomainPolicy` / `RefPolicy` / `EXPORT_CALL_POLICY` 及随之无人可用的 `'export'` purpose —— **删除**（任何形态零消费者）。这收缩了 RFC-271 `AC-B2e` 原文所称的「解析契约五属性」，存续语义为调用级三属性；`rfc271-ref-contract.test.ts` 的同义反复断言同批换成可证伪的「每条 policy 都必须有实参调用点」。
  - `RefCallPolicy.failureOwner` —— **保留**。它同样从未被 deref，但 `resolveNodeAgentRef` 对整个 policy 参数是 `void call`：这套常量是**文档标记**而非行为表，整个对象作为标记被消费（源码层断言锁死哪个调用点配哪条 policy）。单删其中一个字段等于留着文档装置却挖掉文档，且 `purpose` / `onMissing` 同样不被 deref——只删一个是任意的。
  - `NODE_KIND_BEHAVIORS.isProcess` —— **删除**该列连同 `isProcessNodeKind`。两列（`isProcess` 与 `retryCascade === 'mint-placeholder'`）在每一行上恒等且由测试手工对齐，谓词零生产调用者。
  - `code-round` 死行 —— finding 要求的不是删行（该 kind 在前端与历史任务恢复路径上仍活），而是那一行的**现在时描述**在说一条 RFC-310 已删除的执行链。处置：改写为「退役行」的描述，并把 `node-kind-behavior-table.test.ts` 的逐值锁从 14 个 kind 里的 9 个**扩到全部 14 个**——原缺口正是「结构性断言只抓得住新增的 process kind，抓不住退役的」。

### R7 — 能力站点必须声明治理属性（不只是计数）

- **不变量**：三类能力站点的 allowlist 值从 `{count, why}` 升级为 `{count, why, governance}`，且 `governance` 非 `exempt-*` 的条目必须通过 AST 断言：
  - **spawn**：同一函数内 `detached: true` + 引用 `killProcessTree`；且同文件不得出现无上限的 `new Response(proc.stdout).text()`；
  - **fs write**：`writeFileSync` / `mkdirSync` / `cpSync` / `renameSync` / `createWriteStream` 的路径参数必须来自 `@/util/safePath` 的产物，或文件在账本内带 why；
  - **transaction**：`.transaction(` 只能出现在账本内文件；所有事务边界 port 的签名必须用从 `db/txSync.ts` 导出的 `NotPromise<T>` 约束。
- **为什么需要**：`rfc284-spawn-site-ratchet` 今天只数命中数——两个 RFC-310 runner 老老实实进了名单、`why` 写得很好，而它们**没有进程组、没有树杀**（`EK-01`）。「站点被登记」不等于「站点被治理」。
- **关闭**：`EK-01`、`EK-02`、`CC-04`、`CC-08`、`CC-13` 的一半。

### R8 — 级联闭包：多跳 FK 必须被看见

- **不变量**：从 `{tasks, node_runs}` 出发、沿 `onDelete: 'cascade'` 边做**不动点展开**得到的可达表集，必须 ⊆ `ARCHIVED_TABLES ∪ ARCHIVE_EXEMPT_TABLES`。
- **机制**：共享 helper `cascadeClosure(schema, roots)`，供归档守卫、任务删除守卫与未来任何 retention sweep 复用。
- **变异 fixture**：合成一个「孙表」，证明闭包版会红而单跳版仍绿。
- **关闭**：`CC-01`（P1，数据丢失）。

### R9 — 前端设计系统全域棘轮

- **不变量**（三条新的全域 AST 规则 + 一条 CSS 规则，与既有 `ux-source-ratchets` 同构、共用 allowlist + stale 纪律）：
  1. 原生 `<select>` 只允许出现在 `components/Select.tsx` / `MultiSelect.tsx`；
  2. className 字面量含 `__overlay` / `__panel` / `__backdrop` / `__modal` 的 JSX 只允许出现在 `components/Dialog.tsx`；含 `segmented` 的只允许是 `<Segmented>`；`role="radiogroup"` / `role="tablist"` 只允许出现在对应公共原语内；
  3. **死 class 全域化**：收集 `src/**/*.tsx` 里所有静态 className token（含模板串内的），断言每个 token 在 `styles.css` / `prose.css` 里有选择器定义，第三方 token（`nodrag` / `nopan` / `nowheel` / xyflow）走显式小 allowlist。这是把 `rfc286-f1-dead-class-extinction.test.ts` 硬编码的三个名字换成不变量本身；
  4. `styles.css` 中 `.dialog__overlay` 等公共 class 的选择器不得被特性名限定（`.dialog__overlay:has(.<feature>)` 今天有 4 处）。
- **既有三个「迁移白名单」测试**（`dialog-grep` / `data-table-callsite` / `empty-loading-callsite`）保留其「已迁移的不许退回」职责，但各加一条 stale 断言（allowlist 里的文件必须仍然存在且仍然符合）。
- **关闭**：`G-06`、`FE-01`、`FE-02`、`FE-*` 的 chrome fork 族。

### R10 — 账本高水位

- **不变量**：每个账本导出一个具名 `LEDGER_BASELINE` 常量；测试断言 `entries.length <= LEDGER_BASELINE`；另一条测试读 `git show HEAD~1:<file>` 断言 `LEDGER_BASELINE` **只降不升**（无 git 环境显式 `skip` 并打印原因，**不假绿**）。
- **覆盖**：`scripts/depcheck.ts` 的 `KNOWN_VIOLATIONS`（35）、`rfc284-spawn-site-ratchet` 的 `ALLOWLIST`、`ux-source-ratchets` 的三个 allowlist、`rfc143` 的 `kindDiscriminationAllowlist`（并补 stale 检测——实测三条里两条已死）、`schemaAdmission.LEGACY_MIGRATION_HASHES`（8，且测试须 import 生产常量而非手抄副本）、`rfc294-architecture-preflight` 的两条 debt list、本 RFC 新增的 `commons-debt.json`。
- **关闭**：`CC-06`、`CC-03`、`RT-02`、`G-04` 的一半，以及「同一 PR 加违规 + 加豁免」这条通路。

### R11 — 守卫的守卫（`architecture-guard-manifest.test.ts`）

三条断言：

1. **两向钉死**：`guard-manifest.json` 里的每个 `file` 必须存在；`packages/{backend,frontend}/tests` 下每个文件名匹配 `/architecture|boundary|ratchet|lock|guard|invariants|preflight/` 的测试文件必须在 manifest 里。⇒ 删守卫、改守卫名都会红。
2. **语料非空**：每个**枚举文件**（`corpusScanner`）的守卫必须在自己文件里断言一条语料下限，manifest 两向钉死该下限（`minCorpusFiles`）。⇒ 目录改名 / 正则失配导致的「扫了个寂寞」不再是绿，且**静默调低下限**同样红。

   > **落地偏离（B2-a，2026-08-23）**：原文写的是「守卫**导出**扫描到的文件数、manifest 断言」。实现时发现这条不可实施——manifest 要读到那个导出就得 `import` 该测试文件，而 import 一个 test 文件会把它的 `describe/test` **重复注册**一遍（前端 vitest 还会连带拖起 jsdom setup）。改为「守卫在文件内断言下限 + manifest 用 AST 两向钉死该下限」：目标失效形态（扫成空）覆盖相同，且下限就写在用它的地方、被调低会红，比导出一个数字更难悄悄失效。
   >
   > **subject 同时收窄**：从「所有 `source-text | ast` 守卫」（76 个）收窄到「真的枚举文件的守卫」（37 个）。读固定文件名的守卫不存在「静默扫成空」——文件没了 `readFileSync` 直接抛，是响亮的红，不需要这条规则。
3. **变异必红**：凡「扫语料 **且** 断言不存在」的守卫，必须至少有一条**负 fixture**——把伪造的输入喂给某个决定过程、且**完全不碰真实语料**的断言。fixture 是**内存字符串**，绝不往工作树写故意的红（仓规）。有无 fixture 两向钉进 manifest，删掉一条必须是一次有记录的决定。

   > **落地偏离（B2-b，2026-08-23）**：原文写的是「守卫导出 `__mutationFixtures`，manifest 逐条喂给同一个**导出的 matcher**」。与 R11.2 同一个原因不可实施——manifest 要读那两个导出就得 `import` 该测试文件，会重复注册它的 `describe/test`。改为「守卫在文件内把伪造输入喂给自己的判据，manifest 用 AST 认出这类断言并两向钉死」。
   >
   > **受管面收窄**：从「每个守卫」收窄到「扫语料 **且** 断言不存在的守卫」（37 个里 34 个）。只断言**存在**的守卫（`expect(sites.length).toBeGreaterThanOrEqual(4)`）自带证明：扫描一失效就掉到 0、当场转红，再要求配 fixture 是纯仪式，只会让豁免账本变成停车场。
   >
   > **代价与前提**：34 个里有 12 个原本把判据内联在 test 体里，**先把判据提到模块顶层 / 抽成纯函数**才有得喂。这不是顺手重构——判据各留一份拷贝的话，fixture 证明的只是拷贝还活着。

**本条自身的变异实证**：把某条 `mustReport: true` 的 fixture 改成合法源码 ⇒ manifest 必须红。

- **关闭**：`G-07`、`CC-07`，以及 `docs/dev-gotchas.md` 记录的三种守卫失效形态（整删 / 改空 / 正则失配）。

### R12 — preflight 解析语料修正

- **不变量**：`rfc294-architecture-preflight` 的类型解析语料扩到 `packages/shared/src/**` + `packages/backend/src/platform/**`（**仅用于解析**，规则 subject 仍是 `modules/**`）；`FORBIDDEN_TYPE_IMPORT` 补 `@/platform`、`@/embed`；public entrypoint 禁非字面量键的 `Record`。
- **为什么需要**：`shapeStats` 在 `resolveUnit` 解析失败时 fallback 成 `transitiveLeaves: 1`，于是**任何来自 shared 的 mega-DTO 在 24 的预算里只算 1 片叶子**。实例：`modules/integration/public/participants.ts` 把 shared 的 `StartTask` / `StartAgentTask` / `StartWorkgroupTask` 整个塞进 `payload`，god-surface 预算完全没看见。
- **副作用**：扩面后 god-surface 与 type-taint 会新增违规——**逐条修或逐条入账，不得调高预算**。
- **关闭**：`G-05`。

  > **落地偏离（T25，2026-08-23）——两处，均已实测佐证**：
  >
  > **① 「public entrypoint 禁非字面量键 `Record`」改为「精确入账」**。实测 public 入口共 13 处 `Record<…>`：4 处键是穷尽联合（正解），9 处是 `Record<string, …>`，而这 9 处里绝大多数**本就该开放**——frontmatter 附加字段（任意 YAML）、用户自定义 trigger 参数、错误 `details` 包、外部系统带来的标识键值对、泛型 merge 助手。下硬禁 ⇒ 约 89% 假阳性，逼着后来的人要么给动态载荷编一个假的键联合，要么往账本里塞一堆「不知道为什么是 string 键」的低信息条目。**判据宽而掺水与判据窄而漏，坏处不对称；而「制造假阳性逼人绕过」是最坏的一种——它训练所有人学会忽略这条规则。** 改成逐条精确相等的账本：棘轮效力保留（不会再悄悄多出一个开放面），同时不把既有动态载荷诬告成违规。账本里点名了唯一**值得改**的一处：`integration/public/events.ts` 同文件 34 行已用 `Record<CodeHostEventType, …>` 穷尽、50 行却退回 `string` 键，疑为穷尽性在某次改动里掉了。
  >
  > **② taint 规则新增「确定性 `typeof` 派生」豁免**。解析语料扩到 shared 后，taint 走查第一次能走进 shared，立刻报出 8 条 `TypeQuery`。查证：shared 的 740 个导出类型别名里 **586 个**是 `z.infer<typeof …>`，全仓另有 **85 处** `(typeof CONST)[number]`、6 处 `keyof typeof`；而**裸 `typeof value`**（真正开放的形态）全仓只有 **2 处**，且都不在 public 合同链上。不加豁免 ⇒ 规则与「shared 可解析」结构性冲突；把它们当债务入账 ⇒ 把用了 586 次的单一事实源写法记成债，污染账本含义。豁免只认三种确定性形态，裸 `typeof` 一个不放。
  >
  > **预算一字未动**（`maxTransitiveLeaves: 24` 等全部保持）。扩面后 god-surface **仍然通过**——即 design 担心的「解析不到导致预算失明」属实，但那个 mega-DTO 实例被真正解析后依然在预算内。唯一真违规（identity-access 的 public 合同把 `@/platform` 的 `TransactionScope` 摆进签名）已按 T16 的 `allowGrowth` 机制入账，涨账留下了具名记录。

## 5. 生产修复设计（52 条 P1/P2 按 owner 归组）

只给形状裁决，逐条明细在 `findings.md`。

### 5.1 resource-catalog（P1 × 2 + P2 × 2）

- **ACL-01**：`routes/developmentConfig.ts` 的 `requireVisible` 在**写路径**上换成公共 `requireResourceOwner`（`resourceAcl.ts:470-482`：先 `requireResourceView` 保证不可见→404，再 owner-or-bypass→403）；读路径保持 `canViewResource`。**能力收缩 C1**，且注意 grant 不含写权（见 `proposal.md §4` 的订正）。同批加 R1 类规则：任何 RouteMeta 的 `permissions` 含某 ACL 资源的 `:update` / `:delete` / `:archive` 点的路由，其 handler 传递闭包必须命中 `requireResourceOwner`，否则入账。
- **ACL-02**：`employee_definitions` 的三列惰性 —— 见 §10 D2，两条路都要能力影响确认。同批加 R5 类 schema 反射守卫：**任何同时声明 `owner_user_id` 与 `visibility` 的表必须是 `AclResourceType`**，否则入账。
- **ACL-03**：ACL 端点入网守卫今天是**字符串字面量正则**（`rfc099-acl-endpoints-matrix.test.ts:296-308` 要求 `type: '<literal>'`），而 `developmentConfig.ts:231-236` 用变量 `cfg.aclType` 挂载 ⇒ 五类资源对该守卫**结构上不可见**（实测正则只命中 7 类）。改为**运行时注册表枚举**：`mountAclEndpoints` 把 `cfg.type` 追加进导出的模块级注册表，测试起真 app 后断言 `registeredAclMounts` 与 `ACL_RESOURCE_TYPES`、与矩阵 `CASES` 三者相等——「有类型无挂载」与「有挂载无矩阵行」都会红，且与挂载写法无关。
- **ACL-04**：`routes/resourceAcl.ts` 里两条 `cfg.type === 'workflow' | 'workgroup'` 的广播分支移进调用方已有的 `afterUpdate` 钩子，规则起点即为零。

### 5.2 task-execution / 生命周期（P2 × 6 + LC-07 顺带，**高冲突文件，串行**）

- **LC-01**：`setTaskStatus` / `setNodeRunStatus` 的 `allowedFrom` 必须是转移表的子集——加一条静态断言（对可静态求值的对象字面量），越界站点逐条入账或改对。
- **LC-02**：`lifecycle-grep-guard` 的 `rfc053-allow-direct-status-write` 注释标记从「授权」降级为「文档」，改成 s14 式**逐文件精确计数** allowlist。
- **LC-03 / LC-07**：`allowTerminal` 21 处逐条入账（只锁数量，不改语义）；同批修正 `lifecycle.ts:18` 引用的不存在的 ESLint 规则名与 `:434-437` 的「5 个持有者」表述。
- **LC-04**：`TerminalWorkspacePrunePolicy` 改为返回 `{ prune: false } | { prune: true; cause: WorkspacePruneCause }`，kernel 原样写入；`services/lifecycle.ts` 内的 `webhookTriggerId` / `eventSubscriptionId` 选列与 `'webhook-terminal'` 字面量清零 ⇒ R4 预算归零。
- **LC-05 / LC-06**：抽 `taskWorkspacePhase(row)` 与从转移表派生的 `CANCELABLE_TASK_STATUSES` / `RECOVERABLE_TASK_STATUSES`，六处手抄枚举与三处 repo-prep 谓词全部改为 import。

### 5.3 执行内核 / 进程治理（P2 × 2 + CC-04 / CC-08；EK-03 由 R1/R3 承担，不在此节）

- **EK-01**：两个 RFC-310 runner 接入 `runManagedProcess`（或至少补 `detached` + `killProcessTree` + 有界读）；R7 的 governance 属性同批生效。
- **EK-02**：`spawnVersionProbe` 的 `timeoutMs` 改必填、删无 timeout 模式（**C4**）。
- **CC-04**：`db/txSync.ts` 导出 `NotPromise`，两个事务端口签名改 `<T>(fn: () => NotPromise<T>) => T`；S-10 的词法禁令升级为站点账本。
- **CC-08**：导出唯一 `repoRelativePathSchema`，两处 `z.string().min(1)` 的写侧再解析改为 import 它。

### 5.4 数字员工三 context（P2 × 9）

- **DE-01/02**：两条互相反向的私表越界各自换成 public query port（R5 同批起点归零）。
- **DE-03**：`workspace-boundary-` 前缀握手换成端口返回的闭合联合 `errorClass`。
- **DE-04**：`event-center` 不再自己写死 `development-missions:launch`，改由 composition 注入 + `Record<EventResponseTarget['kind'], LaunchPermissionRef | null>` 穷尽表。
- **DE-05**：`'platform'` 魔法 slot 改成闭合联合（或至少导出共享常量，两侧 import）。
- **DE-06**：`terminalKind` 定为闭合联合并在 route 层校验；三份分类表改 `Record<K, …>` 穷尽。
- **DE-07**：`genericTypeLiteralBan` 从「一个单词」升级为「从已注册类型包描述符派生的禁用词集 + 精确 allowlist」——这正是 R4 的 subject 之一。
- **DE-08**：删掉 `task-execution` 手抄的 `implementationSchema`，import `execution-contract/public/types` 的导出。

### 5.5 transport / platform（P2 × 6）

- **TP-01**：契约覆盖扫描器从正则改为**运行时预言**（`createApp` 后比对 `allRouteMeta()`），一次性消灭 ~40 个计算路径端点的盲区。
- **TP-02**：冻结 `EXEMPT_MOUNTS`（**C7**），`/api/*` 的 ALL 挂载必须入账。
- **TP-03**：`ws/registry.ts` 的 raw SQL 读改走 identity-access 的既有 port；补 `no-transport-to-db` dep 规则。
- **TP-04**：`bind` 改为「已绑定即抛」，并把 `mountApiRoutes` 里的 7 处 `compose*` 提到 `createApp`。
- **TP-05**：`/api/digital-employee*` 四条路由引用 `development-missions:*` —— 加「权限点域归属」断言，本条作为具名债务入账（改名是产品可见变化，见 §10 D5）。
- **TP-06**：WS 通道的三处手写样本数组改为从 `WS_CHANNELS` 派生。

### 5.6 shared 注册表（P2 × 3）

- **NK-01**：`list<T>` 的 codec 选择下沉到 item handler（**C5**）。
- **NK-02**：`promotedSourceForWrapper` 的 if 链改 `satisfies Record<WrapperKind, Promoter>`；失败结果里的 `wrapperKind` 改 `NodeKind | null`，不再把未知 wrapper 标成 `wrapper-git`。
- **NK-03**：`rfc147-system-channel-ports` 的 roots 补 frontend，两处命中改为 import 常量。

### 5.7 前端（P2 × 2 + R9）

- **FE-01**：`JoinModeField` 改用 `<Segmented>`。
- **FE-02**：五个死 class 家族逐条修（补 CSS 或改用既有 class），R9 的全域死 class 规则同批起点归零。

### 5.8 平台公共内核（critic 发现）

- **CC-02**：`development-automation` 的第二套 prompt 围栏删除，改用 `shared/promptFencing`；补「任何含 prompt 结构字面量的文件必须 import 共享围栏」的全域棘轮 + 对抗 payload fixture 表。
- **CC-03**：`LEGACY_MIGRATION_HASHES` 的测试改为 import 生产常量 + 精确 8 项账本 + 每项 `why`。
- **CC-13**：`memoryInject` 的 `envelopeNonce` 去默认值，改成必传的判别式（`EnvelopeNonce | LegacyNoNonce`）。

## 6. 与既有 26 个机制的关系

| 既有机制 | 处置 |
| --- | --- |
| `rfc294-architecture-preflight` | **扩**：加 R1/R2/R3/R12；已有四条规则与两条 debt list 原样保留 |
| `scripts/depcheck.ts` + `.dependency-cruiser.cjs` | **扩**：加 `no-transport-to-db`；`KNOWN_VIOLATIONS` 加高水位；修 `no-auth-to-services` 注释与账本不符（`G-11`） |
| `depcheck-gate.test.ts` | **扩**：加「规则注释声称已入账 ⇒ 账本必须有对应条目」的元断言 |
| `rfc217-architecture-locks` G5 | **改**：`<=` → `===`；删 `Infinity` 分支；三个免费槽位当场收回 |
| `rfc284-spawn-site-ratchet` | **扩**：allowlist 值加 `governance`，加 AST 治理断言 |
| `rfc143-runtime-driver-capability` | **扩**：allowlist 加 stale 检测（当场清掉两条死条目）；正则族补 `?? 'opencode'` 默认回退形态 |
| `rfc282-single-implementation-lock` | **改**：`services/runtime/` 的整目录豁免收窄为 `opencode/` + `claudeCode/` 两个子目录，让共享层重新进入扫描 |
| `rfc310-architecture-lock` / `rfc310-*-os-architecture` | **并（不删）**：形状半边被 R3 覆盖，在 `guard-manifest.json` 登记重叠与去重波次；`genericTypeLiteralBan` 升级为 R4 |
| `rfc311-task-archive` 级联对账 | **改**：单跳 → 闭包（R8） |
| `api-contract-coverage` | **改**：正则 → 运行时预言（TP-01） |
| 前端 `dialog-grep` / `data-table-callsite` / `empty-loading-callsite` / `btn-variants-callsite` | **保留 + 加 stale 断言**；新增能力由 R9 承担 |
| `ux-source-ratchets` | **扩**：加 R9 的四条规则 |
| `rfc286-f1-dead-class-extinction` | **改**：硬编码三个名字 → 全域死 class 不变量（R9.3） |
| 其余专项锁（rfc301/303/305 等） | **不动**，仅登记进 `guard-manifest.json` 并补语料非空断言与变异 fixture |

**退役清单**：本 RFC 不退役任何机制。若某条被 R1–R12 完全覆盖，按 `docs/dev-gotchas.md` 的三种处置（改指向更强断言 / 整删 / 登记豁免）逐条判，并写进 `plan.md` 的实施记录。

## 7. 失败模式与假绿防御

| 失败模式 | 防御 |
| --- | --- |
| 规则写完扫到 0 个文件（目录改名 / 正则失配） | R11.2 语料非空断言 + 每个规则的 `minCorpusFiles` |
| 断言因笔误恒真（仓内已发生：字段名笔误 + `as never` 遮掩） | R11.3 变异 fixture 必须转红；且**修完要复跑一次原变异确认转红**（`docs/dev-gotchas.md`） |
| 反向断言在前提不成立时退化成 no-op | 每条 `not.*` 断言配一句前提复核断言（`docs/dev-gotchas.md` 的定式） |
| 守卫被删掉当作「重构收尾」 | R11.1 两向钉死 |
| 账本在同一 PR 里被加宽 | R10 高水位 + 基线只降 |
| 新增文件是 untracked 导致本地假绿 | 所有枚举式守卫用 `readdirSync` 递归而非 `git ls-files`（`docs/dev-gotchas.md:12` 的 RFC-311 T19 事故） |
| 变异 fixture 污染共享工作树 | fixture 一律内存字符串，喂给导出的 matcher |
| 本 RFC 自己变成「只覆盖自己那块」的守卫 | R11.1 要求**未来任何**架构守卫都注册进 manifest；这是 meta 规则 |

## 8. 测试策略

必写用例（`plan.md` 的验收清单逐条对应）：

1. **R1–R12 各自的正反 fixture**（12 × 2 起）。
2. **52 条 P1/P2 各一条红→绿回归**，且每条做变异检验（退回修复 ⇒ 立刻红 ⇒ 复跑确认转红）。
3. **能力影响九项的禁用/拒绝分支**：C1 的「view 权非 owner 发 PUT/publish/archive ⇒ 403 且**零写入**」（拒绝路径必须验证 durable 与广播均为零，RFC-294 `test-hardening.md §4`）、C3 的「不支持 extraArgs 的 runtime ⇒ 400 且**未 spawn**」、C7 的「新增 ALL 挂载 ⇒ 启动自检红」。
4. **R11 的自变异**：改一条 fixture 的期望 ⇒ manifest 红。
5. **R10 的基线自变异**：把 `LEDGER_BASELINE` 调高 ⇒ 「基线只降」测试红。
6. **R8 的孙表 fixture**：合成两跳级联表 ⇒ 闭包版红、单跳版绿（证明修复真的扩了覆盖）。
7. **前端**：R9 四条规则各配 fixture；死 class 规则以当前五个家族为红→绿对。
8. **门禁**：`bun run gate:local` 全绿；推送后按 exact SHA 查 hosted CI（含 Playwright / visual）。

## 9. 兼容与回滚

- **回滚点**：三份账本 + 守卫为一批，可整体 revert；生产修复各批独立可 revert。**不得先落生产改动再撤规则**（RFC-294 W0-R 的回滚纪律）。
- **API/WS/DB**：除 §4 列出的 C1–C9，无 wire 变化；无 migration（C2 若选 (a) 则需要一条 migration，见 §10 D2）。
- **在途任务**：本 RFC 不改任务状态机语义，在途 task/resume 不受影响。
- **多人并发**：`scheduler.ts` / `lifecycle.ts` / `task.ts` 严格串行且单独成批；`.dependency-cruiser.cjs` / `scripts/depcheck.ts` / `architecture/**` 单 owner。

## 10. 决策记录（2026-08-23 用户逐条拍板）

| # | 议题 | 裁决 |
| --- | --- | --- |
| **D1** | 三份账本放哪 | **仓根 `architecture/`**（对齐 RFC-294 W0-R 命名，避免后续搬迁） |
| **D2** | `employee_definitions` 的惰性 ACL 三列 | **(a) 立为第 13 类 ACL 资源**。存量行**不回填**：`ownerUserId` 恒等于创建者（`modules/digital-employee/composition.ts:540,549` ← route `actor.user.id`），`visibility` 恒为 `'private'`（`application/authoringService.ts:1073`），所以入网后每个用户只看得见自己的员工定义——这正是被接受的能力收缩 C2。**唯一补丁**：迁移里若发现 `owner_user_id IS NULL` 的历史孤儿行（当前写路径产不出，但列可空且唯一索引用了 `COALESCE`），显式置 `visibility='public'`，避免出现任何人都够不到的行（沿用 RFC-231「框架 built-in 显式保持 public」的口径） |
| **D3** | `task-execution/inbound/` | **承认 `inbound` 为合法层**并回写 RFC-294 `design.md §2` 的目标目录树——目标架构本就有 inbound adapter 概念，只是没给它目录名。R3 的顶层集合为 `{domain, application, engine, ports, infrastructure, public, composition, inbound}` |
| **D4** | R4 预算初值 | **核心内核直接归零**，而非钉住现值。即 `commons-manifest.json` 里标记 `core: true` 的内核（生命周期写点、资源 ACL 判据、执行内核、runtime 共享层、transport 骨架、shared 图模型注册表）预算 = 0，业务字面量必须在本 RFC 内清空；非核心内核仍按实测钉住 |
| **D5** | `development-missions:*` 权限点名（TP-05） | **本轮只入账不改名**（改名会动 grant / PAT scope，需迁移，形态同 RFC-315），另立 RFC |
| **D6** | 79 条 P3 | **全部逐条入账**（账本是唯一能防它们复发的东西） |
| **D7** | 既有守卫的变异 fixture | **本批全部回填**（约 16 个无 fixture 的机制），否则 guard-manifest 从第一天就带一堆豁免、自己变成下一个假绿源 |

`proposal.md §4` 的能力影响清单 **C1–C9 已逐项确认**，其中 **C1 采「直接收紧、不做迁移」**——不为存量 public 资源补发 grant，现有依赖「大家都能改」的部署自行改用 grant。
