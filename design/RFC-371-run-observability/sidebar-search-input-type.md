# RFC-371 观测空搜索输入的路由类型修正

## 问题与最终行为

`13a58441962de23c306bbb0709d98fd40fad825d` 的 GitHub CI 主流水线 `37998000621`，job `114048841755` 在 frontend typecheck 报 `rfc371-report-refresh-display.test.tsx(887,10): TS2741 Property search is missing`。新测试使用真实 `Link to="/observability"` 返回正式完整页面；运行时允许空搜索且已由原 validator 补齐 `from/to/period/tab`，但 TanStack Router 默认将 validator 的**输出**误当作链接的必填输入。

使用已安装 `@tanstack/router-core@1.169.2` 的 `SearchSchemaInput` 与 `ValidatorFn` 类型，仅标注 `Route.options.validateSearch` 的原函数引用。库的 `ResolveSearchValidatorInputFn` 识别标记并移除它；路由导航的输入为 `Partial<ObservationSearch>`，输出仍为原 `ObservationSearch`。字段可以缺省，已有完整 `ObservationSearch` 也能直接作为导航输入；原导出 validator 继续用 `Record<string, unknown>` 接收和检查原始搜索。运行时保持同一个函数引用，原 validator 的签名、函数体、全部显式筛选、默认日期复用、URL 固定与组件逻辑逐字不变；没有包装函数或新读写路径。

## 验证与边界

保留原测试文件全部 55,201 字节、原 128 个基础断言和全部追加页面生命周期/完整性断言，不补伪造日期、不替换真实 Link、不增 `any`、不放宽失败断言或超时。原提交的 9 个 frontend shards 与视觉回归已成功，主流水线因本类型错误仍失败，不记为完成。只做该正式路由文件的格式与 ESLint；最终类型检查与全仓判据仍以本修正的远端 exact-SHA CI 为准，不运行本机产品测试、类型检查、构建或新服务。

沿用此前 v41 DESIGN 的行为合同与 v42 SOURCE 的事实资格合同。此补丁仅纠正类型输入输出，不修改实现行为；完整 SOURCE 复核确认逆向删除两个 type imports 与该原引用的类型标注后，恢复原正式路由全文。在固定候选上按原算法只运行一次规范投影，排除并行未提交输出，再做 MATCHING 复核和精确路径发布。读取缓存实验没有证明首次生成提速，另保留实验结论且不发布其生产提示；首次生成 18–19 秒仍是未关闭项。

前次 `20aad27d4466251fba80866ee65cce616e1a0b26` 的默认完整 Windows `38004078470` 在 frontend typecheck 报正式页面 `observability.tsx(128,11): TS2322`：先前的路由输入 `Record<string, unknown>` 带字符串索引签名，原 `navigate({ search: next })` 的 `ObservationSearch` 接口不具备该签名。该失败保留，不把静态 SOURCE 通过当成类型检查成功。本次仅将同一类型标注的输入改为原已知搜索字段的可选映射；真实 Link 和原导航调用、原全部测试及超时均保持，新的远端 exact-SHA 类型检查仍须单独验收。
