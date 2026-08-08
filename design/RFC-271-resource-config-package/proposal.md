# RFC-271 · 资源配置包（递归闭包导出 / 导入）

状态：Draft（2026-08-08 落档，等待用户批准后进入实现阶段）。

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
  `dependsOn` 子代理；工作组 → 成员代理。同一个代理被两个工作流引用只存一份。
- 包内目录结构按资源类型平铺，配 `manifest.yaml`（权威清单）与 `README.md`（人类摘要）。
- 导入走**预检页逐条决策**：每个资源单独选「复用已有 / 新建副本 / 覆盖」，确认后一次落地。
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
- **不改任何执行期行为**：调度、准入、containment、runtime 选择零改动。

## 4. 用户故事

1. 我在测试实例上调好了一条 `Code → Audit → Fix` 工作流，牵扯 4 个代理、2 个技能、1 个
   MCP。我在编辑页点「导出配置包」，拿到一个 zip；在生产实例的工作流列表点「导入配置包」，
   预检页列出这 9 个资源、逐条确认后一次导入完成，直接可以启动任务。
2. 我要把一个成熟的审计代理分享给同事。我在代理详情页导出配置包，里面自动带上它的技能与
   `dependsOn` 子代理；同事导入时，他已经有的同名 MCP 选「复用已有」，代理选「新建副本」。
3. 我在 CI 里要把配置从 staging 同步到 prod：`agent-workflow export-package --type workflow
   --name code-review -o pkg.zip`，然后在 prod 上 `agent-workflow import-package pkg.zip
   --as-user deployer --plan > plan.yaml`，人工复核 `plan.yaml` 后 `--apply plan.yaml`。
4. 我导出的工作流里有个 MCP 需要 `GITHUB_TOKEN`。包里那一项是脱敏占位，manifest 的待填清单
   列出了它；导入预检页在那一条上直接给了输入框，我当场填进去，导完即可用。

## 5. 能力影响清单（CLAUDE.md 规则 7 强制）

本 RFC 关闭 / 收缩五项**既有能力**，逐条列出请你确认。它们不是「安全默认」，是产品形态替换的
直接后果：

| # | 被关闭的能力 | 现状 | 改后 | 受影响者 |
|---|---|---|---|---|
| **C1** | 工作流单文件 YAML **导出** | 编辑页「导出 YAML」→ `GET /api/workflows/:id/export`，返回 `application/yaml` | 入口改名为「导出配置包」，端点**下线**，由 `GET /api/workflows/:id/export-package`（zip）取代 | 任何在脚本里 curl 该端点并解析 YAML 的自动化**立即失效** |
| **C2** | 裸 `.yaml` **导入** | `POST /api/workflows/import` + `WorkflowImportDialog` 接受 YAML 文本 | 端点与对话框**下线**，导入只接受 zip | 手里存着旧 YAML 文件、且源实例已不存在的人**没有导入路径**（只能手工重建） |
| **C3** | 救援态「导出本地 YAML」 | 工作流被删 / 不可访问时，纯浏览器端从内存快照生成 `xxx-unsaved.yaml`（RFC-199 B2，不依赖服务端） | **删除**。配置包必须服务端生成闭包，救援态没有服务端 | 工作流被删后，本地草稿只剩「另存副本」，**不能再导出成文件** |
| **C4** | 无特权权限者导出含特权节点的工作流 | 今天**允许**：`export` 路由已套 RFC-270 镜头，无 `scripts:author` 的人拿到脚本正文为 `***` 的 YAML | **422 拒绝导出**（`package-privileged-node-forbidden`） | 普通用户从此导不出任何含脚本节点 / 代码平台调用节点的工作流，哪怕只想要拓扑 |
| **C5** | 工作流 YAML 的 `overwrite` 导入模式 | `mode: 'fail' \| 'new' \| 'overwrite'`，按 YAML 里的 `id` 匹配覆盖目标 | 包不带 `id`，覆盖改为**按名字匹配 + 仅限自己拥有的资源**（见 §6 决策 4） | 依赖「按 id 精确覆盖」的用法失效；覆盖别人的资源从此不可能 |

C1 / C2 / C5 是 wire breaking：旧二进制与新二进制之间**没有兼容期**，包格式与 YAML 格式不互通。
C3 / C4 是可用性收缩。若你要保留其中任何一条，现在说，我改设计。

## 6. 已确认的产品决策（2026-08-08 五轮澄清）

1. **导出 + 导入同期交付**，导入入口统一收 zip，裸 YAML 能力下线。
2. **密钥一律脱敏**：MCP `config.env` / `config.headers` / `config.oauth.clientSecret`、脚本节点
   `env`，值收敛为占位符、键名保留；manifest 生成待填清单，预检页对每项给输入框当场补。
3. **闭包里有导出者不可见的私有依赖 → 整体 422**（沿用现有
   `workflow-export-ref-unavailable` 的 fail-closed 姿势）。
4. **覆盖只对自己拥有的资源开放**；别人的同名资源只给「复用已有 / 新建副本」。包不携带任何
   权属信息，新建一律「导入者 owner + `private`」（RFC-231 硬规则，导入不得成为旁路）。
5. **机器级依赖不进包**：runtime 执行档、代码平台连接、MCP `command[0]` 可执行文件、插件源
   只写进 manifest 的 `requirements` 段，作为「导入方需要自备什么」的声明。
6. **框架内置资源不进包**（`builtin` / `owner=__system__`）：只在 manifest 记一条依赖声明，
   导入时按名字绑本地内置件；本地没有则预检页报错。
7. **特权节点无权限直接拒绝导出**（C4），不给半成品包。
8. **体积上限沿用 `SKILL_ZIP_LIMITS`**：总 64 MB / 单文件 10 MB / 2000 条目 / 12 层。超限 422
   并点名是哪个资源撑爆的。
9. **预检页匹配规则**：优先匹配「你自己拥有的同名资源」；没有则列出全部可见同名候选（带
   owner）让你指定；一个都没有则默认新建。
10. **导入失败即停 + 回滚已建**：要么整包落地，要么当什么都没发生。
11. **权限不足 → 预检页标红，不解决不让导**（逐类校验 `*:create` / `*:update`，含
    `scripts:author` / `code-host-calls:author`）。
12. **manifest 只记格式版 + 平台版 + 导出时间**，不记导出者、不记源实例、不记源资源 id。
13. **插件只带 `spec` + `options`**，不打包 `cachedPath` 的实际代码。
14. **「新建副本」名字自动生成且可现场改**。
15. **CLI 导出导入都给**；导入**必须** `--as-user <用户名>`，且同时支持 `--on-conflict` 全局档
    与 `--plan` / `--apply` 逐条决策文件。
16. 导出入口一律放**详情 / 编辑页的「更多操作」**；导入入口**各资源列表页各一个 + 类型不符时
    自动跳到对的页面继续**。

## 7. 验收标准

### 导出

- **AC-1** 六类资源的详情 / 编辑页「更多操作」都有「导出配置包」，产物是 zip，文件名取资源名。
- **AC-2** 包内结构为 §8 的固定布局；`manifest.yaml` 的 `resources` 是权威清单，包内出现未登记
  的文件时导入**拒绝**（防夹带）。
- **AC-3** 闭包完整：工作流带出其全部 `agent-single` 代理、`call-workflow` 子工作流、
  `call-workgroup` 工作组，并递归到代理的技能 / MCP / 插件 / `dependsOn` 子代理。
- **AC-4** 闭包去重（同一资源只存一份）且**去环**（`A → B → A` 不死循环、不重复导出）。
- **AC-5** 技能带**整棵文件树**（fs 是事实源），不是只有 `SKILL.md`。
- **AC-6** 所有密钥字段值收敛为占位符、键名保留；manifest 的 `secrets` 段逐条列出
  `资源类型 / 资源名 / 字段路径`。
- **AC-7** 闭包内出现导出者不可见的资源 → **422** `package-export-ref-unavailable`，不产出半包。
- **AC-8** 闭包内出现特权节点且导出者缺对应权限 → **422**
  `package-privileged-node-forbidden`，不产出半包（C4）。
- **AC-9** `builtin` / `owner=__system__` 资源不写进 `resources`，只写进 `builtins` 声明。
- **AC-10** runtime / 代码平台 / MCP 可执行文件 / 插件源写进 `requirements`，且**不含任何密钥**。
- **AC-11** 超过 `SKILL_ZIP_LIMITS` 任一维度 → 422 并在错误详情里点名超限的资源与维度。
- **AC-12** 根资源沿用现有 exact-revision 保护（`expectedVersion` 不匹配 → 409）；依赖资源取
  导出时刻快照，不要求调用方提供版本号。

### 导入

- **AC-13** 各资源列表页与统一入口都能上传 zip；包的 `root.type` 与当前页不符时**自动跳转**到
  对应列表页继续预检（不报错）。
- **AC-14** 预检页逐条列出包内资源，每条显示：类型、名字、本地匹配结果（你自己的同名 / 可见候选
  列表 / 无）、可选动作、以及所需权限是否满足。
- **AC-15** 「覆盖」仅在**本地同名资源属于你自己**时可选；属于他人时该选项不出现。
- **AC-16** 「新建副本」默认填一个不冲突的名字，且可现场编辑。
- **AC-17** 任一条目权限不满足 → 该条标红，**整包不可提交**，错误信息写明缺哪个权限点。
- **AC-18** 待填密钥在预检页逐条给输入框；填了就写入，留空就跳过并进导入报告。
- **AC-19** 工作组人类席位：包里带 `username`，预检页自动匹配同名本地用户；匹配不上则要求手动
  指派或删除该席位，**未处理不可提交**。
- **AC-20** 导入是一个原子操作：任一步失败 → 已建资源（含已落盘的技能目录）全部回滚，DB 与文件
  系统都回到导入前状态。
- **AC-21** 新建资源一律 `owner = 导入者`、`visibility = 'private'`、零 grants；覆盖不改动本地
  资源的 owner / visibility / grants。
- **AC-22** 导入后包内的跨资源引用**绑到本次导入的结果**：子工作流的 `call-workflow` 指向本次
  新建 / 复用的那一个，而不是本地任意同名资源。
- **AC-23** `formatVersion` 高于本二进制 → 拒绝并提示升级；低于则按兼容规则读取。
- **AC-24** 提交时重新解析 zip，决策绑定预检时的 `resourceId + expectedAclRevision`；期间资源被
  改名 / 改权属 / 删除 → 409 要求重新预检（复用 `ImportRefSelection` fence 语义）。

### CLI

- **AC-25** `agent-workflow export-package --type <t> --name <n> [--owner <u>] -o <file>` 产出与
  网页完全相同的字节。
- **AC-26** `agent-workflow import-package <zip> --as-user <username>` 缺 `--as-user` 直接报错
  退出，不猜身份。
- **AC-27** `--plan` 输出可编辑的决策文件；`--apply <plan>` 按其执行；`--on-conflict=reuse|new|fail`
  提供全局一档快捷方式。
- **AC-28** CLI 的权限校验、owner 归属、回滚语义与网页**逐条一致**，不是旁路。

### 能力下线（C1–C5 的锁）

- **AC-29** `GET /api/workflows/:id/export` 与 `POST /api/workflows/import` 不再注册；路由清单测试
  显式断言其消失。
- **AC-30** 前端不再存在 `downloadWorkflowLocalDraft` 与 `WorkflowImportDialog` 的 YAML 路径；源码
  层文本断言锁住。
- **AC-31** 无 `scripts:author` 的用户导出含脚本节点的工作流 → 422（改判 RFC-270 遗留的「拿到
  `***` 占位仍可导出」行为）。

## 8. 包结构

```
code-review-配置包.zip
├── manifest.yaml          # 包元信息 + 权威资源清单 + 内置依赖 + 环境要求 + 待填密钥索引
├── README.md              # 自动生成的人类摘要（导入前能看懂这包是什么）
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
│   └── github.yaml                # env / headers / oauth.clientSecret 已脱敏
└── plugins/
    └── inventory.yaml             # 只有 spec + options，不含 cachedPath 代码
```

同名消歧：`(owner, name)` 是五类资源的复合唯一键、工作流连这个都没有，所以包内文件名冲突时
追加 `-2` / `-3` 后缀，**权威映射写在 `manifest.resources[].path`**，导入侧只认 manifest、
不靠文件名猜。

## 9. 度量与回归防护

- 导出闭包遍历、去重、去环是纯函数，独立单测（不需要 DB）。
- 六类根 × 「有依赖 / 无依赖 / 有环 / 有内置件 / 有不可见件 / 有特权节点」矩阵覆盖。
- 导入预检匹配规则（自己的 / 候选列表 / 无候选）与三档决策的笛卡尔积覆盖。
- 回滚用注入式故障点验证：在 DB 提交后、技能落位中途抛错，断言文件系统与 DB 都干净。
- C1–C5 每条下线都有一条**源码层文本断言**兜底，防止未来某次 refactor 把它们悄悄加回来。
