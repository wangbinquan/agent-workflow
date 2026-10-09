# RFC-371：趋势钻取被默认时间范围固定逻辑覆盖

确切提交 4cb2acc5 的 Ubuntu E2E 2/3 与 Windows E2E 3/4，首次和重试均在原趋势柱 Enter 后未选中 Task traces。Windows 重试原追踪记录：267897ms 前报告及趋势已返回，268940ms 原按钮实际聚焦，268971～269021ms 发出 Enter，随后原 15000ms 断言仍读到总览；该期间没有新报告/分页响应替换趋势。原追踪、原失败和全部预算保留。

正式本机页面已取得确切覆盖证据：柱点击调用原 onRange，范围为 1791506009542～1791510371671；pin effect 随后看到新 URL `?from=1791506009542&to=1791510371671&period=custom&tab=tasks`，却与还未更新的 Route.useSearch 比较，使用旧 1790955611302～1791560411302、overview 再 navigate replace，最终 URL 回到旧总览。这也解释了浏览器返回范围被覆盖。两者都是合法范围，不能把正常导航中的暂时不同步判成缺省时间。

修复只改默认范围固定的判据：从同一个 useLocation 读取当前 parsed search 和 searchStr，已明确提供合法整数 from/to 的 URL 立即保留；只对真正缺失或非法的范围，将原 Route 已验证值 replace 到 URL。保留原校验的非负、严格 from<to、正 to 与安全整数规则。保留缺省时间首屏固定、全部相邻筛选和单次 replace，不添加历史条目。原趋势按钮、native Enter/Space、onClick、focus/hover、样式、四桶/CNY、全人口/EOF和报表整体替换逐字保持；先前直接补键盘激活的私有候选已撤回，临时事件诊断全部移除。

原默认范围测试的全部断言和预算保留。新增真实 Router/MemoryHistory 导航案例，调用正式 Page 的 onChange 验证趋势范围与任务追踪、正常范围切换、back/forward均不被反向 replace；缺失/非法/反向/相等/负/非整数/不安全整数/字符串数字继续使用已验证范围。保留原 `e2e/rfc371-run-observability.spec.ts` 第420行案例的 focus、Enter、Task traces 选中、精确时间范围和原任务核对，及原数据/1280与390px几何/截图/预算。新源码与新回归仅由 hosted CI执行验收，不将本机正式页面核对代签全仓成功。
