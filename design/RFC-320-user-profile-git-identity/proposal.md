# RFC-320 — 用户档案驱动的 Git 提交身份与 OIDC 邮箱刷新

- 状态：Done（2026-08-24；实现、发布与 RFC-320 相关 hosted 验证已完成）
- 发起：用户，2026-08-24
- 追加裁决：2026-08-24，OIDC Provider 配置界面必须同时允许指定 userinfo 的用户名字段与邮箱字段
- 前置：RFC-036（OIDC）、RFC-067（任务级 Git identity）、RFC-220（userinfo 与呈现名刷新）、RFC-294（context ownership）

## 0. 终态一句话

**用户档案是 Git 提交身份的唯一来源，任务行是启动时不可变快照。**

```text
Git user.name  = users.display_name
Git user.email = users.email

用户档案 --任务实际创建时冻结--> tasks.git_user_name / tasks.git_user_email
任务快照 --执行期注入--> GIT_AUTHOR_* / GIT_COMMITTER_*
```

任务创建请求不再接收 `gitUserName` / `gitUserEmail`，任务向导也不再让用户逐任务填写。
OIDC Provider 配置界面同时提供“用户名字段”(`usernameClaim`)与“邮箱字段”(`emailClaim`)，
两者都允许填写 userinfo 的自定义 claim 名；每次 OIDC 登录都刷新身份快照，并按本文规则同步
`users.displayName` / `users.email`。Git push 的远端认证仍使用仓库现有 SSH key / HTTPS credential，
不把提交身份误当成 push 凭据。

> 术语消歧：Git 的 `user.name` 是提交显示名，不是平台登录 handle。本文取
> `users.display_name`，因为它允许自然人姓名，且现有 OIDC `usernameClaim` 的真实语义就是
> “呈现名字段”；`users.username` 继续作为受正则与唯一约束的登录标识。

## 1. 现状与问题

### 1.1 任务身份由调用方输入，归属模型错误

- `StartTaskSchema` 公开可选的 `gitUserName` / `gitUserEmail`。
- `tasks.new.tsx`、任务草稿、重启/定时任务构造器都保存并回放这两个字段。
- `services/task.ts` 把请求值直接冻结到 `tasks.git_user_name` / `tasks.git_user_email`。
- `commitPushRunner.ts` 已能把任务行中的值注入 author / committer；执行能力不是缺口，
  缺口是“谁有权决定值”。

这使任务可以伪造任意提交身份，也让同一用户每次启动都要重复填写。

### 1.2 OIDC 邮箱有两处真实断点

- `auth/oidc/identity.ts` 只硬编码读取标准 `email`；Provider 无法声明 `mail`、
  `user_email` 等实际字段。
- `services/userIdentities.ts#syncPreferredSnapshot` 对已有身份登录只同步
  `email_verified` 与呈现名快照，从不回写 `users.email`。

因此 IdP 即使在 userinfo 返回了邮箱，已有 OIDC 用户的账号邮箱仍可能一直是 `NULL`。
当前 `/account` 也没有普通用户可编辑邮箱/呈现名的入口，用户无法自行补洞。

### 1.3 已有能力可以复用

- `usernameClaim` 已支持从身份响应选择一个或多个字段并组合呈现名。
- `preferred_snapshot` 已提供“IdP 值不变时保留站内修改、IdP 值变化时跟随刷新”的快照机制。
- OIDC callback 已在每次现有身份登录时调用同步函数。
- 任务表已有两列快照，Git runner 已按任务快照注入环境变量。

本 RFC 扩展这些单点，不再建立第二套 Git 邮箱或第二套提交身份所有权。

## 2. 目标

1. 删除所有公开任务启动契约、向导、草稿和 launch builder 中由用户输入的
   `gitUserName` / `gitUserEmail`。
2. 由 `identity-access` 在任务实际创建时解析创建者档案，并把
   `displayName + email` 冻结到既有任务列。
3. 在 OIDC Provider 配置界面并列提供两个可编辑选择器：`usernameClaim` 指定 userinfo 的用户名/
   呈现名字段，`emailClaim` 指定邮箱字段；前者复用既有存储语义，后者为新增合同。
4. 每次 OIDC 登录刷新身份侧邮箱快照，并安全同步 `users.email`；存量空邮箱用户在下一次
   成功登录后即可补齐。
5. 在 `/account` 提供呈现名与邮箱的自助编辑入口；任务页只读展示将使用的提交身份。
6. 覆盖直接启动、PAT、定时任务、事件规则、重启/重跑、父子任务等所有任务创建入口，
   不允许某个入口继续接受客户端提交身份。
7. 继续让运行中/已创建任务使用自己的冻结快照；后续用户档案变化不改写历史任务。

## 3. 非目标

- 不新增 `users.git_user_email`；Git 邮箱就是 `users.email`。
- 不新增独立 `users.git_user_name`；Git 显示名就是 `users.display_name`。
- 不修改 `users.username` 的登录 handle、唯一性或 OIDC 自动建号算法。
- 不引入每用户 PAT、OAuth token、SSH key 或 credential helper；push 认证身份保持现状。
- 不改变内部快照/合并对象的 `AW_INTERNAL_GIT_IDENTITY`。
- 不扩展数字员工候选交付等非 task launch 的内部 source-control 流程；它们继续用自身合同。
- 不做 commit signing、Verified 标记或代码托管平台账号绑定。
- 不回写历史 commit，也不批量改写已存在任务的 Git identity 快照。

## 4. 用户可感知行为

1. 新建任务的“Git 用户名 / Git 邮箱”输入消失，确认页改为只读显示当前账号提交身份。
2. `users.email = NULL` 的用户不能创建需要用户提交身份的新任务；页面给出账号设置链接，
   API 返回稳定错误 `git-identity-email-missing`。
3. 普通用户可在账号页维护呈现名和邮箱；邮箱仍受格式与全局唯一约束。
4. Settings → Authentication 的 Provider 表单明确显示“用户名字段（Git user.name）”和
   “邮箱字段（Git user.email）”；两项都可填写自定义 userinfo claim，留空分别使用标准
   `preferred_username` / `email`。
5. 配置 `emailClaim` 的 OIDC Provider 每次登录都调用 userinfo；字段缺失、不是字符串、
   不是合法邮箱时登录失败并显示 `oidc-email-claim-invalid`，不会保留一个看似成功但仍为空的账号。
6. 配置 `usernameClaim` 的标准 OIDC Provider 也改为从 userinfo 取呈现名；这会新增一次
   userinfo 请求。无法提供 userinfo 的 Provider 必须清空选择器或补端点。
7. 未配置 `emailClaim` 时仍读取标准 `email`；标准字段缺失不会让原本可登录的 Provider
   突然失败，但账号邮箱为空时任务启动会被拒并引导手工补齐。
8. OIDC 返回的新邮箱与其他账号冲突时，本次登录以 `oidc-email-conflict` 失败，绝不静默
   留旧值或把同一邮箱挂到两个用户。
9. 用户登录后改了档案，新任务使用新值；已经创建/正在运行的任务继续使用原快照。
10. 远端 Git 平台看到的 commit author/committer 是任务创建者；“谁执行了 push”仍由当前
    仓库 SSH key / HTTPS token 决定，两者可能不是同一个平台账号。

## 5. 待用户确认的裁决

批准本 RFC 即同时确认下列能力影响：

| 编号 | 裁决                                                                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | Git `user.name` 使用 `users.display_name`，不是受限的登录 handle `users.username`。                                                                                                                                                                                               |
| C2   | Git `user.email` 与账号 `users.email` 完全同源，不再新增 Git 专属邮箱字段。                                                                                                                                                                                                       |
| C3   | **用户已明确追加**：OIDC Provider 配置界面必须并列提供“用户名字段”(`usernameClaim`)与“邮箱字段”(`emailClaim`)，都可填写自定义 userinfo claim；一旦配置，字段来源固定为 userinfo。标准 OIDC callback 因而会额外访问 userinfo，并校验其标准 `sub` 与已验签 id_token 的 `sub` 一致。 |
| C4   | 配置的 `emailClaim` 是严格合同：缺失/非法即拒绝本次登录，不静默回退标准 `email`，避免掩盖配置错误。                                                                                                                                                                               |
| C5   | OIDC 同步沿用三方快照语义：站内修改在 IdP 值未变化时保留；IdP 值后来变化时，以 IdP 新值刷新。唯一例外是“账号邮箱为空”：下一次拿到合法邮箱时立即补齐。                                                                                                                             |
| C6   | 新任务必须有完整的显示名与邮箱；邮箱为空时拒绝创建，不退回后台统一身份。                                                                                                                                                                                                          |
| C7   | 旧客户端继续发送任务级 `gitUserName` / `gitUserEmail` 时明确返回 `task-git-identity-client-owned`，不静默忽略。存量持久化的定时/重启 payload 在 migration 中移除这两个键。                                                                                                        |
| C8   | push 认证不在本 RFC 范围；本次只改变 commit author/committer 和任务快照来源。                                                                                                                                                                                                     |

## 6. 关键用户故事

### US-1：OIDC 存量用户补齐邮箱

管理员在 Provider 把 `emailClaim` 配成 `mail`。邮箱为空的存量用户下一次登录时，平台
从 userinfo 读取 `mail`，校验邮箱，原子更新 identity snapshot 与 `users.email`。用户随后
创建任务，确认页显示 `张三 <zhangsan@example.com>`，提交使用这对身份。

### US-2：用户站内维护

本地账号用户在 `/account` 修改呈现名和邮箱。任务向导不允许再逐任务覆盖，只读显示账号值；
创建后把该值冻结。用户后来再次改名，旧任务和旧 commit 不变，新任务使用新值。

### US-3：IdP 邮箱变化

OIDC 用户在 IdP 把邮箱从 A 改为 B。下次登录时 identity 旧快照为 A、新值为 B，平台在同一
事务更新 snapshot 与 `users.email=B`。若 B 已被另一账号占用，事务回滚并显示冲突错误。

### US-4：自动创建任务

用户创建定时任务或事件规则。真正触发并创建 task 时，平台按该 owner 当前档案解析提交身份；
父任务派生子任务时继承父任务已经冻结的身份，避免后台 system actor 把身份切回统一默认值。

## 7. 验收标准

- **AC-1 单一数据源**：生产代码中不存在任务请求体提供提交 identity 的入口；所有公开启动
  schema 对两个旧键 fail closed。任务表既有两列仅由服务端写入。
- **AC-2 用户档案**：`/api/auth/me` 的私有响应包含当前用户 `displayName/email`；新增仅允许
  修改本人的 profile command，不能顺带改 role/status/permissions/username。管理员编辑路径
  与自助路径共用 identity-access 写合同。
- **AC-3 OIDC 配置**：Provider create/patch/read/test 与 Settings 表单同时支持
  `usernameClaim`、`emailClaim`；界面并列展示“用户名字段（Git user.name）”与
  “邮箱字段（Git user.email）”，均有自定义 userinfo 字段名、标准字段默认值和中英文说明。
  两个选择器复用安全 claim-name schema，拒绝毒键、空串和非法名称。
- **AC-4 userinfo 绑定**：配置 profile selector 时，即使 id_token 可验签也读取 userinfo；
  标准 subject 不一致、userinfo 不可用或严格邮箱字段非法均确定性失败，不写任何用户/identity/session。
- **AC-5 每次登录同步**：existing login、auto create、invite bind、未来 link 分支都通过同一事务内
  profile sync；覆盖空邮箱首填、值不变、IdP 改值、站内改值、字段消失、唯一冲突和 Provider
  配置在 callback 期间变化。
- **AC-6 任务冻结**：直接 session/PAT、workflow/agent/workgroup、schedule/event、relaunch、
  child task 均有明确 creator 规则；根任务读当前 profile，子任务继承父快照，运行时只读任务快照。
- **AC-7 前端**：任务向导、草稿、确认页、定时编辑器不存在可编辑 Git identity；账号页可编辑
  profile；邮箱缺失时启动按钮禁用并有修复入口；中英文文案与缓存隔离测试齐全。
- **AC-8 兼容迁移**：新增 Provider 列使用下一空 migration；存量任务快照不改；持久化 launch
  payload 的旧 identity 键被一次性删除；旧 session 下一次请求可读取当前 profile，旧 OIDC
  identity 下一次登录可补邮箱。
- **AC-9 Git 执行**：所有用户归属 commit 入口统一注入任务快照；内部 maintenance commit 仍用
  `AW_INTERNAL_GIT_IDENTITY`；测试同时证明 push credential 解析未被改动。
- **AC-10 门禁**：OIDC 分支矩阵、identity-access、task launch、commit runner、migration、前端
  component/E2E 与“不复辟旧字段”源码棘轮全绿；候选内容稳定后只跑一次完整 `bun run gate:local`。

## 8. 开工门

用户已于 2026-08-24 明确批准 RFC-320，proposal §5 的 C1–C8 生效。允许进入 migration、
shared schema、后端、前端与测试实现；任何超出这些裁决的能力扩张仍须回到设计门确认。

## 9. 实施与发布结果

- 主实现提交为 `5a6b36c572d9286a122c048f504e52c4e9fb3a41`；共享 E2E 管理员身份补齐提交为
  `09a46912e10a0dc4513587e477a39f27efd8bcec`；其余直接创建任务的 E2E 用户邮箱补齐提交为
  `82f4bad38b14a4dd7a8cd2e82552c2cf49a604fa`。三者均已进入 `origin/main`，后者包含前两者。
- 本任务定向 typecheck、格式、lint、后端/shared/frontend/OIDC/task/migration 测试全绿；修复后四个受影响
  Playwright 文件本地 **17/17** 通过。完整 `bun run gate:local` 只执行一次，RFC-320 暴露的问题均已修复并
  定向复验；整体被共享树中并发 RFC-318 的格式问题及门禁生成的 `test-results` 污染阻断，未冒充全绿。
- hosted visual `32697952937` 在包含主实现的 `09a46912e` 上成功；git-protocol `32698452846` 在包含主实现的
  `1884294ce` 上成功。精确 SHA `82f4bad38` 的 CI `32699593415` 终态为 **29/31 jobs success**；两格失败分别是
  RFC-250 workflow camera 遮挡点击与 macOS RFC-199 版本提示用例，均不涉及本 RFC 文件或行为。此前的
  `git-identity-email-missing` E2E 缺口已消失，RFC-320 相关 jobs/tests 全部通过。
