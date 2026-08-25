# RFC-323 数字员工按员工绑定的 Adapter 配置卡 —— proposal

- 状态：**Approved / Implementation Complete / Publication Pending**
- 研究基线：`main@8ed77bbfb57ebc0e56e35eb8b8d1c3d434dbab0e`（2026-08-24）；实现候选已在
  `main@05756da64110c2f465c1ac001045cafe308362c4` 上重验证，最终发布 SHA 与 hosted CI 待填写
- 批准记录：2026-08-25，用户在确认“不同数字员工可配置不同 Adapter、Adapter 入口放在工具/职责语境”后，
  明确要求“完整实现 RFC 并提交上库”，即批准 C1～C12 与能力影响 I1～I5；同日进一步明确
  “Issue 来源都是标准协议”，因此 Issue provider 归一化留在 Integration/Event Center，不进入员工 Adapter binding
- 性质：产品信息架构调整 + 数字员工发布闭包调整 + Adapter 运行接线补齐 + 旧界面退役

## 1. 背景与问题

当前产品把 Adapter 当成了一个既隐藏、又放错所有权位置的技术资源：

1. `TypeToolRegistration.connectionRef` 把外部系统固定在**分类工具注册**上
   （`packages/backend/src/modules/digital-employee/domain/model.ts:905-929`）。同一个工具一旦绑定
   Jenkins，员工 A 与员工 B 若想使用不同系统，就只能复制两份工具注册；这与“不同数字员工可以配置
   不同 Adapter”的业务要求冲突。
2. 岗位模板与具体员工只冻结工具引用，不冻结独立 Adapter 绑定：
   `WorkItemToolBinding` 只有 `workItemRef + slotRef + registrationRef`
   （`packages/backend/src/modules/digital-employee/domain/model.ts:63-69`）；岗位模板与员工发布闭包也只有
   `defaultToolBindings / toolOverrides / exactToolBindings`
   （同文件 `:961-1012`）。
3. 工具编辑弹窗直接显示“使用哪个已注册系统”并把连接写进工具注册
   （`packages/frontend/src/routes/digital-employees.$typeRef.tsx:1799-1823`），因此表面上像在配置当前员工，
   实际修改的是全分类共享工具。
4. Adapter 的独立入口仍藏在 `/code/executors` 与 `/code/config/adapters[/<id>]`。
   `/code` 已重定向到 `/digital-employees`，主导航也没有这些入口，但路由、列表、详情、原始 JSON 编辑、
   视觉基线与测试仍完整存在（`packages/frontend/src/routes/code.executors.tsx:20-139`、
   `packages/frontend/src/routes/code.config.tsx:80-83`）。这正是用户发现的“隐藏界面还在”。
5. 运行接线也不完整：Adapter runner 的注释明确写着 `secret projection（PR-3 恒空）`，实际
   `AdapterRunInput.adapterContent` 只接收 `executableRef + timeoutMs`，没有消费已发布内容里的
   `connectionRef / secretProjection`
   （`packages/backend/src/modules/integration/infrastructure/developmentAdapterRunner.ts:1-10,210-259`）。
   只搬 UI 会继续产生“配置看起来成功，企业接口仍拿不到连接/凭据”的假象。

本 RFC 不再把 Adapter 放进全局工具定义，也不把它做成一个会执行的泳道节点。终态是：

> Adapter 资源仍由 Integration 拥有并可复用；数字员工在职责泳道最前方通过一张配置卡选择它。
> 岗位模板提供默认值，具体员工可以覆盖。员工发布时冻结精确 Adapter revision，运行时后续节点统一消费。

## 2. 产品裁决

### 2.1 泳道首位是一张配置卡，不是运行节点

声明外部系统依赖的泳道在最前方显示一张“企业系统连接”卡片：

```text
流水线门禁：   [企业流水线连接]  [取得门禁] → [识别失败] → [按类型修绿]
外部审批门禁： [企业审批连接]    [编写草稿] → [提交审批] → [等待审批]
```

配置卡只投影发布闭包中的 Adapter binding：

- 不新增 `WorkItemDefinition`；
- 不进入 ReactionRule、执行顺序、round、timeline 或重试计数；
- 不伪造成功/失败运行状态；
- 后续节点按泳道声明的 slot 读取同一个精确 Adapter revision。

### 2.2 归属和覆盖顺序

Adapter 绑定不是工具实现的一部分。其覆盖顺序固定为：

```text
具体员工 adapterOverrides
        ↓（无覆盖才继承）
岗位模板 defaultAdapterBindings
        ↓（仍无绑定）
启用了该泳道且 slot 必填 ⇒ 发布失败
```

因此同一个岗位模板、同一个分类工具可以得到：

- 员工 A：`collect-pipeline` + Jenkins Adapter v3；
- 员工 B：同一个 `collect-pipeline` + GitLab CI Adapter v7；
- 员工 C：继承岗位模板默认 Adapter。

工具不复制，Adapter exact revision 仍进入每名员工自己的 immutable revision。

### 2.3 最小化弹窗

点击配置卡打开公共 `Dialog`。交互与工具卡保持同一所有权层次：分类工具箱只管理当前泳道 purpose 下可复用的
Adapter 资源，不选择员工、岗位，也不写 binding；岗位模板和员工职责配置已经天然确定当前对象，点击后直接打开
下述绑定弹窗。绑定弹窗默认视图只显示：

1. 当前来源：`继承岗位模板` 或 `员工覆盖`；
2. 企业系统连接选择器（只列 purpose 匹配、可见、已发布、未归档的 Adapter）；
3. 状态：名称、用途、精确版本、可用/缺失；
4. 动作：保存覆盖、恢复继承、取消。

具备 `adapter-definitions:create/update` 且同时具备 `scripts:author` 的用户，才看到次要动作
“新建/管理连接”。次级表单默认只显示**名称、可执行文件 / 脚本路径**；该字段是 daemon 主机可直接执行的
文件引用，不是代码编辑器，也不接受带参数的 Shell 命令。purpose、必需 operations、contract version、
预算与超时按泳道用途自动给出。`connectionRef`、secret key 名册、预算、超时放进折叠的“高级设置”，
永不显示 secret value。装有输入的 Dialog 必须 `closeOnOverlayClick={false}`。

### 2.4 运行闭环

- 流水线泳道：平台用冻结的 `pipeline-gate` Adapter 执行短调用/有界 evidence 导入；凭据不进入
  Agent、Workflow、Program、prompt、任务端口或日志。Adapter 产出的事实绑定 exact MR head。
- Issue 入口：GitHub/GitLab 等 provider 差异由 Integration 归一化为标准 `code-host.issue.*` 事件，Event Center
  将标准 Issue 字段渲染为 WorkStart 输入；`delivery-main` 不声明来源 Adapter，也不把 provider ref 投给员工。
- 审批泳道：编写草稿工具只接收 secret-free Adapter ref；平台 `submit / lookup-by-idempotency-key /
observe` 继续使用同一冻结 revision 与既有 saga。
- `connectionRef` 作为非秘密标识通过 `AW_ADAPTER_CONNECTION_REF` 投给 Adapter；
  `secretProjection` 只允许投影声明的 daemon 环境变量。缺失任一声明项时在 spawn 前返回 typed
  configuration failure，不以空字符串运行。

## 3. 用户旅程

### 3.1 岗位模板设置默认系统

1. 用户编辑“Java 服务研发”岗位模板。
2. 在“流水线门禁”泳道最左侧点击“企业流水线连接”。
3. 弹窗选择已发布 Jenkins Adapter；卡片显示“Jenkins · v3”。
4. 发布岗位模板时，服务端重新验证 purpose、可见性、availability 与 exact revision。

### 3.2 具体员工覆盖默认系统

1. 员工 A 使用“Java 服务研发”，默认显示“继承 Jenkins · v3”。
2. 用户在员工职责配置中点击同一张卡，选择 GitLab CI Adapter v7。
3. 员工 A 发布 revision 冻结 v7；使用同一岗位模板的员工 B 仍继承 v3。
4. 后续 Adapter 发布 v8 不会静默替换 A/B；用户必须显式更新绑定并发布新员工 revision。

### 3.3 就地创建 Adapter

1. `scripts:author` 在卡片弹窗内点击“新建连接”。
2. 只填写名称和 daemon 主机可访问的可执行文件 / 脚本路径；purpose/operations/default budget 自动由当前泳道生成。
3. 如需环境凭据，展开高级设置只填写允许投影的 key 名；值由 daemon 部署环境持有。
4. 创建并发布成功后自动选中 exact revision；失败时留在弹窗内并显示 typed 原因，不跳转隐藏页面。

### 3.4 旧链接

- `/code/executors`
- `/code/config/adapters`
- `/code/config/adapters/<id>`

不再渲染旧界面，统一重定向 `/digital-employees`。后端 Adapter API 保持，因为新弹窗仍通过
Integration bounded context 的公开命令管理资源。

### 3.5 从分类工具箱管理连接资源

1. 用户在分类工具箱点击泳道首位 Adapter 卡。
2. 弹窗像工具卡一样列出当前 purpose 的 Adapter 资源，可新建、编辑、发布、归档或管理 ACL。
3. 弹窗不出现“具体员工 / 岗位默认”，也不跳转或写入任何员工、岗位。
4. 用户进入岗位模板或员工职责配置后，当前对象已确定，点击同一张卡直接设置 `defaultAdapterBindings` 或
   `adapterOverrides`。

## 4. 范围

### 4.1 本 RFC 包含

- Type Package 对“某泳道需要何种 Adapter slot”的声明；
- 岗位模板默认绑定、员工覆盖、员工发布闭包的 exact 绑定；
- 泳道首位配置卡及最小化 Dialog；
- Adapter 就地创建、编辑、发布、归档与 ACL 的次级入口；
- 新工具注册不再保存 Adapter；历史工具 connectionRef 只做兼容读取；
- `pipeline-gate` 与 `approval-gateway` 的员工冻结绑定及运行消费；
- 标准 Issue 事件经 Integration/Event Center 直接进入 WorkStart，不创建员工来源 Adapter；
- Adapter `connectionRef / secretProjection` 真正进入受控子进程环境；
- 旧前端页面、路由 UI、CSS/i18n、功能/视觉测试与能力账本退役；
- 旧 URL 的无界面重定向；
- 历史 revision 与在途 Case 的兼容投影。

### 4.2 非目标

- 不新增通用 SaaS Connector 市场或供应商模板商店；
- 不把 token/密码明文存入 Adapter JSON 或员工 revision；
- 不新增平台自动 merge/approve 决策；
- 不改变代码平台 MR REST 使用既有全局 code-host connection 的边界；
- 不一次性删除 Integration 的 Adapter API、表或 immutable revision；
- 不在本 RFC 中删除旧 Development Mission 的 `requirement-source` 兼容协议；它不再投影为数字员工泳道卡；
- 不把配置卡伪装为可调度 WorkItem；
- 不把全部数字员工资源编辑器重做成新导航。

## 5. 能力影响清单（breaking-change 逐项确认）

| 编号 | 既有能力变化                                                                                      | 受影响部署/用户                                       | 保留或迁移方式                                                                             |
| ---- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| I1   | 删除 `/code/executors` 全局执行器库界面                                                           | 仍使用直链查看 AI/Program/员工/外部系统四组清单的用户 | 资源继续在数字员工分类工具箱、员工页及公开 API 中管理；旧 URL 重定向                       |
| I2   | 删除 `/code/config/adapters[/<id>]` 独立列表/详情与原始 JSON 编辑器                               | scripts author、保存旧书签的管理员                    | Adapter 全生命周期移入泳道卡片的次级 Dialog；所有受支持字段保留 guided 编辑，旧 URL 重定向 |
| I3   | 新工具注册不再接受/保存 `connectionRef`                                                           | 依赖“复制工具来换 Adapter”的配置                      | 迁移为岗位默认 + 员工覆盖；历史工具 revision 不改写、仍可回放                              |
| I4   | `collect-pipeline` 的企业事实取得改由平台 Adapter 执行，不再允许自定义工具直接持有连接/凭据去采集 | 使用自定义 Program/Workflow 采集流水线的部署          | 自定义 provider 程序迁为 typed `pipeline-gate` Adapter；分类/修复工具仍可定制              |
| I5   | Adapter 声明了 secret key 但 daemon 缺值时由“可能运行后自行失败”改为 spawn 前 fail closed         | 依赖隐式环境、声明与部署不一致的 Adapter              | 启动前给出缺失 key 的 typed remediation；不再把空值交给程序                                |

本 RFC **不**删除历史 Adapter 资源、API、表、exact revision，也不改变在途 Case 已冻结 revision 的语义。

## 6. 已批准的产品/技术裁决

- **C1** Adapter 卡固定显示在声明 slot 的泳道首位，但不是 WorkItem。
- **C2** 岗位模板提供默认值，具体员工可覆盖；员工覆盖优先，缺省继承。
- **C3** Adapter 不再属于 TypeToolRegistration；同一工具可以由不同员工搭配不同 Adapter。
- **C4** 分类工具箱的 Adapter 卡与工具卡一致，只管理 purpose-scoped 资源，不选择或绑定员工/岗位；岗位模板与员工
  职责图利用当前上下文直接打开绑定弹窗，绑定面只显示继承/覆盖、连接选择和状态，技术字段进入权限受控的二级表单。
- **C5** 就地弹窗承接 Adapter 创建、编辑、发布、归档与 ACL；不另造隐藏管理页。
- **C6** 员工发布时冻结 exact Adapter revision、content digest 与来源；运行时不自动追最新。
- **C7** Issue provider 差异止于 Integration/Event Center，标准 Issue 直接进入 WorkStart，数字员工不配置
  `requirement-source`；流水线采集由平台调用 `pipeline-gate` Adapter，审批 submit/lookup/observe 由平台调用
  `approval-gateway` Adapter。
- **C8** `connectionRef` 只作为非秘密标识进入 `AW_ADAPTER_CONNECTION_REF`；secretProjection 只从 daemon
  环境复制点名 key，缺失 fail closed，不新增数据库 secret store。
- **C9** 新工具写路径删除 connectionRef；历史 revision 使用只读兼容投影，不篡改 immutable JSON/digest。
- **C10** 旧三个 URL 只留 redirect，不再保留任何旧 UI 或 Adapter 专属分支。
- **C11** Integration Adapter API/ACL/immutable revision 继续保留并由新弹窗调用。
- **C12** 能力影响 I1～I5 全部接受，不做双 UI、双绑定或长期 fallback。

## 7. 验收标准

- **AC-1** manifest 能声明 lane Adapter slot；未知 lane、重复 slot、非法 purpose 在类型包发布时拒绝。
- **AC-2** 岗位模板可保存默认 Adapter；员工可继承或覆盖，同一岗位的两个员工能冻结不同 exact refs。
- **AC-3** 任一启用的必需 Adapter 泳道缺绑定、purpose 不匹配、资源不可见/归档/未发布时，员工发布 fail closed。
- **AC-4** 员工 revision 的 closure digest 包含 Adapter ref + content digest；Adapter 新 revision 不改变旧员工运行。
- **AC-5** Adapter 卡始终位于泳道业务节点之前，但不出现在 WorkItem/Reaction/round/timeline 计数中。
- **AC-6** 默认弹窗只呈现最小字段；权限不足者看不到 executable/secret/ACL 动作，也不能通过 API 绕过。
- **AC-7** pipeline collect 使用员工冻结的 `pipeline-gate` Adapter，结果绑定当前 head；大 evidence 仍走有界 sink。
- **AC-8** approval draft、submit、lookup、observe 使用同一个员工冻结 Adapter；幂等与 correlation 校验保持。
- **AC-9** 运行子进程只收到基础环境、操作输入、`AW_ADAPTER_CONNECTION_REF` 与声明 secret keys；未声明 daemon
  环境不泄漏，缺失声明 key 在 spawn 前失败。
- **AC-10** 新工具注册请求携 connectionRef 被拒；历史工具/员工/in-flight Case 可按冻结 revision 继续运行。
- **AC-11** `/code/executors` 与两个 Adapter 配置 URL 不再渲染旧 DOM，全部重定向 `/digital-employees`；旧 UI 文件、
  CSS、i18n、测试与视觉场景不得复活。
- **AC-12** Adapter API、ACL、版本发布、归档能力通过泳道 Dialog 可达；不要求用户输入 resource ID/revision/raw JSON。
- **AC-13** Chromium/WebKit 覆盖分类工具箱点击打开资源管理且不出现员工/岗位选择，以及岗位默认、员工覆盖、恢复
  继承、就地创建与旧 URL 重定向；1280×900 与窄屏均无溢出。
- **AC-14** 架构守卫证明 Digital Employee 只依赖 Integration 的公开 connection catalog / execution participant，
  不读取 Adapter 表、secret 或 executable。
- **AC-15** `delivery-main` 不声明 `requirement-source` slot；GitHub/GitLab Issue 通过标准
  `code-host.issue.*` envelope 与 Event Center WorkStart 路径进入员工，系统级回归不得创建来源 Adapter。
