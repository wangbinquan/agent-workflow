# RFC-225 工作组版本化自动保存与一致性 UX — proposal

状态：In Progress（2026-07-23，源自用户「工作组能不能像工作流一样自动保存，并且 UX
体验也是自动保存的」；用户以「开始」批准实施，并追加要求工作组编辑页左上标题 / version / id
及右侧按钮层级与工作流对齐）。

## 1. 背景与现状证据

工作组详情页已经有较完整的本地草稿与“保存结果未知”保护，但用户面对的是三种互相不一致的保存方式：

1. `packages/frontend/src/routes/workgroups.detail.tsx` 的配置、成员别名和角色说明先留在本地，
   必须点击页头“保存全部”或成员面板里的“保存全部”；
2. 添加成员、删除成员、设为负责人又会直接调用 `startSave()`，表现为“部分动作自动保存、部分动作
   手动保存”；
3. `PUT /api/workgroups/:name` 是 config + members 的整文档替换，且
   `packages/backend/src/services/workgroups.ts` 每次保存会重建 member rows；当前表只有
   `updated_at`，没有内容版本 CAS；
4. 因此直接给现有 `startSave()` 套一个 debounce 仍会有两个硬问题：连续编辑期间只能拒绝第二次
   请求，且两个标签页从同一基线保存时可以后写覆盖先写；
5. 工作流编辑器已经建立了可信先例：1 秒防抖、single-flight + queued revision、版本 CAS、
   response-loss reconciliation、WebSocket 多标签同步，以及持续可见的
   “未保存 / 保存中 / 核对中 / 已保存 / 冲突 / 离线”状态。

工作组的保存是多表整文档事务，不能照搬一段前端计时器；本 RFC 要复用工作流的产品语义，并针对
成员整表替换与临时新增成员草稿补齐专用合同。

## 2. 目标

1. 工作组所有持久内容统一自动保存：名称、描述、说明、模式、协作开关、轮次/反问预算、完成门、
   fan-out、成员集合、成员别名/角色和负责人。
2. 普通文字与数值输入在停止编辑 1 秒后保存；添加/删除成员、切换负责人和模式等离散动作立即进入
   保存队列。
3. 删除页头“保存全部”和成员面板“保存全部”；用户只需编辑，页面持续显示真实保存状态。
4. 任意时刻最多一个 PUT 在途；在途期间继续编辑不会锁表单、不会丢改动，最新完整文档会排队保存。
5. 后端用内容版本 CAS 阻止标签页/用户间静默覆盖；响应丢失、断网恢复和自身 WS 回声不会制造
   假“已保存”。
6. 未完成的新增成员草稿或无效字段不会被发送；页面明确显示“修正/完成后自动保存”，恢复合法后
   自动续存。
7. 启动、删除、重命名/描述提交等依赖稳定内容的动作，均绑定一个已确认的精确保存版本。
8. 已启动任务继续读取启动时冻结的 `workgroup_config_json`；编辑资源只影响之后启动的任务。
9. 工作组编辑页与工作流编辑器共用同一页头信息层级：左侧显示可编辑标题、稳定 id 与当前内容
   version；右侧保持一个主启动动作，其余低频动作收进“更多”。

## 3. 非目标

- 不修改 leader_worker、free_collab、dynamic_workflow 的运行时、round、clarify、gate 或调度语义。
- 不把资源编辑实时同步进已运行任务，也不改变任务快照合同。
- 不做字段级协同合并；发生真实并发冲突时由用户选择另存副本、载入远端或显式覆盖。
- 不把 ACL 表单改成自动保存；ACL 继续使用独立 `aclRevision` 和显式提交，但 ACL 变化会唤醒内容
  编辑器重新校验访问权。
- 不把“新增成员”表单的半成品自动加入 roster；用户仍需点击“添加成员”确认一条完整成员记录。
- 不承诺刷新/浏览器崩溃后的离线草稿恢复。本轮继续用路由与 `beforeunload` guard 防误离开，不把
  内存草稿冒充为跨重启持久化。
- 不新增运行时依赖或另造一套表单控件。

## 4. 产品方案

### 4.1 自动保存节奏

- 文本、数值及连续表单编辑：最后一次有效编辑后 1 秒保存；
- 添加/删除成员、设为负责人、开关和模式切换：立即请求保存，但仍服从 single-flight；
- 在途时允许继续编辑；旧请求只结算它捕获的 revision，随后立即发送已排队的最新 revision；
- 纯语义 no-op 不 bump version、不重建 member id、不发送 WS frame。

### 4.2 持续可见的状态

工作组标题下方使用与工作流同族的状态区，而不是 2 秒后消失的“已保存”闪烁：

- `已保存`；
- `有未保存更改`（debounce 中）；
- `修正后自动保存` / `完成新增成员后自动保存`；
- `正在保存`；
- `正在核对保存结果`；
- `保存失败`；
- `与远端冲突`；
- `无法继续访问 / 远端已删除`；
- 独立传输状态：`在线 / 实时连接降级 / 离线`。

状态变化通过 polite live region 播报；字段错误仍贴近字段显示并可聚焦。离线文案只承诺“本页仍保留
修改、恢复网络后重试”，不声称已写入服务器。

### 4.3 冲突与恢复

真实冲突暂停自动保存并保留本地完整草稿：

1. **另存为副本（推荐）**：复用 QuickCreateDialog，以当前本地快照创建新工作组；
2. **载入远端**：二次确认后放弃本地草稿，采用最新服务端版本；
3. **覆盖远端**：danger 二次确认；确认时先 GET 最新 revision，再以该 revision 做一次 CAS。

覆盖不是 force write；若确认后远端再次变化，仍返回冲突。

### 4.4 表单与动作

- 页头和成员编辑面板不再渲染 Save 按钮；
- 新增成员保留“添加成员”，删除成员保留确认，确认后只修改本地 composite draft，保存由控制器
  自动完成；
- 名称/描述继续使用共享 RenameDialog，但确认后提交到同一个 composite draft，不再走独立且会与
  config PUT 竞争的前端写通道；
- 编辑器内部、保存回执与同步均以稳定 `workgroup.id` 识别资源；RFC-223 的 id URL 未完成前，
  兼容 name 路由在重命名提交后自动 `replace` 到当前名称，并保留 `by-id` 解析入口，避免打开同名
  替代资源；
- “启动”在导航任务向导前等待 `ensureSaved()`；删除只允许在 exact clean revision 上确认；
- dirty / saving / reconciling / conflict / invalid / transient draft 状态继续接
  `UnsavedChangesGuard`。
- 页头使用与工作流相同的 compact editor header：标题下为 `<workgroup id> · v<version>`；右侧
  只保留 primary “启动任务”与 secondary “更多”，重命名、权限和删除进入同族 action dialog。

## 5. 验收标准

- **AC-1**：配置与成员持久字段不再需要任何 Save 按钮；停止输入 1 秒后自动保存。
- **AC-2**：在途保存期间连续输入至少 3 个 revision，服务端最终只落最新完整文档，旧回执不能清掉
  新改动。
- **AC-3**：两个客户端从 v1 保存不同内容，数据库只允许一个提交到 v2；另一方进入可恢复冲突，
  不发生 last-write-wins 静默覆盖。
- **AC-4**：PUT 已提交但响应丢失时，GET/hash 对账能合成成功；重试相同内容不产生 v3、member id
  churn 或重复 WS frame。
- **AC-5**：无效 maxRounds、重复/空 member displayName、dynamic_workflow + human、未完成新增成员
  均不发请求，状态说明为什么暂停；修复后自动续存。
- **AC-6**：纯 config 保存不重建未变化的 member rows；成员变化后的回执仍保持本地 selection、
  focus 与 local key 连续性。
- **AC-7**：自身 WS 回声不抢先结算；clean 标签页跟随远端，dirty 标签页进入冲突；重连/聚焦会
  无条件 GET 对账。
- **AC-8**：保存状态永久可见且准确，在线状态与保存 phase 正交；中英文、ARIA live、键盘焦点和
  light/dark 均通过。
- **AC-9**：启动先等待最新 revision 保存；保存失败/离线/冲突时不导航；已运行任务快照不变化。
- **AC-10**：名称/描述与 config/member 共用一个 writer；仓库中不存在无 version fence 的工作组
  内容更新旁路。
- **AC-11**：390px、桌面 split page 和短视口中状态、错误、成员 rail 与表单均可达，无横向溢出。
- **AC-12**：migration/rolling-upgrade、shared/backend/frontend 定向测试、全量门禁及相关
  Playwright/visual/axe 全绿。
- **AC-13**：工作组与工作流编辑页头使用同一标题 / id / version 结构和响应式 action rail；
  工作组右侧恰有一个 primary Launch，重命名、权限、删除均从“更多”可达，390px 不丢动作。

## 6. 依赖、兼容与发布

- 依赖 RFC-199（工作流版本化自动保存先例）、RFC-201（工作组 composite edit scope）和
  RFC-217（当前 workgroup frontend/backend 模块边界）。
- 采用 RFC-223 已落地的 `workgroup.id` / `agentId` 内部接缝；其最终 id URL 切换未完成时保留
  name 路由兼容层，但 version/CAS、WS、query 对账与动作屏障都以稳定 id 为资源身份，不把 name
  重新当成并发 identity。
- 新增 `workgroups.version NOT NULL DEFAULT 1`；迁移号在实施时取当前 HEAD 的下一可用编号，不在
  RFC 文档硬编码并发中的号码。
- `PUT` 保存 wire 改为必填 `expectedVersion + clientMutationId + snapshot`。仓库内所有 writer
  同批迁移，不保留“服务端读最新再写”的无 fence 后门。
- 采用单 RFC / 单 PR 原子切换；回退时 production/schema/frontend 一起回退，已增加的 version 列
  可保留而不影响旧读路径。
