// The external one-click page. Deliberately standalone HTML served by this dev
// process — it is NOT part of the product frontend, so nothing about role
// verification can leak into a shipped bundle.

import { DEV_ROLES } from './roles'
import type { DevAuthSeedResult, SeededRole } from './seed'

export type DevAuthSeedState =
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly result: DevAuthSeedResult }
  | { readonly status: 'error'; readonly message: string }

export interface DevAuthPageState {
  readonly home: string
  readonly appOrigin: string
  readonly daemonBaseUrl: string | null
  readonly issuerUrl: string
  readonly seed: DevAuthSeedState
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    if (character === '"') return '&quot;'
    return '&#39;'
  })
}

function seededRole(state: DevAuthSeedState, key: string): SeededRole | undefined {
  return state.status === 'ok' ? state.result.roles.find((role) => role.key === key) : undefined
}

function statusBanner(state: DevAuthPageState): string {
  if (state.seed.status === 'pending') {
    return `<div class="banner banner--wait" data-testid="seed-status">
      正在等待 daemon 并种子四个角色账号…… 页面每 2 秒自动刷新。
    </div>`
  }
  if (state.seed.status === 'error') {
    return `<div class="banner banner--error" data-testid="seed-status">
      <strong>种子失败</strong>
      <pre>${escapeHtml(state.seed.message)}</pre>
      <form method="post" action="/reseed"><button type="submit">重试</button></form>
    </div>`
  }
  return `<div class="banner banner--ok" data-testid="seed-status">
    已就绪 · 身份提供方 <code>${escapeHtml(state.seed.result.providerSlug)}</code> ·
    种子管理员 <code>${escapeHtml(state.seed.result.adminUsername)}</code>
    <form method="post" action="/reseed"><button type="submit">重新种子</button></form>
  </div>`
}

function roleCard(state: DevAuthPageState, index: number): string {
  const role = DEV_ROLES[index]
  if (role === undefined) return ''
  const seeded = seededRole(state.seed, role.key)
  const ready = state.seed.status === 'ok'
  const account = seeded === undefined ? role.username : seeded.username
  return `<article class="card">
    <h2>${escapeHtml(role.title)}</h2>
    <p class="card__summary">${escapeHtml(role.summary)}</p>
    <dl class="card__meta">
      <dt>账号</dt><dd><code>${escapeHtml(account)}</code></dd>
      <dt>角色</dt><dd><code>${escapeHtml(role.key)}</code></dd>
    </dl>
    <a class="card__cta${ready ? '' : ' card__cta--disabled'}"
       data-testid="login-${escapeHtml(role.key)}"
       href="${ready ? `/login/${encodeURIComponent(role.key)}` : '#'}"
       ${ready ? '' : 'aria-disabled="true"'}>以此角色登录 →</a>
  </article>`
}

export function renderDevAuthPage(state: DevAuthPageState): string {
  const refresh = state.seed.status === 'pending' ? '<meta http-equiv="refresh" content="2">' : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Workflow · 开发角色一键登录</title>
${refresh}
<style>
:root { color-scheme: light dark; --bg:#f6f7f9; --fg:#12141a; --muted:#5d6470; --card:#ffffff; --line:#dfe3e8; --accent:#2f6feb; }
@media (prefers-color-scheme: dark) { :root { --bg:#111318; --fg:#e8eaee; --muted:#9aa3b0; --card:#191c22; --line:#2a2f38; --accent:#5b8cf5; } }
* { box-sizing: border-box; }
body { margin:0; padding:32px 24px 64px; background:var(--bg); color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif; }
main { max-width: 980px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 20px; }
.banner { border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:20px; background:var(--card);
  display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
.banner--ok { border-left:4px solid #2f9e5f; }
.banner--wait { border-left:4px solid #d29b1f; }
.banner--error { border-left:4px solid #d24b3f; display:block; }
.banner pre { white-space:pre-wrap; margin:8px 0; font-size:12px; color:var(--muted); }
.banner form { margin-left:auto; }
.banner button, .card__cta { font:inherit; cursor:pointer; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; padding:6px 12px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; display:flex; flex-direction:column; }
.card h2 { font-size:16px; margin:0 0 6px; }
.card__summary { color:var(--muted); font-size:13px; margin:0 0 12px; flex:1; }
.card__meta { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; margin:0 0 14px; font-size:12px; color:var(--muted); }
.card__meta dt { color:var(--muted); } .card__meta dd { margin:0; }
.card__cta { display:block; text-align:center; text-decoration:none; background:var(--accent); color:#fff; border-color:transparent; padding:9px 12px; font-weight:600; }
.card__cta--disabled { opacity:.45; pointer-events:none; }
.facts { margin-top:28px; border-top:1px solid var(--line); padding-top:16px; font-size:13px; color:var(--muted); }
.facts dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:0 0 12px; }
.facts dd { margin:0; }
code { font-family: ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,monospace; font-size:12px; }
</style>
</head>
<body>
<main>
  <h1>开发角色一键登录</h1>
  <p class="sub">点一个角色即可以该身份进入 <code>${escapeHtml(state.appOrigin)}</code>。
  同一浏览器 profile 只保留最后一次登录的会话；想同时对比两个角色请用无痕窗口。</p>
  ${statusBanner(state)}
  <section class="grid">
    ${DEV_ROLES.map((_role, index) => roleCard(state, index)).join('\n')}
  </section>
  <section class="facts">
    <dl>
      <dt>数据目录</dt><dd><code>${escapeHtml(state.home)}</code></dd>
      <dt>daemon</dt><dd><code>${escapeHtml(state.daemonBaseUrl ?? '等待中…')}</code></dd>
      <dt>mock IdP</dt><dd><code>${escapeHtml(state.issuerUrl)}/.well-known/openid-configuration</code></dd>
    </dl>
    <p>四个账号由本进程用真实授权码流程种入上面这个数据库，登录链路与生产完全一致：
    <code>login/start → mock IdP → callback → #aw_session</code>。产品代码零改动，
    关掉本进程后系统仍按原样运行（登录页会多出一个禁用不掉的 <code>[dev]</code> 身份提供方，
    可在 设置 → 身份提供方 里删除）。</p>
  </section>
</main>
</body>
</html>`
}
