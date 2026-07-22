# Codex Adversarial Review

Target: branch diff against 962c575d
Verdict: needs-attention

NO-SHIP：status-0 的 transport/reconcile 分类与 RFC-203 一致，但草稿仍有两条真实丢失路径；拖放中心锚点使用错误尺寸；9d9c07e7 只是把已知字体双稳态换成多数派 PNG。

Findings:
- [high] 保存结果未知时仍可“放弃修改”离页 (packages/frontend/src/routes/workflows.edit.tsx:1284)
  触发路径：保存 A 的 PUT 在途 → 用户继续编辑产生 queued B → 发起站内导航 → 点击“放弃修改”。路由只传 dirtyRef；共享 Guard 仅在 busyRef=true 时隐藏该按钮，而 Hook 卸载只清计时器并忽略回执，不会撤销请求。结果可能是 A 离页后提交、B 永久丢失，用户要求“放弃”却留下半份远端修改。
  Recommendation: 把 state.inFlight/saving/reconciling 接入 busyRef 与 busySinceRef，未知结果期间禁止普通 discard；强制离页前先持久化 recovery ledger，并在下次进入时 reconcile。补一条真实路由/E2E：hold PUT A、编辑 B、尝试导航，断言不能 discard 且 B 最终可恢复。
- [high] 离线草稿和 reconcile ledger 仅存在内存 (packages/frontend/src/hooks/useWorkflowEditorDraft.ts:175-179)
  触发路径：status-0/timeout 进入 offline/reconciling → 用户继续编辑 → reload、浏览器崩溃或移动端回收标签页。Hook 启动时只从服务端 options.initial 建状态，卸载时丢弃 attempt、queued revision 和本地快照；重新打开后既无法判断旧 PUT 是否落地，也无法恢复后续编辑，多标签并发时连应出现的 conflict/copy 路径都消失。现有 E2E 均等到 Saved 后才 reload，未覆盖该失败面。
  Recommendation: 在共享 draftDb 增加按 actor/workflow/tab 隔离的 workflow draft store，原子持久化 local、serverRevision、inFlight mutationId、queuedRevision；启动时先恢复并 GET/reconcile，只有精确回执或显式放弃后才删除。补 offline reload、response-loss reload、崩溃恢复及恢复期间 foreign commit 的 E2E。
- [medium] 中心锚点使用的尺寸与实际编辑器卡片不一致 (packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1922-1925)
  拖放坐标换算本身使用了 screenToFlowPosition，但随后按 DEFAULT_NODE_SIZE_BY_KIND 居中：agent 使用 280×180，而编辑器 CSS 实际宽 240；review 实际宽 260，节点高度还随端口数增长。因而 2× 缩放下 agent 可偏离光标约 40 屏幕像素，碰撞框也可能低估真实节点并产生重叠。5f8093bb 的 E2E 明确忽略 rendered size，只断言该默认尺寸的 translate，锁住了实现而非用户看到的落点。
  Recommendation: 建立与渲染器共用的权威 footprint（含 kind、端口数），或插入前完成测量，再将同一尺寸用于居中和避碰。E2E 应对真实 drag 的 boundingBox 中心做断言，并覆盖 zoom、pan、页面滚动、侧栏开合及多端口节点。
- [medium] Hosted Linux 只固定 runner 标签，未固定字形环境 (.github/workflows/visual-regression-nightly.yml:73-101)
  工作流使用 ubuntu-24.04 和 Playwright 系统依赖，但没有安装或校验确定字体；编辑器仍通过 system-ui 渲染多枚 Unicode 图标。9d9c07e7 自身已记录同一基线出现两种 fallback 字形，其中少数态产生约 5372 个差异像素。替换为“多数派”PNG没有消除双稳态，后续 runner 仍会间歇红，rerun 或再次换基线还可能掩盖真实布局回归。
  Recommendation: 优先把 palette/node glyph 改为确定性 inline SVG；否则随应用捆绑覆盖这些字符的 WOFF2、显式指定字体并等待 document.fonts.ready。视觉门再使用固定镜像/字体预检重新录制一次基线，禁止将 rerun 作为双稳态处置。

Next steps:
- 先修两条草稿数据安全阻断面，并补站内导航、离线重载和多标签恢复测试。
- 统一节点 footprint 后，用真实渲染框验证所有拖放坐标组合。
- 移除系统字体回退依赖，再从全新 Linux 环境重录并一次通过视觉门。

Codex session ID: 019f8779-e398-7e83-a969-fe2b889eddfe
Resume in Codex: codex resume 019f8779-e398-7e83-a969-fe2b889eddfe
