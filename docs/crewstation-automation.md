# CrewStation 托管版的 API 与 MCP 自动化

RFC-370 M3 的自动化入口使用两份凭据：CS 用户会话通过平台网关，AW PAT 限定同一用户在 AW 中的权限。请求仍发往 AW 用户域；不能用 AW PAT 单独通过 CS 网关，也不能从浏览器复制短时 `x-cs-identity-token` 作为长期令牌。

CS 网关校验会话后，向 AW 注入面向该服务的签名身份；平台会话 cookie 本身会被网关移除。AW 校验签名、账号状态和 PAT，要求 PAT 的所有者与该 CS 身份映射到的 AW 用户一致。请求中只要提供了 `Authorization`，无效、过期、撤销、属于另一账号或非 PAT 的凭据都返回 401，不降级为浏览器权限。

## 准备凭据

1. 用自动化所需的 CS 用户从 CS 入口打开 AW，经账户菜单进入“我的账户 → 外部对接令牌”（My account → Integration tokens），点“创建令牌”签发最小权限 PAT。REST 使用 `general` 用途，MCP 可使用 `mcp_only`；MCP 工具列表继续按 PAT 权限过滤。签发和 MCP 入口受管理员的外部 API 开关控制：AW 管理员在“设置 → 网络 → 外部访问”中的“对外接口（API 令牌与 MCP）”开关（Settings → Network → External access）。托管部署的网络页只有这一项，监听地址由平台管理；数据库与登录认证页在托管下不出现。
2. 获取同一 CS 用户的有效平台会话。启用密码登录的平台支持 `POST /auth/login`，JSON 请求与 `Accept: application/json`，成功响应通过 `Set-Cookie` 设置会话。使用 CS 的认证域地址，将 cookie 保存到权限为 0600 的 cookie jar；只配置 OIDC 的平台应使用其正式交互登录流程取得会话。
3. 将 AW PAT 存入自动化平台的秘密配置。CS cookie jar 同样是凭据，不提交仓库、不打印到日志。会话到期或在 CS 被撤销后需要重新登录；PAT 不会延长平台会话。

密码登录示例使用环境中的用户名与密码，JSON 经标准输入交给 curl。请把认证域替换为本机部署的实际地址；示例中的 `.cs.localhost` 地址用于本地环境。

```sh
umask 077
export CS_AUTH_URL=http://console.cs.localhost
export AW_URL=http://agent-workflow.cs.localhost
export CS_COOKIE_JAR="$PWD/.cs-automation-cookies"
# 由秘密管理器提供 CS_USER、CS_PASSWORD；不要把口令写在命令行参数里。
python3 - <<'PY' | curl --fail-with-body --silent --show-error \
  --cookie-jar "$CS_COOKIE_JAR" \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  --data-binary @- "$CS_AUTH_URL/auth/login"
import json, os
print(json.dumps({"username": os.environ["CS_USER"], "password": os.environ["CS_PASSWORD"]}))
PY
```

REST 调用同时带 cookie jar 与 PAT。下例把 PAT 请求头经标准输入交给 curl，避免放入进程参数；关闭 shell 的命令跟踪，不加 curl 的 `--verbose` 或 `--trace`。

```sh
printf 'Authorization: Bearer %s\n' "$AW_PAT" | \
  curl --fail-with-body --silent --show-error \
    --cookie "$CS_COOKIE_JAR" --header @- "$AW_URL/api/whoami"
```

返回身份应为 PAT 身份。`mcp_only` PAT 对普通业务 REST 端点仍受用途限制；`/api/whoami` 是身份自检例外。只有 CS 会话的普通浏览器请求继续按浏览器身份处理。

## MCP 客户端

使用 Streamable HTTP 地址 `http://agent-workflow.cs.localhost/api/mcp`，每次请求同时提供 CS 平台会话 cookie 和 `Authorization: Bearer <AW_PAT>`。客户端需要支持 cookie jar，或在秘密配置中设置 `Cookie` 请求头。Cookie 名称和域以实际 `Set-Cookie` 为准，不写死平台内部默认名。客户端必须接受 `application/json, text/event-stream`。

只带 CS 会话调用 `/api/mcp` 返回 401；只带 AW PAT 在平台网关处无法取得用户身份。AW MCP 的 PAT 用途、权限过滤、每次调用审计、禁用开关和撤销检查保持生效。注销或撤销其中任意一份凭据都能阻止后续调用。客户端不要自动跟随登录重定向后把 HTML 当作 MCP 响应，应提示重新取得 CS 会话。

## 验收边界

双数据库用例覆盖同账号 PAT、外部身份缺失、跨账号 PAT、无效与撤销凭据、原 MCP 握手和工具权限过滤。开发期只写用例；真实 CS 网关、会话撤销及外部 MCP 客户端的操作验收在候选完成后集中执行。该方式是现有 CS 会话合同上的集成，不声明 CS 已提供 PAT 或用户 Bearer 登录接口。
