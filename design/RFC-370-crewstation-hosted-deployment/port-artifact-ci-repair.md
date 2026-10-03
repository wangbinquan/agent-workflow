# RFC-370 端口归档确切 SHA CI 修复

基线为已发布 34e49589e9bc26c6ea9f3da8a1f9f90f367a29c6。Windows job111308245923、主 CI Ubuntu10 job111308246358/mac3 job111308246457 的原完整日志保留。实际 runner/review/HTTP 与所选内容效果在 PostgreSQL、SQLite 下已通过，以下修复仍须新确切 SHA hosted CI 验证，不能关闭完整 A-G/RFC370。

## 限定修复

1. 夹具 invoke 接受 Readonly<MemoryPortArtifactContent>，匹配 Object.freeze 后的公共结构；不强转、不复制实例，原型方法及私有 receiver 原样执行。
2. 真实 HTTP 根夹具补必需 dbVersion:17，与其它 provider 根一致；同一个 app.request 用 Promise.resolve 归一化 Response | Promise<Response>，继续保留 held ACK 前后的全部断言。
3. 三个 runNode 原 AST 遍历顺序准确断言 opts.portArtifacts、state.opts.portArtifacts、opts.portArtifacts，仍限定三处且逐一验证所选 operations。
4. 真实 HTTP 根有两次 mountPortArtifactRoutes，改为同时准确断言 input.taskExecution.portArtifacts 与 deps，不省略任何实际根；其余 PG/HTTP/重选优先级断言全部保持。
5. 从 task-execution/public/types.ts 只移除没有 public consumer 的 PortArtifactLinkTarget 单独重导出。原 application ports 的声明、完整 PortArtifactContentEffects.linkTarget 返回类型与原政策/实现保持。现有公开 effects 可直接获得完整嵌套返回类型，无需独立别名；不增加债务条款、不放宽 census/opaque/C2 判据。

## 验证和发布

源码仅这两个 owned 文件，原测试名称、时限、held ACK 和行为断言全部保持；两处 AST oracle 改正只使原定位准确，第二处扩展覆盖两实际调用。现有 C2 账本与完整 effects 回归继续约束公开面和运行合同，不新增镜像测试，不改原零 consumer 账本。

独立有限设计检视先行，源码完成再独立 SOURCE2 检视。只进行目标 format/lint 与纯 AST/字节/JSON 证明，不运行本机 AW test/typecheck/build/service。生产 export 改动后，取得共享清单窗口再以 SOURCE2 + exact committed 非 owned 内容调用一次原规则 census；检视实际投影，保留并行输出。共享 main 正常小提交、精确路径、真实署名，推送后以新确切 SHA hosted CI 为最终依据。

## 2026-10-04 端口归档确切 SHA CI 修复

已发布 34e49589e9bc26c6ea9f3da8a1f9f90f367a29c6 的主 CI37158988630 completed/failure（35 success、15 failure），Windows37158988639 completed/failure；maintenance37158988628 与 OpenCode37158988629 completed/success。全部原完整日志和终态保留。四个后端失败作业只重复本批两处 AST oracle 与零 consumer public 别名；Typecheck 也包含本批 Readonly/HTTP 夹具错误。并行观测 Typecheck、三个 frontend shard3 与六个观测 E2E 作业已按实际日志归属协调，不修改其 WIP，不记整套通过。

有限 CI-REPAIR-DESIGN 与独立 SOURCE2 均 PASS；源码指纹 51ddb4adf2cbcb5e15971b61ff7fa97f3c1405fac563f685fd28a86f54ce16cd。仅两个 owned 文件六处修正：Readonly 夹具接收、dbVersion17、同一 HTTP Response/Promise 归一化、准确三 runNode 顺序、同时检查两真实 mount、删除无消费者的 PortArtifactLinkTarget 独立 public reexport。内部完整效果合同、原 receiver、全部68个expect操作数除两 mount 覆盖强化的一处、9个测试名称/预算及 ACK 行为保留；原 C2 账本测试不改。

共享清单基于并行已发布 a3f7bfc2559114ab7ac9bc42f33ebf147c8ad5c9，加冻结 SOURCE2、四份 exact committed 原规则生成一次。sourceDigest 为 sha256:a897ad0775a6e2cdd914c32029d75e7f8830987ae1b0028e4baad4b8e3d52597。真实投影仅移除一个 public symbol（1101→1100）及其四个递归字段；其它 collections、129项原有序账本/why、required SPI、target edges、implementation SCC、guard 与债务记录保持。不新增 growth permit 或退役提交；C2 两向精确相等由原规则的纯 JSON/源码计数证明。

本机仅定向 format/lint、纯 AST/字节/JSON 与原 census，未运行 AW test/typecheck/build/service。正式修复仍须新的确切 SHA hosted CI。完整 A1–A8/AC00/A-G、独立 CS adapters 和 B/M0–M4 按已批准顺序继续；尚无 AW-in-CS 实际部署，不关闭 RFC。
