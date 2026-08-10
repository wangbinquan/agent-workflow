# RFC-277 · GitLab 连接 TLS 证书校验开关

状态：In Progress（2026-08-10，功能与定向验证已完成；全仓门禁等待并行 RFC-276 收口）

## 1. 背景

用户在 2026-08-10 实报：自建 GitLab 的 HTTPS 证书链不完整，代码平台连接在 TLS 握手阶段失败，
希望 GitLab 连接可以显式使用 `rejectUnauthorized: false`。

RFC-269 已提供每家一套代码平台连接、测试连接与工作流出站调用，但当前所有请求都使用 Bun
`fetch` 的默认 TLS 校验。Bun 官方文档确认，单次请求可以通过
`tls: { rejectUnauthorized: false }` 关闭证书校验；这会同时跳过证书链与主机身份的可信校验，
必须作为有风险的逐连接例外，而不能变成 daemon 全局环境变量或默认行为：

- <https://bun.com/docs/runtime/networking/fetch#disable-tls-validation>

## 2. 目标

1. 在 GitLab 代码平台连接上新增“验证 HTTPS 证书”开关。
2. 默认开启验证；存量连接升级后继续验证，零行为变化。
3. 管理员显式关闭时，仅该 GitLab 连接的身份探活与实际 API 请求使用
   `tls.rejectUnauthorized = false`。
4. 保存、读取、测试连接与工作流执行使用同一个持久化值，不能出现“测试成功但节点仍失败”。
5. UI 明示关闭证书校验会降低中间人攻击防护。

## 3. 非目标

- 不给 GitHub / GHES 增加关闭证书校验的入口。
- 不设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`，不影响 daemon 的其它 HTTPS 请求。
- 不新增自定义 CA、客户端证书或证书 pinning；这些若需要，另立 RFC。
- 不自动检测证书错误后降级重试；管理员必须显式选择。
- 不把该设置应用到经过认证信息剥离后跟随的第三方重定向 URL。

## 4. 产品与安全决策

### D1 · 正向语义与默认值

wire 与存储字段命名为 `rejectUnauthorized: boolean`。UI 使用正向文案“验证 HTTPS 证书”：

- `true`：默认值，使用 Bun 默认 TLS 校验；
- `false`：向 GitLab 请求传 `tls: { rejectUnauthorized: false }`。

不采用“允许不安全证书”作为数据字段，避免双重否定在 API、DB 与执行器间漂移。

### D2 · 只属于 GitLab

GitHub 卡片不展示该开关。后端收到 GitHub 的 `rejectUnauthorized: false` 时以 422 拒绝，
不能静默接受一个实际不生效的设置。GitHub 未配置行在 wire 上仍返回 `true`，保持响应形状稳定。

### D3 · 保存与草稿语义

- 首次配置省略字段 ⇒ `true`；
- 已配置连接的 PUT 省略字段 ⇒ 保留原值；
- 设置改变时，与 base URL / token 改变相同，作废旧 `lastTest`；
- 测试连接请求可携带草稿值；省略时回落到已保存值；只有 base URL、token、
  `rejectUnauthorized` 三者都与已保存值一致时才回写 `lastTest`。

### D4 · 请求作用域

关闭校验只作用于向已配置 GitLab API root 发出的请求：

1. `POST /api/code-hosts/gitlab/test` 的 `/user` 身份探活；
2. `code-host-call` 节点向该 API root 发出的首跳请求及其同 URL 重试。

执行器唯一允许跟随的一跳会剥离认证头并访问第三方签名 URL；该跳不继承 GitLab 的 TLS 例外，
避免把一个内网 GitLab 的信任降级扩散到其它主机。

### D5 · UI 风险提示

GitLab 卡片复用公共 `Switch`。开关默认打开；提示明确说明：仅当内网 GitLab 的证书链暂时无法
修复时关闭，关闭会设置 `rejectUnauthorized: false` 并降低中间人攻击防护。保存与测试按钮继续
使用既有交互，不新增第二套确认弹窗。

## 5. 兼容性与部署影响

- 存量 DB 通过前向 migration 新增非空布尔列，默认 `1`；升级后行为不变。
- GET wire 新增必填布尔字段；同仓前后端原子升级。旧客户端忽略未知响应字段。
- PUT / test 请求字段可选，旧客户端继续可用。
- 关闭校验后，GitLab token 仍只发给规范化 API root，现有 URL/path/redirect/token-redaction
  边界不变；变化仅是 TLS 对端身份不再可信。

## 6. 验收标准

- **AC-1** 新安装、未配置行与存量升级行均为 `rejectUnauthorized: true`。
- **AC-2** GitLab 保存 `false` 后，GET/resolve round-trip 为 `false`；省略字段更新其它值时仍保留。
- **AC-3** GitHub 请求 `false` 返回 422，GitHub UI 不展示开关。
- **AC-4** GitLab 测试连接在 `false` 时精确传递 `tls: { rejectUnauthorized: false }`；`true` 时不传
  TLS override。
- **AC-5** 实际 `code-host-call` 首跳及重试在 `false` 时携同一 TLS override；默认值不携带。
- **AC-6** 认证剥离后的第三方重定向不携带 TLS override。
- **AC-7** 草稿测试与已保存值的三字段一致性决定是否回写 `lastTest`。
- **AC-8** GitLab UI 复用公共 `Switch`，能保存/测试 `false`，并展示中英文风险提示。
- **AC-9** token 密封、掩码、权限、URL 约束、重试与重定向防泄漏回归全绿。
- **AC-10** 定向测试、三包 typecheck、format/lint/depcheck 与 `bun run gate:local` 全绿。

## 7. 已批准的实施边界

用户于 2026-08-10 明确要求“直接加”，确认：

1. 开关只给 GitLab；
2. 默认与存量值均为 `true`；
3. `false` 同时影响测试连接和真实节点请求；
4. UI 明示安全风险，但不额外要求二次确认；
5. 本 RFC 不实现自定义 CA。
