# RFC-271 · 资源配置包（递归闭包导出 / 导入）

状态：Draft（2026-08-08 落档；Codex 设计门 12 条 findings 已逐条核实属实并修入本版，等待用户
对 §5 更新后的能力影响清单确认）。

## 1. 背景

今天平台唯一的「把配置搬到别处」的手段是**工作流的单文件 YAML 导出**
（`GET /api/workflows/:id/export` → 编辑页「更多操作 → 导出 YAML」）。它只序列化
工作流自己的 `id / name / description / definition`，被引用的一切都退化成**名字选择器**：

- `agent-single` 节点导出成 `agentName + agentOwnerUsername`（RFC-223），代理本体不带；
- `call-workflow` / `call-workgroup` 节点只留 `workflowName` / `workgroupName`（RFC-243），
  子工作流与工作组本体不带；
- 代理背后的技能 / MCP / 插件 / `dependsOn` 子代理闭包，**一个字节都不在文件里**。

于是导出的 YAML 在目标实例上几乎必然是**悬空的**：导入能成功（`importRefs` 对
workflow / workgroup 选择器 dangle-tolerant），但启动时才逐个报
`workflow-call-ref-missing` / `agent-not-found`。要真正搬一套配置，用户得手工按依赖顺序
一个个重建技能、MCP、插件、代理，再导入工作流——依赖越深越不可能做对。

工作组更彻底：**根本没有导出**。详情页「更多操作」里只有 复制 / 重命名 / 访问权限 / 删除。

## 2. 目标

把「导出 YAML」升级为**导出配置包**：一个 zip，装下这个资源**递归闭包内的全部可移植配置**，
并提供与之配套的导入，使「在 A 实例导出 → 在 B 实例导入 → 直接能跑」成为一条走得通的路径。

- 六类 ACL 资源（代理 / 技能 / MCP / 插件 / 工作流 / 工作组）都能作为**包的根**导出。
- 闭包递归、去重、去环：工作流 → 代理 / 子工作流 / 工作组；代理 → 技能 + MCP + 插件 +
  `dependsOn` 子代理；工作组 → 成员代理。同一个资源被两处引用只存一份。
- 包内目录结构按资源类型平铺，配 `manifest.yaml`（权威清单）与 `README.md`（人类摘要）。
- 导入走**预检页逐条决策**：每个资源单独选「复用已有 / 新建副本 / 覆盖」，确认后一次落地，
  且**崩溃后可收敛**（前滚或回滚二选一，可证明）。
- 导出与导入同时提供 CLI。

## 3. 非目标

- **不导出运行态**：任务、node_run、评审记录、聊天室消息、记忆、蒸馏作业一律不进包。
- **不导出账户面**：用户、权限矩阵、OIDC、PAT、令牌审计不进包。
- **不导出仓库**：`cached_repos` / `repo_groups` 与其密封凭据不进包（跨机器不可解密，见
  RFC-213 AC-12）。
- **不替代 backup/restore**：那是整机冷备份（`tar.gz` + `db.sqlite`），本 RFC 是资源级可移植包，
  两条线互不影响、互不复用产物。
- **不做跨格式版迁移**：`formatVersion` 高于本二进制的包直接拒绝，不猜。
- **不做增量包 / 差分包 / 包签名 / 包加密**。
- **不扫描技能文件内容里的密钥**（决策 18）：脱敏保证明确限定在**结构化字段**，技能目录树
  里硬编码的凭据属于技能作者的责任，文档里写明。
- **不改任何执行期行为**：调度、准入、containment、runtime 选择零改动。

## 4. 用户故事

1. 我在测试实例上调好了一条 `Code → Audit → Fix` 工作流，牵扯 4 个代理、2 个技能、1 个
   MCP。我在编辑页点「导出配置包」，拿到一个 zip；在生产实例的工作流列表点「导入配置包」，
   预检页列出这 9 个资源、逐条确认后一次导入完成，直接可以启动任务。
2. 我要把一个成熟的审计代理分享给同事。我在代理详情页导出配置包，里面自动带上它的技能与
   `dependsOn` 子代理；同事导入时，他已经有的同名 MCP 选「复用已有」，代理选「新建副本」。
3. 我在 CI 里要把配置从 staging 同步到 prod：`agent-workflow export-package --as-user ci
   --type workflow --name code-review -o pkg.zip`，然后在 prod 上
   `agent-workflow import-package pkg.zip --as-user deployer --plan > plan.yaml`，人工复核
   `plan.yaml` 后 `--apply plan.yaml`。
4. 我导出的工作流里有个 MCP 需要 `GITHUB_TOKEN`。包里那一项是脱敏占位，manifest 的待填清单
   列出了它；导入预检页在那一条上直接给了输入框，我当场填进去，导完即可用。

## 5. 能力影响清单（CLAUDE.md 规则 7 强制）

本 RFC 关闭 / 收缩**七项**既有能力。C6 / C7 是 Codex 设计门查出、我第一版漏列的，需要你补确认：

| # | 被关闭的能力 | 现状 | 改后 | 受影响者 |
|---|---|---|---|---|
| **C1** | 工作流单文件 YAML **导出** | 编辑页「导出 YAML」→ `GET /api/workflows/:id/export`，返回 `application/yaml` | 入口改名为「导出配置包」，端点**下线**，由 `GET /api/workflows/:id/export-package`（zip）取代 | 任何在脚本里 curl 该端点并解析 YAML 的自动化**立即失效** |
| **C2** | 裸 `.yaml` **导入** | `POST /api/workflows/import` + `WorkflowImportDialog` 接受 YAML 文本 | 端点与对话框**下线**，导入只接受 zip | 手里存着旧 YAML 文件、且源实例已不存在的人**没有导入路径**（只能手工重建） |
| **C3** | 救援态「导出本地 YAML」 | 工作流被删 / 不可访问时，纯浏览器端从内存快照生成 `xxx-unsaved.yaml`（RFC-199 B2，不依赖服务端） | **删除**。配置包必须服务端生成闭包，救援态没有服务端 | 工作流被删后，本地草稿只剩「另存副本」，**不能再导出成文件** |
| **C4** | 无特权权限者导出含特权节点的工作流 | 今天**允许**：`export` 路由已套 RFC-270 镜头，无 `scripts:author` 的人拿到脚本正文为 `***` 的 YAML | **422 拒绝导出**（`package-privileged-node-forbidden`），**按节点类型分轴判定**：缺 `scripts:author` 只挡含脚本节点的包，缺 `code-host-calls:author` 只挡含代码平台节点的包 | 普通用户导不出含对应特权节点的工作流，哪怕只想要拓扑 |
| **C5a** | 按 **exact id** 覆盖导入 | `mode:'overwrite'` 按 YAML 里的 `id` 精确匹配覆盖目标 | 包不带 `id`，覆盖改为**按名字匹配** | **所有角色**共同失去 exact-id 覆盖 |
| **C5b** | 覆盖**他人拥有**的资源 | resource-admin（manager / admin）今天可覆盖任何可见工作流 | 覆盖仅对**自己拥有**的资源开放 | 只影响 **manager / admin**；普通用户本来就只能改自己的（门在持久化原语上） |
| **C6** 🆕 | **PAT（令牌）导入** | `POST /api/workflows/import` 是 `tokenAccess:'allow'`，PAT 可直接导入工作流 | 新的 preview / commit 端点 `tokenAccess:'never'`，旧端点删除 | 用 PAT 做自动化导入的调用方**没有迁移路径**（导入会新建资源并决定权属，不该是令牌能做的事）。CLI 的 `--as-user` 是替代方案，但那是本机 break-glass 通道，不等价 |
| **C7** 🆕 | 导出**传递不可见**闭包的工作流 | 今天可以：`workflowDefinitionToSelectors` **只检查直接的 `agent-single` 引用**，不走 `dependsOn` / skills / mcp / plugins | 包要遍历完整闭包，途中遇到任一不可见资源 → **整体 422 并明确提示无法导出**（你的决策） | 真实场景：Bob 的代理 A 授权给你、A `dependsOn` 未授权的 B → 你今天导得出、改后导不出。这类工作流**仍可正常运行**（RFC-099 D3 隐式授权），只是不可导出 |

> **C8 曾是候选但已消解**：设计门指出「call 引用名字命中 2+ 可见候选 → 422」会让一个今天能
> 确定性启动的工作流失去导出能力。按你的决策，导出改为**沿用 `freezeCallClosure` 的同一条
> 规则**（可见行中最老 ULID 胜出）并在 README / manifest 里标注，因此不构成收缩。

C1 / C2 / C5a / C6 是 wire breaking：包格式与 YAML 格式不互通，旧二进制与新二进制之间没有兼容期。

## 6. 已确认的产品决策

### 6.1 五轮澄清（2026-08-08）

1. **导出 + 导入同期交付**，导入入口统一收 zip，裸 YAML 能力下线。
2. **密钥一律脱敏**（范围见决策 18）：值收敛为占位符、键名保留；manifest 生成待填清单，
   预检页对每项给输入框当场补。
3. **闭包里有导出者不可见的依赖 → 整体 422 并明确提示无法导出**。⚠️ 第一轮我把这条说成
   「沿用现状」是错的（见 C7），你在知悉真实现状后仍选择维持 422。
4. **覆盖只对自己拥有的资源开放**；别人的同名资源只给「复用已有 / 新建副本」。包不携带任何
   权属信息，新建一律「导入者 owner + `private`」（RFC-231 硬规则，导入不得成为旁路）。
5. **机器级依赖不进包**：runtime 执行档、代码平台连接、MCP `command[0]` 可执行文件、插件源、
   仓内 `project` 技能只写进 manifest 的 `requirements` 段。
6. **框架内置资源不进包**（`builtin` / `owner=__system__`）：只记依赖声明，导入时按名字绑本地
   内置件；本地没有则预检页报错。
7. **特权节点无权限直接拒绝导出**（C4），且按节点类型分轴判定。
8. **体积上限沿用 `SKILL_ZIP_LIMITS`**：总 64 MB / 单文件 10 MB / 2000 条目 / 12 层。
9. **预检页匹配规则**：优先匹配「你自己拥有的同名资源」；没有则列出全部可见同名候选（带
   owner）让你指定；一个都没有则默认新建。
10. **导入失败即停 + 回滚已建**：要么整包落地，要么当什么都没发生（实现见决策 17）。
11. **权限不足 → 预检页标红，不解决不让导**。
12. **manifest 只记格式版 + 平台版 + 导出时间**，不记导出者、不记源实例、不记源资源 id。
13. **插件只带 `spec` + `options`**，不打包 `cachedPath` 的实际代码。
14. **「新建副本」名字自动生成且可现场改**。
15. **CLI 导出导入都给**；**两条命令都必须 `--as-user <用户名>`**（决策 20），且导入同时支持
    `--on-conflict` 全局档与 `--plan` / `--apply` 逐条决策文件。
16. 导出入口一律放**详情 / 编辑页的「更多操作」**；导入入口**各资源列表页各一个 + 类型不符时
    自动跳到对的页面继续**。

### 6.2 设计门后追加（2026-08-08，Codex 12 条 findings 核实后）

17. **加一张表保真原子**（对 A1 / A3 的回应）：新增 `resource_package_imports` journal
    （逐 artifact 的 phase / fingerprint / DB before-image）+ 一个迁移 + 启动期收敛。
    ⚠️ 这**推翻**了我第一版「零新表、零迁移」的承诺。技能 / 插件的落地改为复用既有持久化
    内核（`createManagedSkillWithFiles` / `commitSkillVersion` / plugin coordinator），
    **不再自造「裸 DB insert + rename」**——`skill-zip.ts:415` 的注释明写那条路会留下
    `versionState='legacy-unbackfilled'`，**单测能过但活 daemon 上每次都挂**。
18. **脱敏范围限定在结构化字段**：不扫描技能文件树内容。AC-6 的措辞相应收窄，文档写明
    「技能目录里硬编码的凭据属于作者责任」。
19. **同名二义沿用 launch 规则**：导出按 `freezeCallClosure` 的「可见行中最老 ULID 胜出」
    解析，并在 README / manifest 标注候选数与选中项，不再 422（消解 C8）。
20. **CLI 两条命令都要 `--as-user`**：导出的 ACL 可见性、闭包判据、C4 分轴门都需要 Actor；
    没有 Actor 就要么无声 impersonation、要么绕过网页判据。文档同时写明「能访问 appHome /
    SQLite 的本机操作者本身就是 break-glass 管理员」，不把 CLI 描述成终端用户认证。

## 7. 验收标准

### 导出

- **AC-1** 六类资源的详情 / 编辑页「更多操作」都有「导出配置包」，产物是 zip，文件名取资源名。
- **AC-2** 包内结构为 §8 的固定布局；`manifest.yaml` 的 `resources` 是权威清单，包内出现未登记
  的文件时导入**拒绝**（防夹带）。
- **AC-3** 闭包完整：工作流带出其全部 `agent-single` 代理、`call-workflow` 子工作流、
  `call-workgroup` 工作组，并递归到代理的技能 / MCP / 插件 / `dependsOn` 子代理。
- **AC-4** 闭包去重且**去环**（`A → B → A` 不死循环、不重复导出、导入侧也不要求拓扑序）。
- **AC-4b** 🆕 每个 manifest 条目带 **opaque `packageResourceKey`**（不含源实例信息）；所有依赖
  边、可移植引用、预检决策与导入重绑一律按该 key 工作，**不按名字**。两个不同 owner 的同名
  `agent/worker` 各自独立可寻址。
- **AC-5** 技能带**整棵文件树**（fs 是事实源），不是只有 `SKILL.md`。
- **AC-6** **结构化字段**中的密钥值收敛为占位符、键名保留；manifest 的 `secrets` 段逐条列出
  `资源类型 / 资源名 / 字段路径`。覆盖面复用 `intentSecretSlots.ts` 的既有载体清单（MCP argv /
  URL 内嵌凭据 / headers / oauth / plugin spec·options / agent `frontmatterExtra` / 工作流
  passthrough 字段 / 脚本 env），**不**含技能文件树内容（决策 18）。
- **AC-7** 闭包内出现导出者不可见的 **id 域**资源（代理 / 技能 / MCP / 插件）→ **422**
  `package-export-ref-unavailable`，错误信息明确「因存在你无权访问的依赖，无法导出」。
- **AC-7b** 🆕 **name 域** call 引用（`call-workflow` / `call-workgroup`）**不得**成为存在性
  预言机：「零匹配行」与「有行但全部不可见」必须产生**逐字节相同**的 dangling 结果。
- **AC-7c** 🆕 name 域命中 2+ 可见候选时按 `freezeCallClosure` 同一规则（最老可见 ULID）选定，
  并在 manifest / README 标注候选数与选中项。
- **AC-8** 闭包内出现特权节点且导出者缺**对应**权限 → 422，**分轴判定**：`lens.scripts &&
  闭包含 script 节点` 与 `lens.codeHost && 闭包含 code-host-call 节点` 各自独立。
- **AC-9** `builtin` / `owner=__system__` 资源不写进 `resources`，只写进 `builtins` 声明。
- **AC-10** runtime / 代码平台 / MCP 可执行文件 / 插件源 / **仓内 `project` 技能**写进
  `requirements`，且**不含任何密钥**（插件 spec 在此处同样脱敏）。
- **AC-11** 超过 `SKILL_ZIP_LIMITS` 任一维度 → 422 并点名超限的资源与维度。
- **AC-12** 根资源沿用现有 exact-revision 保护（`expectedVersion` 不匹配 → 409）；依赖资源取
  导出时刻快照。

### 导入

- **AC-13** 各资源列表页与统一入口都能上传 zip；包的 `root` 类型与当前页不符时**自动跳转**。
- **AC-14** 预检页逐条列出包内资源，每条显示：类型、名字、本地匹配结果、可选动作、所需权限
  是否满足。
- **AC-14b** 🆕 本地存在**多个**你自己拥有的同名资源时（工作流无唯一约束，这是合法状态），
  预检页列出全部并要求显式选定一个 stable id，**不得**静默折叠成单个匹配。
- **AC-15** 「覆盖」仅在本地同名资源属于你自己时可选。
- **AC-16** 「新建副本」默认填一个不冲突的名字，且可现场编辑。
- **AC-17** 任一条目权限不满足 → 标红，**整包不可提交**，写明缺哪个权限点。
- **AC-18** 待填密钥在预检页逐条给输入框；填了就写入，留空就跳过并进导入报告。
- **AC-19** 工作组人类席位：包里带 `username`，自动匹配同名本地用户；匹配不上则要求手动指派
  或删除该席位，**未处理不可提交**。
- **AC-20** 导入是一个**可收敛**的原子操作：任一步失败或进程被 `SIGKILL` → 启动期收敛能
  **证明**该前滚还是回滚，最终状态要么整包落地、要么与导入前一致。
- **AC-20b** 🆕 正式资源行在 journal 到达 `committed` 之前对读 / 启动路径**不可见**，杜绝
  「DB 已提交、FS 未发布」窗口里被 daemon 读到并启动。
- **AC-21** 新建资源一律 `owner = 导入者`、`visibility = 'private'`、零 grants；覆盖不改动本地
  资源的 owner / visibility / grants。
- **AC-22** 导入后包内的跨资源引用**按 `packageResourceKey` 绑到本次导入的结果**（复用 / 新建
  混合时各自绑对），而不是本地任意同名资源。
- **AC-23** `formatVersion` 高于本二进制 → 拒绝并提示升级。
- **AC-24** 🆕 决策必须携带各类型的**内容级** exact token 并在最终事务内 CAS：工作流 /
  工作组 `expectedVersion`、代理 `expectedUpdatedAt + expectedAclRevision`、MCP / 插件
  `expectedConfigHash`、技能 `contentVersion + metaRevision + aclRevision`。仅比对 ACL 不够
  ——两个并发导入串行执行时会静默丢掉先完成那个的内容。
- **AC-24b** 🆕 技能目标同时取得 `skill_operation_locks`；同目标的第二个导入返回 409 要求
  重新预检。
- **AC-25** 🆕 技能与插件落地**必须**走既有内核（`createManagedSkillWithFiles` /
  `commitSkillVersion` / plugin 安装 + coordinator），产出完整的 `skill_versions` v1 快照、
  content hash 与非空 `cached_path`；测试断言导入后的技能能通过 `skillBootVerify`。

### CLI

- **AC-26** `agent-workflow export-package --as-user <u> --type <t> --name <n> [--owner <u2>]
  -o <file>` 产出与网页完全相同的字节；缺 `--as-user` 直接报错退出。
- **AC-27** `agent-workflow import-package <zip> --as-user <username>`，缺 `--as-user` 报错退出。
- **AC-28** `--plan` 输出可编辑的决策文件；`--apply <plan>` 按其执行；`--on-conflict` 提供全局
  一档快捷方式（与 `--plan` 互斥）。
- **AC-29** CLI 的权限校验、owner 归属、回滚语义与网页**逐条一致**，不是旁路。

### 能力下线（C1–C7 的锁）

- **AC-30** `GET /api/workflows/:id/export` 与 `POST /api/workflows/import` 不再注册；路由清单
  测试显式断言其消失，并断言新导入端点是 `tokenAccess:'never'`（C6）。
- **AC-31** 前端不再存在 `downloadWorkflowLocalDraft` 与 `WorkflowImportDialog` 的 YAML 路径；
  源码层文本断言锁住。
- **AC-32** 无 `scripts:author` 的用户导出含脚本节点的工作流 → 422；**有 `scripts:author`、无
  `code-host-calls:author`、闭包只含脚本节点 → 允许导出**（C4 分轴的正例，独立权限矩阵测试）。
- **AC-33** 🆕 传递不可见闭包（代理可见但其 `dependsOn` 不可见）→ 422（C7 的锁），错误文案与
  直接不可见一致。

## 8. 包结构

```
code-review-配置包.zip
├── manifest.yaml          # 包元信息 + 权威资源清单（含 packageResourceKey）+ 内置依赖
│                          #   + 环境要求 + 待填密钥索引
├── README.md              # 自动生成的人类摘要
├── workflows/
│   ├── code-review.yaml           # 根（manifest.root 指向）
│   └── deep-audit.yaml            # call-workflow 递归带出
├── workgroups/
│   └── fix-squad.yaml             # call-workgroup 递归带出
├── agents/
│   ├── auditor.md                 # agent.md（复用现有 parser / serializer）
│   └── fixer.md                   # dependsOn 子代理闭包
├── skills/
│   └── review-checklist/          # 技能整树（fs 是事实源）
│       ├── SKILL.md
│       └── references/rules.md
├── mcps/
│   └── github.yaml                # env / headers / oauth / argv / URL 内嵌凭据均已脱敏
└── plugins/
    └── inventory.yaml             # spec（脱敏）+ options（脱敏），无 cachedPath 代码
```

文件名只是人类可读的定位符——**权威身份是 `manifest.resources[].packageResourceKey`**。
同名不同 owner 的资源各自独立成条目，文件名追加 `-2` / `-3` 后缀消歧。

## 9. 度量与回归防护

- 闭包遍历、去重、去环、`packageResourceKey` 分配是纯函数，独立单测（不需要 DB）。
- 六类根 × 「有依赖 / 无依赖 / 有环 / 有内置件 / 有不可见件 / 有传递不可见件 / 有特权节点 /
  有同名不同 owner / 有同名同 owner」矩阵覆盖。
- 导入预检匹配规则与三档决策的笛卡尔积覆盖；混合「复用 + 新建」的同名重绑单独锁。
- **崩溃收敛**用注入式故障点验证：在 journal 的每个 phase 边界注入 `SIGKILL` 等价中断，重启后
  断言收敛到「整包落地」或「与导入前一致」二者之一。
- 并发导入用两个 actor 同目标验证 AC-24 / AC-24b 的 409。
- 导入后的技能必须通过 `skillBootVerify`（AC-25 的锁——这是 `skill-zip.ts:415` 注释里那个
  「单测能过、活 daemon 上必挂」的坑的专门防线）。
- C1–C7 每条下线都有一条**源码层文本断言**兜底。
