# RFC-267 · 实施计划

> 状态：Done（2026-08-07，用户批准后完成实现、全门禁与真实浏览器验收）

## 1. 依赖

- RFC-253 的 `<CodeEditor>` 与 `ScriptEdit` 已存在。
- RFC-035 的公共 `<Dialog size="full">` 已存在。
- RFC-250 的键盘、焦点恢复与响应式交互规范适用。

## 2. 任务分解

| 任务      | 内容                                                                                            | 验收                                                |
| --------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **T1 ✅** | RFC 三件套、`design/plan.md` 索引、`STATE.md` 进行中条目                                        | 文档链接可解析；用户明确批准后再进入 T2             |
| **T2 ✅** | `<CodeEditor>` 增加向后兼容 `fill` 布局档                                                       | 缺省实例尺寸不变；full 实例填满 flex 容器并内部滚动 |
| **T3 ✅** | `ScriptEdit` 增加正文 action、公共 full Dialog、同源 value/language/readOnly/onChange、焦点恢复 | AC-1…7                                              |
| **T4 ✅** | zh-CN / en-US i18n 与类型契约                                                                   | 无字面用户文案；两语言键齐全                        |
| **T5 ✅** | 仅布局 CSS + 720px 安全区规则                                                                   | 1536px 近全屏；390px 真全视口；无横向页面溢出       |
| **T6 ✅** | 组件回归测试 + CSS 源码锁 + RFC-198 overlay 清单                                                | 打开/关闭/回传/权限/焦点/尺寸全覆盖                 |
| **T7 ✅** | 定向测试、完整本地门禁、真实浏览器 1536/390 验收与截图                                          | AC-8；无未登记红项                                  |
| **T8 ✅** | RFC 状态与 `STATE.md` 收口                                                                      | Done 条目写明测试与视觉证据；发布须由用户单独授权   |

## 3. 文件范围

本 RFC 修改：

- `packages/frontend/src/components/CodeEditor.tsx`
- `packages/frontend/src/components/canvas/inspector/ScriptEdit.tsx`
- `packages/frontend/src/i18n/en-US.ts`
- `packages/frontend/src/i18n/zh-CN.ts`
- `packages/frontend/src/styles.css`
- `packages/frontend/tests/overlay-ux-inventory.test.ts`
- `packages/frontend/tests/rfc267-script-editor-fullscreen.test.tsx`（新）
- 本 RFC 三件套、`design/plan.md`、`STATE.md`

不改 backend / shared / migrations / API / e2e fixture 数据。

## 4. 完成定义

- AC-1…8 全部有可复跑证据；
- full Dialog 复用公共原语，无私有 overlay / panel chrome；
- 只读、键盘、焦点返回、390px 均真实验证；
- `bun run gate:local` 全绿；
- 本任务精确路径中无无关改动；共享工作树里的并发 WIP 原样保留并排除；
- commit / push 只在用户单独授权后执行；上库以远端祖先关系与 exact-SHA CI 为准。

## 5. 完成证据（2026-08-07）

- 定向回归：RFC-267 + RFC-253 + overlay 清单共 `14/14` 通过；完整前端 `719` 文件、`6083/6083` 通过。
- 完整门禁：`bun run gate:local` 终态全绿（`6m14s`）；backend `4/4` 分片、`9140` pass / `43` skip，shared `1783/1783`，frontend `6083/6083`，typecheck / lint / format / depcheck 全部通过。
- 构建：`bun run build:binary:e2e` 通过，三份 macOS arm64 二进制及版本 smoke 均成功。
- 真实浏览器（应用内 Chromium）：1536×960 时全屏代码区 `1438×830`；390×844 时 panel 精确 `390×844`、代码区 `358×756`、document scroll width `390`。全屏输入即时同步两处 CodeMirror、自动保存到 v2、Esc 关闭后焦点返回 trigger；控制台 0 warning / 0 error。
- 共享工作树另有 RFC-268、RFC-269 与 Webhook WIP；本任务未修改、未清理，并在发布时按精确行块排除。
