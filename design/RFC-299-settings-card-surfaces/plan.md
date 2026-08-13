# RFC-299 设置界面统一卡片化 — 实施计划

状态：**Done（2026-08-14）**

## 1. 前置门

- [x] 读取 `CLAUDE.md`、`STATE.md` 与 frontend consistency 约束。
- [x] 枚举 `/settings` 11 个主分区、Runtime/OIDC 二级编辑器及现有 Card seam。
- [x] 用户确认“所有配置页面都卡片化”，明确包含运行时/OIDC 等二级配置面。
- [x] 决定以系统 Agent 的共享 Card 结构为唯一视觉基准，不复制 feature CSS。
- [x] 用户批准 RFC-299 三件套并授权完整实现、提交与推送共享 `main`。
- [x] 实现开工前重查共享工作树；当前只有 RFC-299 文档改动，无并发 WIP 冲突。
- [x] 外部 `codex review` 因未获源码外传授权被本机安全策略拒绝；未绕过，改由当前 Codex
      会话按 live source 完成不外传的覆盖面/行为边界/测试矩阵核对后进入实现。

## 2. 任务分解

### 批 A — 设置卡片公共原语

| #          | 任务                                                                             | 验证                    |
| ---------- | -------------------------------------------------------------------------------- | ----------------------- |
| RFC-299-T1 | 新增 `components/settings/SettingsCard.tsx`，复刻系统 Agent title/hint/body 契约 | 组件 render 测试        |
| RFC-299-T2 | 最小扩展 `Card` 支持 fieldset + disabled（以及必要的 title ref/id）              | `card.test.tsx` 正反例  |
| RFC-299-T3 | 新增双语 `settings.cardGroups` / runtime/code-host 分组文案                      | i18n 类型与 1:1 锁      |
| RFC-299-T4 | 删除本地 `AgentCard`，系统 Agent 六卡迁共享 primitive                            | 既有 SystemAgents tests |

依赖：用户批准。退出门：系统 Agent DOM/行为不退化，shared primitive 可供所有后续批复用。

### 批 B — Config SectionForm 主分区

| #           | 任务                                          | 验证                             |
| ----------- | --------------------------------------------- | -------------------------------- |
| RFC-299-T5  | Limits 三卡：预算 / 并发与层级 / 日志         | 数值 bounds + quota tests        |
| RFC-299-T6  | Recovery 两卡：自动行为 / 安全阈值            | recovery settings tests          |
| RFC-299-T7  | Git 两卡：拉取 / 刷新                         | source/render locks              |
| RFC-299-T8  | GC 四卡：worktree / events / webhook / backup | retention + backup tests         |
| RFC-299-T9  | Network 两卡：listener / external surface     | effective bind + save tests      |
| RFC-299-T10 | Appearance 与 Rendering 各一卡                | language/theme + rendering tests |

依赖：批 A。退出门：所有 config tabs 仍由原 `SectionForm` 单 Save 收尾，字段、slice、body 不变。

### 批 C — 独立资源主分区

| #           | 任务                                                                       | 验证                          |
| ----------- | -------------------------------------------------------------------------- | ----------------------------- |
| RFC-299-T11 | RuntimeList 外壳迁 SettingsCard，Add 进入 action slot并保留 focus fallback | runtime-list tests            |
| RFC-299-T12 | GitLab/GitHub ConnectionCard 迁 SettingsCard                               | code-host request/body tests  |
| RFC-299-T13 | Authentication login policy 与 provider collection 两卡统一                | OIDC/login-policy/focus tests |

依赖：批 A。退出门：三个独立 API 域的 mutation 数量、端点、body 与权限反馈逐字不变。

### 批 D — 二级配置编辑器

| #           | 任务                                                                                        | 验证                          |
| ----------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| RFC-299-T14 | RuntimeFormDialog 拆身份与启动 / 执行配置两卡                                               | add/edit/profile/Claude tests |
| RFC-299-T15 | OidcProviderDialog 四组换 fieldset SettingsCard，删私有 chrome                              | disabled/a11y/wire tests      |
| RFC-299-T16 | 删除无消费者的 `auth-tab__header/title`、`oidc-form__group*` 与 inline/page-section spacing | CSS/source ratchet            |

依赖：批 A、C。退出门：Dialog footer、conditional fields、bulk disabled、focus trap 与 wire body不变。

### 批 E — 全面棘轮与真实视觉

| #           | 任务                                                                   | 验证              |
| ----------- | ---------------------------------------------------------------------- | ----------------- |
| RFC-299-T17 | 11 tab + 2 editor 全覆盖棘轮、禁止旧私有 chrome 复辟                   | frontend test     |
| RFC-299-T18 | `ux-consistency` 全 tab card/overflow + runtime/OIDC editor            | Playwright        |
| RFC-299-T19 | 更新 Runtime、mobile Network 基线；新增 System Agent、mobile OIDC 基线 | visual regression |
| RFC-299-T20 | 390 dark a11y、keyboard/focus、TableViewport 内滚动复核                | axe + E2E         |
| RFC-299-T21 | Codex 实现门、处置 findings、`bun run gate:local`                      | 全门禁            |

依赖：批 B-D。

## 3. 测试用例清单

### 3.1 正常路径

- 11 个 tab 切换后各自出现预期标题/数量的设置卡。
- 所有原字段、Select、Switch、按钮仍能按原方式编辑、保存、测试、删除。
- Runtime Add/Edit 两卡、OIDC Add/Edit 四卡均显示；条件字段随 protocol/provisioning 正确切换。
- System Agent 六卡标题仍为 h3 `card__title`，单 Save 仍覆盖两条写资源。

### 3.2 异常与写入边界

- config invalid/stale/outcome-unknown/restart feedback 仍在整个 card stack 后统一显示。
- Fusion-only save 不 PUT config；config-only save 不 PATCH fusion；revision fence 不变。
- Code host save/test/delete 仍只请求所属 provider；错误只落所属卡。
- Runtime probe/save error 与 OIDC probe/save error 保持原归属，不被 Card 吞掉或重复。
- OIDC busy 时四个 fieldset descendants 全 disabled，Dialog close/save/test 规则不变。

### 3.3 相邻遗漏与反向锁

- Loading/Error/Empty/ConfirmDialog 不被误包成无标题设置卡。
- `/agents`、workflow inspector、webhook 管理页不因全局 CSS selector 被意外改样式。
- `.card` 普通 div/section 调用方 DOM 不变；只有显式 fieldset 才透传 disabled。
- 禁止 `AgentCard`、`.system-agent-card` 视觉特例、`page__section` connection card、
  `oidc-form__group` 私有 chrome 回归。

### 3.4 响应式 / a11y / 视觉

- 390×844：network cards、Save/提示、effective-port action 不越界。
- 390×844 OIDC Dialog：四卡纵向滚动、footer 可达、44px action、无页面 overflow。
- Desktop Runtime：outer Card、nested rows、Add action 对齐；默认行 accent/contrast 不变。
- Desktop System Agents：基准卡 title/hint/body rhythm 不变。
- Dark mode：Card 背景/边框取 token，无固定浅色残留。
- fieldset card 有可访问名称；Card h3 层级不跳级；table scroll container 保持 focusable。

## 4. 验收映射

| Proposal AC                 | 实施任务         |
| --------------------------- | ---------------- |
| 11 主分区全部 SettingsCard  | T4-T13、T17      |
| Runtime/OIDC 二级编辑器     | T14-T16、T18-T20 |
| 单 Save与独立 mutation 不变 | T4-T15 行为回归  |
| 删除私有 chrome             | T4、T11-T16、T17 |
| 双语标题/说明               | T3               |
| 390/desktop/light/dark/a11y | T18-T20          |
| 全门禁与实现门              | T21              |

## 5. 提交建议

本仓直接在共享 `main` 小步提交，不建分支：

1. `feat(frontend): RFC-299 新增设置卡片公共原语`
2. `feat(settings): RFC-299 卡片化 config 分区`
3. `feat(settings): RFC-299 卡片化独立资源分区`
4. `feat(settings): RFC-299 卡片化二级配置编辑器`
5. `test(e2e): RFC-299 锁定设置卡片覆盖与视觉`

每个生产提交同时携带对应测试。提交前精确暂存 owned paths；如本 Codex session 对 commit 有实质
贡献，追加真实模型 `Co-Authored-By` trailer，并在 push 前用 `git show -s --format=%B HEAD` 核验。

## 6. 回滚与完成定义

- 无 DB/wire/backend 变化，按 frontend commit 逆序回滚即可；
- 任何批次不得把半数 tab 留在旧平铺形态后宣称完成；
- 只有 T1-T21 全完成、定向测试与 `bun run gate:local` 全绿、视觉基线审过、实现门无未处置 finding，
  才可把 RFC/索引/STATE 标为 Done。

## 7. 实施记录（2026-08-14）

- T1-T21 全部完成。实现提交 `833a5c69` 覆盖共享 primitive、11 个设置分区、Runtime/OIDC
  二级编辑器、双语文案以及 unit/E2E/a11y/visual 防退化锁。
- 用户指出 Code Hosts 两卡之间没有留白后，外层统一改为 `.form-grid`；真实浏览器用例直接读取
  两卡 bounding box，要求垂直间距至少 15px。
- 只含 RFC-299 的干净固定快照完整 `bun run gate:local` 通过：shared 2055、frontend 6422、
  backend 10021 pass / 35 skip / 0 fail；frontend 全量为 753 files / 6422 tests。
- macOS 四个目标场景生成后复跑 20/20 零差异并人工审核；首个 Linux run
  `31713914826` 仅报四张预期基线变化，下载 actual 后逐张人工审核，再由 `cea6fab2` 接受四张
  Linux 基线。该提交的 Visual Regression run `31722271018` 为 44/44 全绿。
- 包含实现提交 `833a5c69` 的远端 `9d2669cc` 在 CI run `31713914764` 全绿。后继
  `9f683902` 的 run `31722823187` 首跑与 failed-only 重跑均只在 RFC-024 Git URL 启动用例
  超时，且 Linux/macOS/Windows 同点复现；该链来自 RFC-299 之后的并发 RFC-287/301 改动，
  不作为 RFC-299 的成功证据，也未越权改动。
- `833a5c69` 与 `cea6fab2` 均已进入 `origin/main`；发布使用独立干净工作树，未夹带共享
  工作区的并发 WIP。未声称 live service 部署。
