# RFC-231 资源默认私有与工作流/工作组一键复制 — proposal

状态：Implemented（2026-07-27；用户已批准实施；设计门与实现门均 APPROVED / 0 open
P0-P2；实现与验证完成）。

## 1. 问题

工作流与工作组编辑器目前都有“另存副本”，但它只在自动保存进入 conflict / inaccessible /
deleted 救援态时出现，而且会打开命名表单。正常编辑状态下，“更多操作”里没有复制，用户为了
复用一个成熟配置，只能手工导出/新建，或刻意走不适合的救援流程。

另一方面，RFC-099 D18 把 Agent、Skill、MCP、Plugin、Workflow 的新建默认值定为
`public`，RFC-164 又沿用到 Workgroup。当前六类资源的生产创建服务也都显式写
`visibility='public'`。这与新的产品原则相反：新资源在创建者主动分享之前，应只属于创建者。

本 RFC 同时处理两个直接相关的创建语义：

1. Workflow / Workgroup 提供真正的一键复制；
2. 所有六类 ACL 用户资源从此默认 `private`，复制也遵守同一默认值。

## 2. 已确认的产品决策

用户于 2026-07-27 明确确认：

- 复制出来的 Workflow，owner **必须是执行复制的人**，不能继承源 owner；
- 同一规则也适用于 Workgroup；
- 从此以后，Agent、Skill、MCP、Plugin、Workflow、Workgroup 的所有用户新建路径都默认
  `private`；
- 已存在资源不回填、不改 visibility；
- 框架内置资源是明确例外，继续保持系统可用的 `public`；
- 用户资源创建后仍可通过现有 ACL 面板主动改为 `public` 或添加授权用户。

## 3. 目标

- Workflow 与 Workgroup 编辑页的“更多操作”增加“复制”。
- 正常态复制无需命名弹窗：一次点击后保存当前编辑内容、创建副本并跳转到副本编辑页。
- 副本使用服务端生成的新 id、`version=1`、当前复制者 owner、`visibility='private'`、
  `aclRevision=0`，且没有任何 grant。
- Workflow 副本复制可编辑元数据与 definition；Workgroup 副本复制配置、成员编排与负责人关系，
  并为成员重新生成数据库 row id。
- 不复制源资源的 owner、visibility、ACL grants、创建/更新时间、版本历史、Task/Run、聊天室消息
  或运行快照。
- 所有受支持的六类资源创建入口统一使用“用户新建默认 private”合同；导入、动态生成和救援态
  “另存副本”不能成为旁路。
- 框架内置 Agent/Workflow 与两个运行宿主 Workflow 显式保持 public，不依赖数据库隐式默认。
- 复制必须复核源精确版本、当前可见性以及目标资源所需的直接引用权限，不能把可见源资源变成
  隐藏 Agent/Skill/MCP/Plugin 的权限升级通道。

## 4. 用户体验

### 4.1 正常复制

Workflow 编辑器的操作顺序为：

1. 导出 YAML；
2. 复制；
3. 重命名；
4. 访问权限；
5. 删除。

Workgroup 编辑器的操作顺序为：

1. 复制；
2. 重命名；
3. 访问权限；
4. 删除。

用户点击“复制”后：

- 编辑器先复用现有 `ensureSaved()`，确保当前可见草稿已经成为一个精确持久版本；
- 操作项显示“正在复制”，同一时间不能重复提交；
- 服务端按该精确版本创建副本；
- 成功后直接跳转到新资源编辑页；
- 失败时留在原资源，操作对话框内显示可重试错误，不创建半成品。

这是一键动作，不再先问名称。用户需要不同名称时，可在跳转后的新编辑页使用现有“重命名”。

### 4.2 自动名称

服务端在复制者自己的同类资源命名空间内生成名称：

- 第一个副本：`<base>-copy`；
- 后续副本：`<base>-copy-2`、`<base>-copy-3`……；
- 若源名称本身已是上述 copy 形态，则继续递增，而不是生成 `foo-copy-copy`；
- 历史 Workflow 可能带空格、中文或其它已被 grandfather 的自由格式名称；服务端先把它规范为
  小写 ASCII slug（不合法字符段变 `-`、两端分隔符移除，全空时回退 `workflow`），再生成
  copy 后缀，不能因为旧名称不满足当前 create schema 而让复制失效；
- 预留后缀后截断 base，最终名称始终符合现有小写 slug 规则且不超过 128 字符；
- 名称选择与插入在同一数据库事务内，快速连点或并发请求不能得到同名 Workgroup；Workflow
  虽允许业务上重名，也按相同规则为自动副本选择未占用名称。

名称只检查复制者自己的同类资源，不泄露源 owner 或其他用户的私有命名空间。

### 4.3 救援态“另存副本”保持

现有 conflict / inaccessible / deleted 状态下的“另存副本”保存的是无法再写回源资源的本地
草稿，仍需让用户确认名称与描述，因此继续保留现有表单。它与正常态“复制”不是同一动作：

- 正常复制：精确复制当前已保存源版本，服务端自动命名，一键完成；
- 另存副本：保存冻结的本地未提交草稿，用户可改名后创建。

两条路径的 ACL 语义完全相同：owner 是当前操作者、private、无 grants。

## 5. 默认私有的范围

| 资源      | 纳入的新建路径                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent     | 普通创建，以及所有复用 canonical Agent create service 的用户生成路径                                                                                                   |
| Skill     | 普通创建、ZIP import 的 create/rename-as-new 分支，以及所有复用 canonical Skill create service 的用户生成路径                                                          |
| MCP       | 普通创建                                                                                                                                                               |
| Plugin    | 安装/创建新 Plugin                                                                                                                                                     |
| Workflow  | 普通创建、YAML `mode=new/fail` 的创建分支、动态工作组“保存为 Workflow”、救援态另存副本、本 RFC 正常复制，以及所有复用 canonical Workflow create service 的用户生成路径 |
| Workgroup | 普通创建、救援态另存副本、本 RFC 正常复制                                                                                                                              |

以下不是“新建用户资源”，不改写 ACL：

- 覆盖导入、编辑、重命名、owner transfer；
- backup/restore（灾备必须原样恢复归属与 visibility）；
- 现有数据库行；
- Task（已是成员制私有且没有 visibility 开关）；
- Schedule、Memory、Fusion job、Runtime 等没有六类 ACL visibility 合同的对象。

框架内置 Skill Fusion Agent/Workflow、Agent host Workflow、Workgroup host Workflow 保持
`public + builtin`。它们不是用户创建内容，也不在用户列表中作为普通资源出现。

## 6. 权限合同

- 任意当前可查看源 Workflow/Workgroup 的用户都可以复制；不要求是源 owner。
- 副本 owner 始终是发起请求的 actor，包括 manager/admin 复制他人资源的情况。
- 源 ACL grants 永不复制；源 owner 也不会自动获得副本访问权。
- 源资源在复制事务开始前已删除或对 actor 不可见：返回与详情接口同形的 404。
- 源在保存后又变化：返回 409 stale，用户重试后重新 `ensureSaved()`。
- Workflow 的所有 Agent 引用、Workgroup 的所有 Agent 成员都按“新资源引用”复核 actor 当前
  使用权；不可用时整次复制失败。
- Workgroup 的 human 成员必须仍是 active；不合法时整次复制失败。
- 客户端请求不能指定目标 id、name、owner、visibility、grants 或副本内容。

## 7. 非目标

- 不为 Agent、Skill、MCP、Plugin 增加复制 UI/API。
- 不增加批量复制、跨实例复制、复制后立即分享或“继承权限”开关。
- 不复制任务、运行记录、版本历史、工作组聊天室或动态执行状态。
- 不改变现有资源的 visibility，也不自动把它们收紧为 private。
- 不把 ACL 设置塞进快速创建表单；创建后继续使用现有 ACL 面板管理。
- 不允许复制隐藏的框架内置 Workflow 作为用户模板。

## 8. 验收标准

- **AC-1**：Workflow/Workgroup 编辑页“更多操作”均出现可键盘操作的“复制”。
- **AC-2**：一次点击会先保存当前有效草稿，再复制该精确 version+snapshotHash 并跳转到新
  编辑页；不出现命名表单。
- **AC-3**：副本 id 新、version=1、owner=复制者、visibility=private、aclRevision=0、grant
  数量为 0。
- **AC-4**：源 owner、public/private 与 grant 列表均不传播；源 owner 在没有其它权限时看不到
  别人复制出的副本。
- **AC-5**：Workflow definition/描述完整复制；Workgroup 配置、顺序、负责人关系与成员完整
  复制，但成员数据库 id 全部重建。
- **AC-6**：名称按 `-copy` / `-copy-N` 递增，grandfathered 自由格式 Workflow 名可稳定
  slugify，128 字符边界合法；同一 owner 下并发 Workgroup 复制不冲突。
- **AC-7**：不可见/删除源返回 404，版本漂移返回 409，隐藏/失效引用与 inactive human 成员
  fail closed，且失败不留下目标行或成员半成品。
- **AC-8**：六类普通 HTTP 创建返回 owner=actor、visibility=private；另一普通用户的列表和
  详情立即看不到它。
- **AC-9**：Workflow YAML 新建、Skill ZIP 新建、动态工作组保存 Workflow、两类救援态另存
  副本等派生路径同样 private；overwrite 保留目标 ACL。
- **AC-10**：框架内置 Agent/Workflow 与两个 host Workflow 仍明确为 public+builtin，并保持
  原有运行能力。
- **AC-11**：新建 private Workflow/Workgroup 的 WS created frame 只送达 owner、grantee 或
  resource admin，不向陌生用户泄露 id/name。
- **AC-12**：现有资源升级前后 visibility 逐行不变；本 RFC 不做 backfill。
- **AC-13**：桌面明亮主题和 390px 暗色真浏览器完成两类复制流程，无水平溢出、焦点丢失或
  critical/serious axe 问题。
- **AC-14**：shared/backend/frontend 定向测试、相关全量测试、typecheck、lint、format、
  depcheck 与 binary smoke 通过；实现门无开放 P0/P1/P2。

## 9. 兼容性

这是有意的产品默认值变更：依赖“新建后自动对所有用户可见”的调用方必须在创建成功后显式更新
ACL 为 public。Create 请求 schema 仍不接收 visibility，避免客户端绕过默认值；读取旧 fixture
时“visibility 缺失视为 public”的兼容语义保留。

RFC-231 supersede RFC-099 D18 的“资源新建默认 public”以及 D20 中“其它资源默认 public”的
部分；D20 的“Task 恒为成员制私有”继续有效。
