# RFC-231 实现门（2026-07-27）

结论：**APPROVED（0 open P0/P1/P2）**。

## 1. 审查范围

- 六类 ACL 资源的全部 production INSERT 与 actor 传播；
- user-private / builtin-public 初始 ACL 单一事实源及零 migration 边界；
- Workflow/Workgroup copy 的事务顺序、存在性隐藏、exact revision、引用权限、human active、
  自动命名、成员 id 重铸与 post-commit broadcast；
- 两类编辑器的 `ensureSaved → exact copy → navigate` 顺序、错误留页、旧救援 save-copy 保留；
- private created WS、跨用户可见性、overwrite/restore 不改 ACL；
- desktop light、390px dark、键盘、overflow、axe 与全量静态/测试/二进制门。

## 2. 结论

### 2.1 创建默认值

全仓枚举确认六张 ACL 表只有八个 production INSERT：六个 canonical user create writer 与两个
host Workflow writer。前六者显式展开 private/revision 0，Agent/Workflow builtin 分支及两个
host writer 显式展开 public/revision 0；Fusion repair 仍显式 public+builtin。SQLite 物理
`DEFAULT 'public'` 只保留为 legacy/raw-SQL fallback，没有 migration 或存量回填。

所有 HTTP 创建路径都由服务端 actor 决定 owner；Skill ZIP、Workflow YAML、
dynamic-workflow save 与两类救援 save-copy 均收敛到 canonical service。实现同时修复
`dwSaveAsWorkflow` 漏传 actor 的既有事务门旁路，并以“preflight 后引用由 public 收紧为
private”的 race test 锁住。

### 2.2 复制原子性与权限

两个 copy service 都在单个 `dbTxSync` 内依次完成 fresh source visibility、exact
version+snapshotHash、全部新引用权限、Workgroup human active、copier namespace 名称分配与目标
INSERT。不可见源在解析 definition/读取 roster 前即返回同形 404；任一后续门失败时目标及成员
均不落库。

目标只复制 editable snapshot：新资源 id、Workgroup member id、leader 映射、version 1、
copier owner、private、aclRevision 0、空 grants；owner/visibility/grants、Task/Run/chat/history
均不传播。copy chain、历史自由格式 Workflow slug、128 字符截断和 occupied-name 跳号均有纯
函数与服务测试。

### 2.3 前端与真实浏览器

Workflow 与 Workgroup 都先等待当前复合草稿的 exact save receipt，再只发送
`expectedVersion + expectedSnapshotHash`。成功写入 query cache 并导航到新编辑页，失败保持
原页与可重试错误；旧 conflict/inaccessible/deleted 救援命名表单未被替换。

实现审查期间发现一个 **P2 测试证据缺口**：应用内真浏览器已经跑通 Copy，但仓库既有 axe
场景只隐式覆盖新增按钮，未显式执行键盘 Copy 全链。现已在
`e2e/workflow-editor.spec.ts` 与 `e2e/rfc225-workgroup-autosave.spec.ts` 增加 Copy 可见性、
键盘 Enter、201 响应、private/version 1、内容与导航断言；两文件共 19 条真实 daemon 测试
全绿，axe critical/serious 为 0。该 finding 已关闭。

## 3. 验证证据

- Shared 全量：1,441 pass / 0 fail。
- Backend 完整随机化：7,446 pass / 25 env-gated skip / 0 fail；最终 touched 定向：
  22 pass / 0 fail。
- Frontend 全量：5,290 pass / 0 fail；copy 定向：51 pass / 0 fail。
- Playwright 真实 daemon：19 pass / 0 fail。
- typecheck、lint、format、depcheck、production/E2E binary build 与两个 version smoke 全绿。
- 应用内浏览器：desktop light Workflow 与 390px dark Workgroup 的脏草稿复制均成功；移动端
  dialog 宽 366px、viewport 390px、document 无水平溢出，初始焦点落在 Close。
- API/DB 回读：两类 copy owner 相同且为当前 actor，visibility private、version 1、
  aclRevision 0、grant users 0；Workgroup source/copy member id 不同。

## 4. 最终裁决

未发现开放的权限提升、非原子写入、ACL 默认旁路、存量迁移、响应式或可访问性问题。
**APPROVED，0 open P0/P1/P2。**

本裁决时只授权了本地实现与验证，因此当时未创建提交、未推送；随后用户已明确授权
“提交上库”，发布证据以 Git 历史与 exact-SHA CI 为准。
