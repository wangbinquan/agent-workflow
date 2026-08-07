# RFC-268 · Webhook 触发器支持临时空间执行

- 状态：In Progress（2026-08-07 用户已批准；明确跳过外部设计门）
- 日期：2026-08-07
- 作者：Codex（与用户确认执行空间语义）
- 设计门：用户明确要求跳过；本地源码/契约自审继续作为实现检查，不冒充外部门 `APPROVE`
- 关联：RFC-165（统一任务创建与 scratch 空间）、RFC-243（统一 `startExecution`）、RFC-257（Webhook 触发器）、RFC-260（Webhook 全员只读）

## 1. 背景

RFC-257 把 Webhook 触发器固定成“事件仓即任务仓”：命中事件后，平台先查找事件仓的缓存，未命中时按 `autoRegisterRepos` 决定现场 clone 或跳过，再把 `cachedRepoId` / `repoUrl` 与事件分支注入 workflow、agent 或 workgroup 的启动参数。

这对“审代码、改代码、push 回 MR”是正确默认值，但不是所有 Webhook 自动化都需要源码。以下任务只消费事件参数或调用外部工具：

- 按 `{{comment_text}}` 生成回复；
- 汇总流水线状态并通知；
- 根据 `{{project_id}}` / `{{mr_id}}` 调用已配置的 MCP；
- 记录、分类或路由入站事件。

今天这些任务仍必须解析、缓存或 clone 事件仓；仓库未注册且关闭自动注册时甚至无法启动。它们为一份不会读取的源码支付网络、凭据、磁盘和延迟成本。

RFC-165 已有成熟的临时空间语义：为任务创建一个全新的 Git 仓库，初始化 `main` 并写入空 root commit，不挂任何源仓或 remote；任务产物、保留和 GC 继续走既有任务链路。本 RFC 将这一能力接入 Webhook 触发器，而不创造第二种“临时工作区”。

## 2. 目标

1. Webhook 触发器可在“事件仓库”与“临时空间”之间选择执行空间，覆盖 workflow / agent / workgroup 三种目标。
2. 临时空间模式完全绕过事件仓的缓存查找、clone 与自动注册；仓库未导入也能启动。
3. 仓库范围、事件类型、分支过滤、模板变量、streamKey、supersede 与熔断继续基于原事件工作，不因没有任务源仓而丢失上下文。
4. 复用 RFC-165 的 scratch 启动、产物、保留和 GC 语义；不新增数据库工作区模型。
5. 既有触发器与新建触发器默认仍使用事件仓库，升级后行为逐字保持。
6. UI 明确展示执行空间，避免用户误以为临时空间内含有事件仓源码。

## 3. 非目标

- **不是**“先 clone 事件仓，再在任务结束时删掉”的一次性 checkout；临时空间从第一字节起就是空仓。
- 不给临时空间预装事件仓文件、MR diff、CI 日志或 provider API 响应。
- 不新增 `repoGroupId`、`sourceTaskId`、上传文件或本地路径作为 Webhook 启动源。
- 不改变临时空间的保留时间、GC、归档、diff 或任务详情呈现。
- 不新增网络隔离、凭据注入或平台侧出站回帖；任务内现有的外部 HTTP / MCP 副作用不会因使用临时空间而回滚。
- 不改变触发器匹配、权限、owner 身份、熔断、supersede、重放或投递去重语义。
- 不把临时空间设为默认值，也不批量迁移现有触发器。

## 4. 用户故事

**S1（评论自动化）**：管理员创建 `/summarize` 评论触发器，目标选 agent，执行空间选“临时空间”。事件仓从未导入且自动注册关闭，事件仍能启动；agent 在空仓内收到 `{{comment_text}}`、`{{project_id}}`、`{{mr_id}}` 等模板数据。

**S2（保留代码工作流）**：现有“MR 自动修复”触发器升级后没有 `scratch` 字段，仍解析事件仓、checkout 事件分支并可按既有配置 commit/push，行为不变。

**S3（Git 输入）**：workflow 有一个 git-kind 输入并映射为“事件分支”。临时空间模式下该输入仍收到 `{"kind":"branch","ref":"feature/x"}`，但它只代表事件元数据；任务根目录仍是空 scratch 仓，平台不会把 `feature/x` checkout 进来。

**S4（排障）**：只读用户在触发器卡片上能看到“事件仓库”或“临时空间”标识。管理员编辑临时空间触发器时看不到“自动注册事件仓”开关，复核页明确提示“无事件仓源码、无 remote、不可自动 push”。

## 5. 决策记录

用户已确认：临时空间复用现有 scratch；不是临时 clone；事件匹配与模板上下文保留；仓库专属选项在该模式下隐藏/禁止；旧默认不变。

| #   | 决策            | 内容与理由                                                                                                                                                                   |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 产品模式        | 执行空间只有“事件仓库”与“临时空间”两档；三种 launch kind 均支持                                                                                                              |
| D2  | wire 单一事实源 | 在既有 `launch_payload` 内复用 `scratch: true`；字段缺失代表事件仓库，不新增 `workspaceMode` 列或平行枚举                                                                    |
| D3  | canonical 形状  | Webhook 模板只接受 `scratch: true`，不持久化 `scratch: false`；因此旧行字节形状不变，模式判断只有“是否为 true”一个分支                                                       |
| D4  | 默认与迁移      | 既有行没有 `scratch`，升级后仍跑事件仓；新建草稿也默认事件仓；零 DB migration                                                                                                |
| D5  | scratch 定义    | 复用 RFC-165：fresh `git init` + `main` + 空 root commit，无 source repo、无 remote、无事件分支 checkout                                                                     |
| D6  | repo 解析       | `scratch: true` 时不得调用 `resolveRepoForEvent`，也不得读取缓存仓或根据 endpoint clone protocol 拼启动源                                                                    |
| D7  | 事件上下文      | repo scope、branch filter、模板变量、任务名、streamKey、supersede、熔断仍使用完整 `CodeHostEvent`；临时空间只改变任务文件系统来源                                            |
| D8  | 分支语义        | scratch 启动 payload 不注入顶层 `ref`；事件确有分支时，`{{branch}}` 与 workflow 的 `event-branch` 映射继续存在，但明确是事件元数据而非 checkout 指令；无分支事件不合成默认值 |
| D9  | 远端专属字段    | `scratch: true` 与 `workingBranch`、任何已定义的 `autoCommitPush`（包括 `false`）互斥，复用 `StartTaskSchema` 的 fail-closed 语义                                            |
| D10 | 自动注册        | scratch 触发器的 `autoRegisterRepos` 必须为 `false`；UI 选中 scratch 时自动置 false 并隐藏开关，API 若传 true 或依赖 create 默认 true 则 422，避免“保存成功但字段被静默忽略” |
| D11 | 产物与生命周期  | 任务行沿既有链路记录 `spaceKind='scratch'`；diff、任务详情、保留和 GC 全部复用，不增加 fire outcome                                                                          |
| D12 | 兼容策略        | 新二进制读取旧行无变化；旧二进制因 strict payload schema 不认识 `scratch` 而跳过该触发器，fail closed，不会静默改在事件仓执行                                                |

## 6. Wire 示例

### 6.1 事件仓库（现有 canonical 形状，默认）

```json
{
  "launchKind": "agent",
  "launchRefId": "01AGENT",
  "launchPayload": {
    "description": "Review {{repo_path}} at {{branch}}"
  },
  "autoRegisterRepos": true
}
```

fire 时继续注入 `cachedRepoId` 或 `repoUrl`，并在事件提供分支时注入顶层 `ref`。

### 6.2 临时空间

```json
{
  "launchKind": "agent",
  "launchRefId": "01AGENT",
  "launchPayload": {
    "scratch": true,
    "description": "Summarize {{comment_text}} for {{repo_path}}!{{mr_iid}}"
  },
  "autoRegisterRepos": false
}
```

fire 时生成的启动源只能是 `scratch: true`；不得出现 `repoUrl`、`cachedRepoId`、`ref`、`workingBranch` 或 `autoCommitPush`。

## 7. 能力与行为影响清单

### C1 · 新增空仓执行能力

选择临时空间后，任务无需事件仓可达、无需 Git clone 凭据，也不会读取或修改事件仓。这是新增能力，不收缩默认行为。

### C2 · 临时空间不等于无网络

scratch 只改变文件系统来源。agent / workflow 仍受现有 runtime、containment、MCP 和网络策略约束；如果当前策略允许外部请求，任务发出的评论、通知或 API 调用不会被任务取消、supersede 或 scratch 清理回滚。

### C3 · 分支字段变成纯元数据

临时空间任务中，`{{branch}}` 和 `event-branch` 输入仍可用于提示词或 API 参数，但工作区里不存在该分支的文件。这一点必须同时出现在选择卡、复核摘要与运维文档，避免“看到 branch 值就以为已 checkout”的误解。事件本身没有分支时，平台继续按既有行为让 required git 输入在运行期校验失败；scratch 不猜默认分支。

### C4 · 远端选项变为非法

`autoRegisterRepos`、`workingBranch`、`autoCommitPush` 都依赖事件仓或 remote。临时空间下不允许保存这些能力；不是忽略它们。切回事件仓后，管理员可以重新开启自动注册。

### C5 · 旧版本降级为关闭而非错仓执行

新字段位于 strict `launch_payload`。回滚到未实现本 RFC 的二进制时，scratch 触发器会被识别为不可解析并跳过；这会造成该触发器暂时不执行，但不会在事件仓上意外运行。升级/回滚说明需写明这一点。

## 8. 验收标准（可证伪）

### 契约与保存

- **AC-1** workflow / agent / workgroup 三个 Webhook payload schema 均接受 canonical `scratch: true`，仍拒绝 `repoUrl`、`cachedRepoId`、`repoGroupId`、`sourceTaskId` 与顶层 `ref`。
- **AC-2** `scratch: true` 与 `workingBranch`、`autoCommitPush: true`、`autoCommitPush: false` 的任一组合均在保存期 422；不是 fire 后失败。
- **AC-3** scratch + `autoRegisterRepos: true` 以及 scratch + create 默认值（省略该字段）均 422；显式 false 通过。create 与 partial update 都按“合并后的完整候选”校验，不能用只改其中一个字段绕过；并发修改 launch payload/ref/event-types/auto-register 时，至多一个基于同一旧快照的写入成功，另一请求 409 重读重试。
- **AC-4** 老 payload 无 `scratch` 的 create / update / GET 字节形状和事件仓行为不变；不产生 migration。

### 分发与启动

- **AC-5** scratch 事件在事件仓未缓存且 `autoRegisterRepos=false` 时成功 `launched`，且 `resolveRepoForEvent` 零调用；同一事件仓模式仍得到 `skipped-repo-unregistered`。
- **AC-6** 三种 launch kind 的渲染结果均只含 `scratch: true`，不含任何 repo source、顶层 `ref`、`workingBranch` 或 `autoCommitPush`；最终任务行均为 `spaceKind='scratch'`。
- **AC-7** scratch 工作目录是 fresh Git repo，分支为 `main`，只有空 root commit，无 remote、无事件仓文件；不是 clone 后删除。
- **AC-8** `{{repo_path}}`、`{{branch}}`、`{{mr_iid}}` 等模板变量与 workflow `event-branch` 输入在 scratch 下继续按事件渲染；后者不得触发事件仓 checkout。事件无 branch 时仍走既有 `git-value-invalid` / launch-failed 路径，不合成默认分支。
- **AC-9** scratch 与事件仓两档都经过同一个 `assertScheduledTargetUsable` 和 `startExecution` 收口；目标失效、owner 失效与运行失败继续使用既有 outcome/error 语义。
- **AC-10** scratch fire 继续参与同一 streamKey 的 supersede、熔断和计数；从事件仓模式切为 scratch 不另开一条 stream。

### UI、可见性与文档

- **AC-11** 新建触发器默认“事件仓库”；编辑旧触发器也显示事件仓库；编辑 scratch 触发器可无损 round-trip。
- **AC-12** 目标步骤复用公共 `ChoiceCards` 显示两档。选择 scratch 后自动将 auto-register 置 false，复核页不渲染该开关，并显示“空仓 / 无 remote / 不自动 push”提示；切回事件仓后开关重新可见。
- **AC-13** 管理员与 RFC-260 的只读用户都能在触发器卡片、详情/复核信息中识别执行空间；中英文案齐全，390px 与桌面宽度无截断或横向溢出。
- **AC-14** `docs/webhook-triggers.md` 更新两种模式、空仓定义、分支元数据语义、远端选项限制和旧版本回滚行为；RFC-257 D17 / design §5.1 增加“由 RFC-268 扩展”的历史注记，不改写原始决策。

## 9. 实施授权

用户已于 2026-08-07 明确批准本 RFC，并要求跳过外部设计门；因此生产代码可按
`plan.md` 的 T2–T8 实施。跳过设计门只替代“请批前”的外部评审，不降低自动化
测试、真实运行、浏览器验收、完整本地门禁或实现收口标准；任何未完成门禁都必须
如实记录，不得把 In Progress 提前写成 Done。
