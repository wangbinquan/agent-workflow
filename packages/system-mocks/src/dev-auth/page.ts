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
  /** When THIS process started — the answer to "am I looking at a stale page?". */
  readonly startedAt: number
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

/**
 * One accent per role. Colour is the strongest defence against the misclick this
 * page invites — four identical blue buttons a few pixels apart are one slip
 * away from "why am I suddenly an admin". Kept here rather than in roles.ts:
 * the role table is data, this is presentation.
 */
const ROLE_ACCENT: Record<string, string> = {
  admin: '#d0453f',
  manager: '#7757d6',
  user: '#2f6feb',
  guest: '#5c6b7a',
}

function roleCard(state: DevAuthPageState, index: number): string {
  const role = DEV_ROLES[index]
  if (role === undefined) return ''
  const seeded = seededRole(state.seed, role.key)
  const ready = state.seed.status === 'ok'
  const account = seeded === undefined ? role.username : seeded.username
  const accent = ROLE_ACCENT[role.key] ?? '#2f6feb'
  return `<article class="card" style="--role:${escapeHtml(accent)}">
    <span class="card__badge">${escapeHtml(role.key)}</span>
    <h2>${escapeHtml(role.title.replace(/^[a-z]+ · /, ''))}</h2>
    <p class="card__summary">${escapeHtml(role.summary)}</p>
    <dl class="card__meta">
      <dt>账号</dt><dd><code>${escapeHtml(account)}</code></dd>
    </dl>
    <a class="card__cta${ready ? '' : ' card__cta--disabled'}"
       data-testid="login-${escapeHtml(role.key)}"
       href="${ready ? `/login/${encodeURIComponent(role.key)}` : '#'}"
       ${ready ? '' : 'aria-disabled="true"'}>以 ${escapeHtml(role.key)} 登录</a>
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
:root { color-scheme: light dark; --bg:#f5f6f8; --fg:#12141a; --muted:#5d6470; --card:#ffffff;
  --line:#e2e6ea; --accent:#2f6feb; --shadow:0 1px 2px rgba(16,20,28,.05), 0 12px 28px -20px rgba(16,20,28,.45); }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e8eaee; --muted:#98a1ae; --card:#181b21;
  --line:#282d36; --accent:#5b8cf5; --shadow:0 1px 2px rgba(0,0,0,.45), 0 14px 30px -22px rgba(0,0,0,.9); } }
* { box-sizing: border-box; }
body { margin:0; padding:40px 24px 72px; background:var(--bg); color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif; }
main { max-width: 880px; margin: 0 auto; }
h1 { font-size: 24px; letter-spacing:-0.2px; margin: 0 0 6px; }
.sub { color: var(--muted); margin: 0 0 24px; max-width: 72ch; }
.banner { border:1px solid var(--line); border-radius:12px; padding:12px 16px; margin-bottom:28px; background:var(--card);
  display:flex; gap:12px; align-items:center; flex-wrap:wrap; box-shadow:var(--shadow); }
.banner--ok { border-left:4px solid #2f9e5f; }
.banner--wait { border-left:4px solid #d29b1f; }
.banner--error { border-left:4px solid #d24b3f; display:block; }
.banner pre { white-space:pre-wrap; margin:8px 0; font-size:12px; color:var(--muted); }
.banner form { margin-left:auto; }
.banner button { font:inherit; font-size:13px; cursor:pointer; border-radius:8px; border:1px solid var(--line);
  background:transparent; color:var(--muted); padding:7px 14px; }
.banner button:hover { color:var(--fg); border-color:var(--muted); }
/* Wide gutters are half the point: four one-click identity switches sitting a
   few pixels apart is how you end up auditing the wrong role. */
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:28px; }
@media (max-width: 760px) { .grid { gap:20px; } }
.card { background:var(--card); border:1px solid var(--line); border-top:3px solid var(--role);
  border-radius:16px; padding:22px 20px 20px; display:flex; flex-direction:column; box-shadow:var(--shadow); }
.card__badge { align-self:flex-start; font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
  color:var(--role); background:color-mix(in srgb, var(--role) 12%, transparent);
  border:1px solid color-mix(in srgb, var(--role) 34%, transparent); border-radius:999px; padding:3px 10px; margin:0 0 12px; }
.card h2 { font-size:17px; margin:0 0 8px; }
.card__summary { color:var(--muted); font-size:13px; line-height:1.65; margin:0 0 16px; flex:1; }
.card__meta { display:flex; gap:8px; align-items:baseline; margin:0 0 18px; font-size:12px; color:var(--muted); }
.card__meta dd { margin:0; }
.card__cta { display:flex; align-items:center; justify-content:center; min-height:50px; padding:0 14px;
  border-radius:12px; border:0; background:var(--role); color:#fff; font:inherit; font-size:15px; font-weight:600;
  text-decoration:none; cursor:pointer; box-shadow:0 6px 16px -10px var(--role);
  transition:transform .12s ease, filter .12s ease, box-shadow .12s ease; }
.card__cta:hover { filter:brightness(1.08); transform:translateY(-2px); box-shadow:0 12px 22px -12px var(--role); }
.card__cta:active { transform:translateY(0); filter:brightness(.95); }
.card__cta:focus-visible { outline:3px solid color-mix(in srgb, var(--role) 55%, transparent); outline-offset:3px; }
.card__cta--disabled { background:var(--line); color:var(--muted); box-shadow:none; pointer-events:none; }
.facts { margin-top:36px; border-top:1px solid var(--line); padding-top:20px; font-size:13px; color:var(--muted); }
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
      <dt>本页进程</dt><dd>启动于 <code>${escapeHtml(new Date(state.startedAt).toLocaleString('zh-CN'))}</code></dd>
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
