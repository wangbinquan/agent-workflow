// RFC-269 — 动作注册表：本 RFC 的核心资产，前后端唯一事实源。
//
// 一张表同时喂三个消费者，它们因此不可能对不齐：
//   - 前端 Inspector：渲染动作下拉（按 group 分组）与该动作的定型表单
//   - 校验器：必填字段、provider 是否支持该动作
//   - 执行器：拼出真正的 method / path / query / body
//
// `satisfies Record<CodeHostAction, CodeHostActionDef>` 让「新增动作/新增
// provider 却漏填映射」变成 typecheck 红，而不是运行期 404。
//
// 归一化的边界（用户拍板「统一动作名 + 各自映射」）：动作名与字段名 provider
// 无关，**真实不对称的地方如实暴露**而不是假装一样——
//   - GitHub 不支持 resolve 线程（REST 无此端点，`resolveReviewThread` 只在
//     GraphQL，且线程的 PRRT_ node id 在 REST 面根本拿不到）⇒ unsupported
//   - 触发流水线：GitLab 是 pipeline、GitHub 是 workflow_dispatch 且**必须**
//     指定工作流文件 ⇒ 多一个 `workflow` 字段，只对 GitHub 显示
//   - 列 job 的过滤维度两边根本不是一回事（GitLab 按 job 状态、GitHub 按
//     "只看最后一次尝试"）⇒ 两个独立字段，各自只对自家显示
//   - 指派：GitLab 吃数字 user id、GitHub 吃 login ⇒ 同一个字段，不同 hint
//     与不同 transform（强行归一只会让人填错）
//
// 外部依据 2026-08-12 复核，逐条见 design §4.2；未实证项列在 proposal §8。

import type { CodeHostProvider } from '../schemas/webhook'

export const CODE_HOST_ACTION_GROUPS = ['comment', 'mr', 'pipeline', 'read', 'custom'] as const
export type CodeHostActionGroup = (typeof CODE_HOST_ACTION_GROUPS)[number]

export const CODE_HOST_ACTIONS = [
  // comment
  'comment.reply-thread',
  'comment.create',
  'comment.create-inline',
  'comment.update',
  // RFC-304 AC-34 — the ISSUE equivalents of the three above.
  //
  // Separate actions rather than a scope switch on the existing ones, because
  // the existing ones are already configured in people's workflows and a field
  // that changes what a saved action addresses is a silent rewrite of their
  // configuration. The hosts differ here too: GitHub serves issue and pull
  // comments from ONE endpoint (`/issues/{n}/comments` — a pull request is an
  // issue), while GitLab has two genuinely different collections. Without
  // these, the platform could not comment on a GitLab issue at all, which is
  // what left `requirement` unable to answer the person who labelled it.
  'comment.create-issue',
  'comment.list-issue',
  'comment.update-issue',
  'thread.resolve',
  // RFC-304 — batch review publication. Deliberately three actions rather than
  // one "publish a review", because the two hosts are not the same shape:
  // GitLab builds drafts one at a time then publishes them together, GitHub
  // takes the whole review in a single request. Pretending otherwise would
  // force one of them through a model it does not have.
  'review.draft-create',
  'review.draft-publish',
  // 补偿删除。上面那段注释里写明「抢占或失败必须补偿删除，否则 MR 上留下一批永不
  // 发布的孤儿草稿」——这个动作就是那句话的执行面，`draft` 字段本来也是为它加的。
  'review.draft-discard',
  'review.submit',
  // mr
  'commit-status.set',
  'label.add',
  'assignee.set',
  'mr.approve',
  'mr.merge',
  'mr.create',
  // pipeline
  'pipeline.trigger',
  'pipeline.retry',
  'pipeline.cancel',
  'job.list',
  'job.log',
  // read
  'mr.get',
  'mr.diff',
  'mr.list',
  // RFC-304 §7.2 —— 回读 MR 上已有的评论。发布崩溃恢复要靠它把「已经发出去的」
  // 认回来（否则下一轮会把整批重发，正是台账存在的意义被崩溃反噬）；GitHub 侧
  // 还要靠它拿到每条评论的 id——`review.submit` 一次性提交整批，响应只回 review
  // 本身、不回每条评论的 id。
  'comment.list',
  'file.read',
  // 逃生舱
  'custom',
] as const
export type CodeHostAction = (typeof CODE_HOST_ACTIONS)[number]

/**
 * 定型表单的字段名（闭合集合）。闭合是为了让前端能用
 * `Record<CodeHostField, string>` 保证 i18n 漏写即 typecheck 红。
 */
export const CODE_HOST_FIELDS = [
  'project',
  'mr',
  // RFC-304: the issue number, kept distinct from `mr` on purpose. They are
  // different objects with overlapping numbering, and a form that called both
  // "mr" would let somebody address issue 412 believing they addressed merge
  // request 412 — which fails as a 404 at best and comments on a stranger's
  // change at worst.
  'issue',
  'thread',
  'comment',
  'comment_scope',
  'body',
  'position',
  // RFC-304: the whole review payload for GitHub's single-request submit, and
  // the draft id GitLab needs to delete one during compensation.
  'comments',
  'draft',
  'review_event',
  // The head sha a GitHub review is pinned to. Omitting it is not "let the host
  // decide" — GitHub then attaches the review to the PR's LATEST commit, so a
  // push landing mid-review moves every comment onto a revision the reviewer
  // never read, with the line numbers still computed from the one it did.
  'commit_id',
  'sha',
  'state',
  'context',
  'description',
  'target_url',
  'labels',
  'assignees',
  'ref',
  'workflow',
  'pipeline',
  'job',
  'job_scope',
  'job_filter',
  'path',
  'file_ref',
  'mr_state',
  'per_page',
  'source_branch',
  'target_branch',
  'title',
  'merge_method',
  'squash',
] as const
export type CodeHostField = (typeof CODE_HOST_FIELDS)[number]

/**
 * D22 —— 固定的两个输出端口。用户拍板 Q8：不做「可声明字段提取」，需要某个
 * 字段时在下游接一个脚本节点取，平台不再造第二套 JSON 路径语法。
 */
export const CODE_HOST_OUTPUT_PORTS = ['response', 'status'] as const
export type CodeHostOutputPort = (typeof CODE_HOST_OUTPUT_PORTS)[number]

export const CODE_HOST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type CodeHostMethod = (typeof CODE_HOST_METHODS)[number]

/** 破坏性方法：节点上必须显式勾选 `allowDestructive` 才能选（用户拍板 Q9）。 */
export const CODE_HOST_DESTRUCTIVE_METHODS: readonly CodeHostMethod[] = ['DELETE']

/**
 * 值变换。两家 API 对"同一件事"的参数形态不同，差异吸收在这里而不是让用户
 * 填两次。
 */
export type CodeHostTransform =
  | 'csv-array' // "a,b" -> ["a","b"]
  | 'csv-number-array' // "1,2" -> [1,2]（GitLab 的 assignee_ids）
  | 'integer' // "42" -> 42（GitHub 的 in_reply_to）
  | 'json-object' // 字符串 JSON -> 对象（position 原样回传）
  | 'status-state' // 统一三档 -> 各家 commit status 取值
  | 'mr-state' // 统一三档 -> 各家 MR 列表过滤取值
  | 'boolean' // "true"/"false" -> 布尔

export interface CodeHostParamMap {
  /** API 参数名。`'*'` = 把该值（对象）展开到 body 顶层。 */
  readonly api: string
  readonly from: { readonly field: CodeHostField } | { readonly literal: unknown }
  readonly transform?: CodeHostTransform
  /** 渲染为空时省略该参数（可选参数用；必填字段由校验器在更早的地方拦下）。 */
  readonly omitIfEmpty?: boolean
}

/** binding 的特殊语义开关。 */
export type CodeHostQuirk = 'followRedirectStripAuth'

/** 一条可以完整组装为 HTTP 请求的 provider binding。 */
export interface CodeHostRequestBinding {
  readonly method: CodeHostMethod
  /** path 模板；`{field}` 取字段值，`{__project__}` 取解析后的 project 定位段。 */
  readonly path: string
  readonly query?: readonly CodeHostParamMap[]
  readonly body?: readonly CodeHostParamMap[]
  readonly quirks?: readonly CodeHostQuirk[]
  /** 覆盖默认 Accept（如 GitHub 读文件要 raw）。 */
  readonly accept?: string
}

export interface CodeHostBinding extends CodeHostRequestBinding {
  /**
   * 同一动作在不同部署版本上的等价 API 写法，按新到旧排列。
   *
   * 执行器只会在当前候选明确返回 404 / 405 时尝试下一条；权限、参数、限流、
   * 服务端错误都不回退，避免用另一条请求掩盖真实失败。
   */
  readonly compatibilityFallbacks?: readonly CodeHostRequestBinding[]
}

export interface CodeHostUnsupported {
  readonly unsupported: true
  /** i18n key 后缀，落在 `codeHost.unsupported.<reasonKey>`。 */
  readonly reasonKey: string
}

export interface CodeHostFieldDef {
  readonly name: CodeHostField
  readonly control: 'text' | 'textarea' | 'select'
  /** select 的取值（value）。label 走 i18n，所以这里放 API 认识的原值。 */
  readonly options?: readonly string[]
  /** 在这些 provider 上必填；不在列 = 可选。 */
  readonly requiredFor: readonly CodeHostProvider[]
  /** 只对这些 provider 显示；缺省 = 全部。 */
  readonly onlyFor?: readonly CodeHostProvider[]
}

export interface CodeHostActionDef {
  readonly group: CodeHostActionGroup
  readonly fields: readonly CodeHostFieldDef[]
  readonly bindings: Readonly<Record<CodeHostProvider, CodeHostBinding | CodeHostUnsupported>>
}

const BOTH: readonly CodeHostProvider[] = ['gitlab', 'github']

// project 是每个动作都有的第一个字段：**留空则取当前任务的仓库**（用户拍板
// Q11）。因此它在任何 provider 上都不是"必填" —— 能不能推导出来是**运行期**的
// 事：仓库数量是启动参数（RFC-066）而不是工作流定义的属性，所以多仓任务由
// `resolveProjectFallback` 在运行期报「请显式填写」，保存期无从判定。
const PROJECT: CodeHostFieldDef = { name: 'project', control: 'text', requiredFor: [] }
const MR_REQUIRED: CodeHostFieldDef = { name: 'mr', control: 'text', requiredFor: BOTH }
const BODY_REQUIRED: CodeHostFieldDef = { name: 'body', control: 'textarea', requiredFor: BOTH }
const ISSUE_REQUIRED: CodeHostFieldDef = { name: 'issue', control: 'text', requiredFor: BOTH }

export const CODE_HOST_ACTION_DEFS = {
  // -------------------------------------------------------------------------
  // 评论类 —— 「自动回复评论流水线」的核心
  // -------------------------------------------------------------------------
  'comment.reply-thread': {
    group: 'comment',
    fields: [
      PROJECT,
      MR_REQUIRED,
      { name: 'thread', control: 'text', requiredFor: BOTH },
      BODY_REQUIRED,
    ],
    bindings: {
      gitlab: {
        method: 'POST',
        path: '/projects/{__project__}/merge_requests/{mr}/discussions/{thread}/notes',
        body: [{ api: 'body', from: { field: 'body' } }],
      },
      github: {
        method: 'POST',
        path: '/repos/{__project__}/pulls/{mr}/comments/{thread}/replies',
        body: [{ api: 'body', from: { field: 'body' } }],
        // GitHub 同时保留 create-review-comment + in_reply_to 的写法；一些旧版
        // Enterprise 部署没有上面的专用 replies 路由。
        compatibilityFallbacks: [
          {
            method: 'POST',
            path: '/repos/{__project__}/pulls/{mr}/comments',
            body: [
              { api: 'body', from: { field: 'body' } },
              { api: 'in_reply_to', from: { field: 'thread' }, transform: 'integer' },
            ],
          },
        ],
      },
    },
  },
  'comment.create': {
    group: 'comment',
    fields: [PROJECT, MR_REQUIRED, BODY_REQUIRED],
    bindings: {
      gitlab: {
        method: 'POST',
        path: '/projects/{__project__}/merge_requests/{mr}/notes',
        body: [{ api: 'body', from: { field: 'body' } }],
      },
      github: {
        // PR 的"普通评论"在 GitHub 就是 issue comment —— 同一个对象两种叫法。
        method: 'POST',
        path: '/repos/{__project__}/issues/{mr}/comments',
        body: [{ api: 'body', from: { field: 'body' } }],
      },
    },
  },
  'comment.create-inline': {
    group: 'comment',
    fields: [
      PROJECT,
      MR_REQUIRED,
      BODY_REQUIRED,
      // RFC-263/292 的 {{trigger.webhook.comment_position_json}} 就是**按各自建评论 API 的
      // 参数名打包、原样可回传**的，所以这里一个字段喂两家。
      { name: 'position', control: 'textarea', requiredFor: BOTH },
    ],
    bindings: {
      gitlab: {
        method: 'POST',
        path: '/projects/{__project__}/merge_requests/{mr}/discussions',
        body: [
          { api: 'body', from: { field: 'body' } },
          { api: 'position', from: { field: 'position' }, transform: 'json-object' },
        ],
      },
      github: {
        method: 'POST',
        path: '/repos/{__project__}/pulls/{mr}/comments',
        body: [
          { api: 'body', from: { field: 'body' } },
          // GitHub 的位置参数（commit_id / path / line / side）是 body 顶层字段，
          // 不像 GitLab 收在 position 对象里 ⇒ 展开。
          { api: '*', from: { field: 'position' }, transform: 'json-object' },
        ],
      },
    },
  },
  'comment.update': {
    group: 'comment',
    fields: [
      PROJECT,
      { name: 'mr', control: 'text', requiredFor: ['gitlab'] },
      { name: 'comment', control: 'text', requiredFor: BOTH },
      BODY_REQUIRED,
      // GitHub 的行内评论与普通评论是**两个端点**；值直接是 API 的路径段，
      // 人读的标签走 i18n。
      {
        name: 'comment_scope',
        control: 'select',
        options: ['pulls', 'issues'],
        requiredFor: ['github'],
        onlyFor: ['github'],
      },
    ],
    bindings: {
      gitlab: {
        method: 'PUT',
        path: '/projects/{__project__}/merge_requests/{mr}/notes/{comment}',
        body: [{ api: 'body', from: { field: 'body' } }],
      },
      github: {
        method: 'PATCH',
        path: '/repos/{__project__}/{comment_scope}/comments/{comment}',
        body: [{ api: 'body', from: { field: 'body' } }],
      },
    },
  },
  'comment.create-issue': {
    group: 'comment',
    fields: [PROJECT, ISSUE_REQUIRED, BODY_REQUIRED],
    bindings: {
      gitlab: {
        method: 'POST',
        path: '/projects/{__project__}/issues/{issue}/notes',
        body: [{ api: 'body', from: { field: 'body' } }],
      },
      github: {
        // The same endpoint `comment.create` uses for a pull request: on GitHub
        // a pull request IS an issue, so one path serves both. Kept as its own
        // action anyway, because the FIELD differs — this one takes an issue
        // number — and sharing the action would mean sharing the field name.
        method: 'POST',
        path: '/repos/{__project__}/issues/{issue}/comments',
        body: [{ api: 'body', from: { field: 'body' } }],
      },
    },
  },
  'comment.list-issue': {
    group: 'read',
    fields: [PROJECT, ISSUE_REQUIRED, { name: 'per_page', control: 'text', requiredFor: [] }],
    bindings: {
      // Plain notes rather than discussions: an issue has no diff, so there are
      // no review threads to fold — and `notes` returns the note id that
      // `comment.update-issue` needs, which the discussion listing does not.
      gitlab: {
        method: 'GET',
        path: '/projects/{__project__}/issues/{issue}/notes',
      },
      github: { method: 'GET', path: '/repos/{__project__}/issues/{issue}/comments' },
    },
  },
  'comment.update-issue': {
    group: 'comment',
    fields: [
      PROJECT,
      ISSUE_REQUIRED,
      { name: 'comment', control: 'text', requiredFor: BOTH },
      BODY_REQUIRED,
    ],
    bindings: {
      gitlab: {
        method: 'PUT',
        path: '/projects/{__project__}/issues/{issue}/notes/{comment}',
        body: [{ api: 'body', from: { field: 'body' } }],
      },
      github: {
        // GitHub addresses an issue comment by its own id, with no issue number
        // in the path — the number is still required on the form so the action
        // reads the same as its siblings and the caller cannot mix objects.
        method: 'PATCH',
        path: '/repos/{__project__}/issues/comments/{comment}',
        body: [{ api: 'body', from: { field: 'body' } }],
      },
    },
  },
  'thread.resolve': {
    group: 'comment',
    fields: [PROJECT, MR_REQUIRED, { name: 'thread', control: 'text', requiredFor: ['gitlab'] }],
    bindings: {
      gitlab: {
        method: 'PUT',
        path: '/projects/{__project__}/merge_requests/{mr}/discussions/{thread}',
        body: [{ api: 'resolved', from: { literal: true } }],
      },
      // 2026-08-07 查证：REST 面没有 resolve review thread；`resolveReviewThread`
      // 是 GraphQL mutation，且它要的 PRRT_ 线程 node id 在 REST 面拿不到 ——
      // 所以这不是"我们没做"，是 REST 结构上做不到。
      github: { unsupported: true, reasonKey: 'graphqlOnly' },
    },
  },

  // RFC-304 §7.2 — 批量发布。三个动作而非一个，因为两家的形状**真的不一样**，
  // 而本表的规矩是「真实不对称如实暴露」。
  //
  //   GitLab：逐条建 draft note（每条一个请求）→ 一次 bulk_publish。中间存在
  //           「草稿已建、尚未发布」的窗口，抢占或失败必须补偿删除，否则 MR 上
  //           留下一批**永不发布的孤儿草稿**，对用户可见且像 bot 跑了一半。
  //   GitHub：一次 POST /pulls/{n}/reviews 带 comments[]，要么整份落地要么什么
  //           都没有——**结构上不存在那个窗口**，所以它没有 draft 动作。
  'review.draft-create': {
    group: 'comment',
    fields: [
      PROJECT,
      MR_REQUIRED,
      BODY_REQUIRED,
      { name: 'position', control: 'textarea', requiredFor: ['gitlab'] },
    ],
    bindings: {
      gitlab: {
        method: 'POST',
        path: '/projects/{__project__}/merge_requests/{mr}/draft_notes',
        body: [
          { api: 'note', from: { field: 'body' } },
          { api: 'position', from: { field: 'position' }, transform: 'json-object' },
        ],
      },
      // 不是「我们没做」：GitHub 的 review 是单请求提交，没有可单独创建的草稿
      // 资源。要「先攒后发」就用 review.submit 一次带齐 comments[]。
      github: { unsupported: true, reasonKey: 'singleRequestReview' },
    },
  },
  'review.draft-publish': {
    group: 'comment',
    fields: [PROJECT, MR_REQUIRED],
    bindings: {
      gitlab: {
        method: 'POST',
        path: '/projects/{__project__}/merge_requests/{mr}/draft_notes/bulk_publish',
        body: [],
      },
      github: { unsupported: true, reasonKey: 'singleRequestReview' },
    },
  },
  'review.draft-discard': {
    group: 'comment',
    fields: [PROJECT, MR_REQUIRED, { name: 'draft', control: 'text', requiredFor: ['gitlab'] }],
    bindings: {
      gitlab: {
        method: 'DELETE',
        path: '/projects/{__project__}/merge_requests/{mr}/draft_notes/{draft}',
      },
      // 同 draft-create：GitHub 没有可单独创建的草稿资源，也就没有可删的。
      github: { unsupported: true, reasonKey: 'singleRequestReview' },
    },
  },
  'review.submit': {
    group: 'comment',
    fields: [
      PROJECT,
      MR_REQUIRED,
      BODY_REQUIRED,
      // 整份 review 的行级意见数组，按 GitHub 的 comments[] 形状打包。
      { name: 'comments', control: 'textarea', requiredFor: ['github'] },
      // 默认 COMMENT：本平台发的是**意见**，不代表人做批准决定——产品边界是
      // 「平台只承载输入问题与反问澄清，其余落在 MR 上」，替人按下 approve
      // 显然越界。APPROVE / REQUEST_CHANGES 仍列出，因为定制流程可能需要，
      // 但要由配置显式选择而不是平台默认。
      {
        name: 'review_event',
        control: 'select',
        options: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'],
        requiredFor: [],
        onlyFor: ['github'],
      },
      // 本轮检视所依据的 head sha。**留空不是「让平台自己挑」而是「挑最新那个」**
      // ——GitHub 明确规定 commit_id 缺省取 PR 最近一次提交。于是作者在检视跑
      // 期间又推了一次，意见就会挂到它从未读过的那个 revision 上，行号照 A 算、
      // 代码却是 B。RFC-304 一路把 baseline sha 钉死到这里，正是为了堵这最后一环。
      { name: 'commit_id', control: 'text', requiredFor: [], onlyFor: ['github'] },
    ],
    bindings: {
      // GitLab 没有「一次提交整份 review」的端点——它的等价物就是上面那对
      // draft_notes + bulk_publish，所以这里如实标 unsupported 而不是伪造一个
      // 会静默只发总览的映射。
      gitlab: { unsupported: true, reasonKey: 'useDraftNotes' },
      github: {
        method: 'POST',
        path: '/repos/{__project__}/pulls/{mr}/reviews',
        body: [
          { api: 'body', from: { field: 'body' } },
          { api: 'comments', from: { field: 'comments' }, transform: 'json-object' },
          { api: 'event', from: { field: 'review_event' } },
          { api: 'commit_id', from: { field: 'commit_id' }, omitIfEmpty: true },
        ],
      },
    },
  },

  // -------------------------------------------------------------------------
  // MR 状态类
  // -------------------------------------------------------------------------
  'commit-status.set': {
    group: 'mr',
    fields: [
      PROJECT,
      { name: 'sha', control: 'text', requiredFor: BOTH },
      // 三档覆盖"审计中 / 通过 / 不通过"的全部用例。两家各自多出来的档
      // （GitLab running·canceled、GitHub error）不进产品面：那只会制造
      // provider 特有知识，而它们表达不了三档表达不了的东西。
      {
        name: 'state',
        control: 'select',
        options: ['pending', 'success', 'failed'],
        requiredFor: BOTH,
      },
      { name: 'context', control: 'text', requiredFor: [] },
      { name: 'description', control: 'text', requiredFor: [] },
      { name: 'target_url', control: 'text', requiredFor: [] },
    ],
    bindings: {
      gitlab: {
        method: 'POST',
        path: '/projects/{__project__}/statuses/{sha}',
        query: [
          { api: 'state', from: { field: 'state' }, transform: 'status-state' },
          { api: 'name', from: { field: 'context' }, omitIfEmpty: true },
          { api: 'description', from: { field: 'description' }, omitIfEmpty: true },
          { api: 'target_url', from: { field: 'target_url' }, omitIfEmpty: true },
        ],
      },
      github: {
        method: 'POST',
        path: '/repos/{__project__}/statuses/{sha}',
        body: [
          { api: 'state', from: { field: 'state' }, transform: 'status-state' },
          { api: 'context', from: { field: 'context' }, omitIfEmpty: true },
          { api: 'description', from: { field: 'description' }, omitIfEmpty: true },
          { api: 'target_url', from: { field: 'target_url' }, omitIfEmpty: true },
        ],
      },
    },
  },
  'label.add': {
    group: 'mr',
    fields: [PROJECT, MR_REQUIRED, { name: 'labels', control: 'text', requiredFor: BOTH }],
    bindings: {
      gitlab: {
        method: 'PUT',
        path: '/projects/{__project__}/merge_requests/{mr}',
        body: [{ api: 'add_labels', from: { field: 'labels' } }],
      },
      github: {
        method: 'POST',
        path: '/repos/{__project__}/issues/{mr}/labels',
        body: [{ api: 'labels', from: { field: 'labels' }, transform: 'csv-array' }],
      },
    },
  },
  'assignee.set': {
    group: 'mr',
    fields: [PROJECT, MR_REQUIRED, { name: 'assignees', control: 'text', requiredFor: BOTH }],
    bindings: {
      gitlab: {
        method: 'PUT',
        path: '/projects/{__project__}/merge_requests/{mr}',
        // GitLab 要数字 user id；GitHub 要 login。同一个字段、不同 transform，
        // 差异写进 hint —— 它们本来就是不同的东西。
        body: [
          { api: 'assignee_ids', from: { field: 'assignees' }, transform: 'csv-number-array' },
        ],
      },
      github: {
        method: 'POST',
        path: '/repos/{__project__}/issues/{mr}/assignees',
        body: [{ api: 'assignees', from: { field: 'assignees' }, transform: 'csv-array' }],
      },
    },
  },
  'mr.approve': {
    group: 'mr',
    fields: [PROJECT, MR_REQUIRED, { name: 'body', control: 'textarea', requiredFor: [] }],
    bindings: {
      // 待实证（proposal §8-2）：approve 端点在 GitLab **Free 版**是否存在。
      // 实测 404 时改为 unsupported + reasonKey，而不是留一个必然失败的动作。
      gitlab: { method: 'POST', path: '/projects/{__project__}/merge_requests/{mr}/approve' },
      github: {
        method: 'POST',
        path: '/repos/{__project__}/pulls/{mr}/reviews',
        body: [
          { api: 'event', from: { literal: 'APPROVE' } },
          { api: 'body', from: { field: 'body' }, omitIfEmpty: true },
        ],
      },
    },
  },
  'mr.merge': {
    group: 'mr',
    fields: [
      PROJECT,
      MR_REQUIRED,
      { name: 'title', control: 'text', requiredFor: [] },
      {
        name: 'squash',
        control: 'select',
        options: ['true', 'false'],
        requiredFor: [],
        onlyFor: ['gitlab'],
      },
      {
        name: 'merge_method',
        control: 'select',
        options: ['merge', 'squash', 'rebase'],
        requiredFor: [],
        onlyFor: ['github'],
      },
    ],
    bindings: {
      gitlab: {
        method: 'PUT',
        path: '/projects/{__project__}/merge_requests/{mr}/merge',
        body: [
          { api: 'squash', from: { field: 'squash' }, transform: 'boolean', omitIfEmpty: true },
          { api: 'merge_commit_message', from: { field: 'title' }, omitIfEmpty: true },
        ],
      },
      github: {
        method: 'PUT',
        path: '/repos/{__project__}/pulls/{mr}/merge',
        body: [
          { api: 'merge_method', from: { field: 'merge_method' }, omitIfEmpty: true },
          { api: 'commit_title', from: { field: 'title' }, omitIfEmpty: true },
        ],
      },
    },
  },
  'mr.create': {
    group: 'mr',
    fields: [
      PROJECT,
      { name: 'source_branch', control: 'text', requiredFor: BOTH },
      { name: 'target_branch', control: 'text', requiredFor: BOTH },
      { name: 'title', control: 'text', requiredFor: BOTH },
      { name: 'description', control: 'textarea', requiredFor: [] },
    ],
    bindings: {
      gitlab: {
        method: 'POST',
        path: '/projects/{__project__}/merge_requests',
        body: [
          { api: 'source_branch', from: { field: 'source_branch' } },
          { api: 'target_branch', from: { field: 'target_branch' } },
          { api: 'title', from: { field: 'title' } },
          { api: 'description', from: { field: 'description' }, omitIfEmpty: true },
        ],
      },
      github: {
        method: 'POST',
        path: '/repos/{__project__}/pulls',
        body: [
          { api: 'head', from: { field: 'source_branch' } },
          { api: 'base', from: { field: 'target_branch' } },
          { api: 'title', from: { field: 'title' } },
          { api: 'body', from: { field: 'description' }, omitIfEmpty: true },
        ],
      },
    },
  },

  // -------------------------------------------------------------------------
  // Pipeline 类 —— 「修到绿」循环的原料
  // -------------------------------------------------------------------------
  'pipeline.trigger': {
    group: 'pipeline',
    fields: [
      PROJECT,
      { name: 'ref', control: 'text', requiredFor: BOTH },
      // GitHub 的 workflow_dispatch 必须指名工作流文件（GitLab 没有对应概念）。
      { name: 'workflow', control: 'text', requiredFor: ['github'], onlyFor: ['github'] },
    ],
    bindings: {
      gitlab: {
        method: 'POST',
        path: '/projects/{__project__}/pipeline',
        query: [{ api: 'ref', from: { field: 'ref' } }],
      },
      github: {
        method: 'POST',
        path: '/repos/{__project__}/actions/workflows/{workflow}/dispatches',
        body: [{ api: 'ref', from: { field: 'ref' } }],
      },
    },
  },
  'pipeline.retry': {
    group: 'pipeline',
    fields: [PROJECT, { name: 'pipeline', control: 'text', requiredFor: BOTH }],
    bindings: {
      gitlab: { method: 'POST', path: '/projects/{__project__}/pipelines/{pipeline}/retry' },
      // rerun-failed-jobs 而不是 rerun：这个动作服务的是"修到绿"循环，
      // 只想重跑失败的那些（proposal §8-4 列为待实证项）。
      github: {
        method: 'POST',
        path: '/repos/{__project__}/actions/runs/{pipeline}/rerun-failed-jobs',
      },
    },
  },
  'pipeline.cancel': {
    group: 'pipeline',
    fields: [PROJECT, { name: 'pipeline', control: 'text', requiredFor: BOTH }],
    bindings: {
      gitlab: { method: 'POST', path: '/projects/{__project__}/pipelines/{pipeline}/cancel' },
      github: { method: 'POST', path: '/repos/{__project__}/actions/runs/{pipeline}/cancel' },
    },
  },
  'job.list': {
    group: 'pipeline',
    fields: [
      PROJECT,
      { name: 'pipeline', control: 'text', requiredFor: BOTH },
      // 两家的"过滤"根本不是一回事：GitLab 按 job 状态过滤，GitHub 只能选
      // "只看最后一次尝试 / 全部"。做成一个字段会骗人，所以各给各的。
      {
        name: 'job_scope',
        control: 'select',
        options: ['failed', 'success', 'canceled', 'running'],
        requiredFor: [],
        onlyFor: ['gitlab'],
      },
      {
        name: 'job_filter',
        control: 'select',
        options: ['latest', 'all'],
        requiredFor: [],
        onlyFor: ['github'],
      },
    ],
    bindings: {
      gitlab: {
        method: 'GET',
        path: '/projects/{__project__}/pipelines/{pipeline}/jobs',
        query: [{ api: 'scope', from: { field: 'job_scope' }, omitIfEmpty: true }],
      },
      github: {
        method: 'GET',
        path: '/repos/{__project__}/actions/runs/{pipeline}/jobs',
        query: [{ api: 'filter', from: { field: 'job_filter' }, omitIfEmpty: true }],
      },
    },
  },
  'job.log': {
    group: 'pipeline',
    fields: [PROJECT, { name: 'job', control: 'text', requiredFor: BOTH }],
    bindings: {
      gitlab: { method: 'GET', path: '/projects/{__project__}/jobs/{job}/trace' },
      // 2026-08-07 查证：GitHub 这个端点返回 302 到有效期约 1 分钟的签名 URL
      // （pipelines.actions.githubusercontent.com）。这是全表**唯一**允许跟随
      // 重定向的 binding，且跟随时必须剥掉 Authorization —— 签名 URL 自带凭据，
      // 把我们的 token 送到第三方主机是教科书式的凭据外泄。
      github: {
        method: 'GET',
        path: '/repos/{__project__}/actions/jobs/{job}/logs',
        quirks: ['followRedirectStripAuth'],
      },
    },
  },

  // -------------------------------------------------------------------------
  // 读取类 —— 把代码平台侧的信息引进工作流当输入
  // -------------------------------------------------------------------------
  // MR 本体。RFC-304 需要它是因为 **GitLab 的行内评论 position 必须带
  // `diff_refs`（base_sha / start_sha / head_sha）**，而 `/diffs` 不返回这三个值
  // ——少了它们 GitLab 一律拒收 position，行级评论根本发不出去。顺带也是拿 title /
  // state / source_branch 的正路，省得从 `mr.list` 里捞。
  'mr.get': {
    group: 'read',
    fields: [PROJECT, MR_REQUIRED],
    bindings: {
      gitlab: { method: 'GET', path: '/projects/{__project__}/merge_requests/{mr}' },
      github: { method: 'GET', path: '/repos/{__project__}/pulls/{mr}' },
    },
  },
  'mr.diff': {
    group: 'read',
    fields: [PROJECT, MR_REQUIRED],
    bindings: {
      // 新版用 /diffs；/changes 自 GitLab 15.7 弃用，但旧部署/兼容实现可能只暴露
      // 后者。两者都不存在时仍以首选路径的错误为主诊断。
      gitlab: {
        method: 'GET',
        path: '/projects/{__project__}/merge_requests/{mr}/diffs',
        compatibilityFallbacks: [
          { method: 'GET', path: '/projects/{__project__}/merge_requests/{mr}/changes' },
        ],
      },
      github: { method: 'GET', path: '/repos/{__project__}/pulls/{mr}/files' },
    },
  },
  'comment.list': {
    group: 'read',
    fields: [
      PROJECT,
      MR_REQUIRED,
      { name: 'per_page', control: 'text', requiredFor: [] },
      // GitHub 的**行级**评论与 **MR 级**评论是两个端点（同 `comment.update`）。
      // 回读行级意见要 `pulls`；找平台自己那条总览评论要 `issues`——它是 MR 级
      // 评论，不在 `pulls` 那个列表里。GitLab 无此分裂：`/discussions` 两类都在。
      {
        name: 'comment_scope',
        control: 'select',
        options: ['pulls', 'issues'],
        requiredFor: ['github'],
        onlyFor: ['github'],
      },
    ],
    bindings: {
      // GitLab 的 discussion 是线程，`id` 就是 `thread.resolve` 要的那个；一条
      // discussion 下有多条 note，指纹标记在首条 note 的正文里。**注意**：改一条
      // 普通 note 要的是 `notes[0].id`（note id），不是 discussion id——两者不同，
      // 用错了 `comment.update` 会 404。
      gitlab: {
        method: 'GET',
        path: '/projects/{__project__}/merge_requests/{mr}/discussions',
      },
      github: { method: 'GET', path: '/repos/{__project__}/{comment_scope}/{mr}/comments' },
    },
  },
  'mr.list': {
    group: 'read',
    fields: [
      PROJECT,
      { name: 'mr_state', control: 'select', options: ['open', 'closed', 'all'], requiredFor: [] },
      { name: 'per_page', control: 'text', requiredFor: [] },
    ],
    bindings: {
      gitlab: {
        method: 'GET',
        path: '/projects/{__project__}/merge_requests',
        query: [
          { api: 'state', from: { field: 'mr_state' }, transform: 'mr-state', omitIfEmpty: true },
          { api: 'per_page', from: { field: 'per_page' }, omitIfEmpty: true },
        ],
      },
      github: {
        method: 'GET',
        path: '/repos/{__project__}/pulls',
        query: [
          { api: 'state', from: { field: 'mr_state' }, transform: 'mr-state', omitIfEmpty: true },
          { api: 'per_page', from: { field: 'per_page' }, omitIfEmpty: true },
        ],
      },
    },
  },
  'file.read': {
    group: 'read',
    fields: [
      PROJECT,
      { name: 'path', control: 'text', requiredFor: BOTH },
      { name: 'file_ref', control: 'text', requiredFor: [] },
    ],
    bindings: {
      gitlab: {
        method: 'GET',
        // 文件路径整段 percent-encode（渲染器对 path 位置一律 encodeURIComponent，
        // 所以 a/b.txt -> a%2Fb.txt 正是 GitLab 要的形态）。
        path: '/projects/{__project__}/repository/files/{path}/raw',
        query: [{ api: 'ref', from: { field: 'file_ref' }, omitIfEmpty: true }],
      },
      github: {
        method: 'GET',
        path: '/repos/{__project__}/contents/{path}',
        query: [{ api: 'ref', from: { field: 'file_ref' }, omitIfEmpty: true }],
        accept: 'application/vnd.github.raw',
      },
    },
  },

  // -------------------------------------------------------------------------
  // 逃生舱 —— 走节点的 request 字段，不查本表的 binding
  // -------------------------------------------------------------------------
  custom: {
    group: 'custom',
    fields: [PROJECT],
    bindings: {
      gitlab: { method: 'GET', path: '/' },
      github: { method: 'GET', path: '/' },
    },
  },
} as const satisfies Record<CodeHostAction, CodeHostActionDef>

// ---------------------------------------------------------------------------
// 派生读取器
// ---------------------------------------------------------------------------

export function isCodeHostAction(value: unknown): value is CodeHostAction {
  return typeof value === 'string' && (CODE_HOST_ACTIONS as readonly string[]).includes(value)
}

export function codeHostActionDef(action: CodeHostAction): CodeHostActionDef {
  return CODE_HOST_ACTION_DEFS[action]
}

export function isUnsupportedBinding(
  binding: CodeHostBinding | CodeHostUnsupported,
): binding is CodeHostUnsupported {
  return 'unsupported' in binding
}

/** 首选 binding + 按顺序尝试的部署版本兼容写法。 */
export function codeHostBindingCandidates(
  binding: CodeHostBinding,
): readonly CodeHostRequestBinding[] {
  return [binding, ...(binding.compatibilityFallbacks ?? [])]
}

/** 该 provider 是否支持该动作。 */
export function codeHostActionSupported(
  action: CodeHostAction,
  provider: CodeHostProvider,
): boolean {
  return !isUnsupportedBinding(CODE_HOST_ACTION_DEFS[action].bindings[provider])
}

/** 该动作在该 provider 下要渲染/校验的字段（已过滤 onlyFor）。 */
export function codeHostActionFields(
  action: CodeHostAction,
  provider: CodeHostProvider,
): readonly CodeHostFieldDef[] {
  // 显式加宽：`as const satisfies` 保留了每个字段的字面量类型，联合里那些没写
  // `onlyFor` 的成员上访问该属性会 TS2339。加宽到接口类型是这里唯一想要的。
  const fields: readonly CodeHostFieldDef[] = CODE_HOST_ACTION_DEFS[action].fields
  return fields.filter((f) => f.onlyFor === undefined || f.onlyFor.includes(provider))
}

/** 该动作在该 provider 下的必填字段名。 */
export function codeHostRequiredFields(
  action: CodeHostAction,
  provider: CodeHostProvider,
): readonly CodeHostField[] {
  return codeHostActionFields(action, provider)
    .filter((f) => f.requiredFor.includes(provider))
    .map((f) => f.name)
}

/** 按 group 分组的动作列表（UI 分组呈现的顺序源）。 */
export function codeHostActionsByGroup(): ReadonlyArray<{
  readonly group: CodeHostActionGroup
  readonly actions: readonly CodeHostAction[]
}> {
  return CODE_HOST_ACTION_GROUPS.map((group) => ({
    group,
    actions: CODE_HOST_ACTIONS.filter((a) => CODE_HOST_ACTION_DEFS[a].group === group),
  }))
}

/** 统一三档 commit status -> 各家取值。 */
export const CODE_HOST_STATUS_STATE_MAP: Readonly<
  Record<CodeHostProvider, Readonly<Record<string, string>>>
> = {
  gitlab: { pending: 'pending', success: 'success', failed: 'failed' },
  // GitHub 用 'failure'；写 'failed' 会 422。
  github: { pending: 'pending', success: 'success', failed: 'failure' },
}

/** 统一三档 MR 列表过滤 -> 各家取值。 */
export const CODE_HOST_MR_STATE_MAP: Readonly<
  Record<CodeHostProvider, Readonly<Record<string, string>>>
> = {
  gitlab: { open: 'opened', closed: 'closed', all: 'all' },
  github: { open: 'open', closed: 'closed', all: 'all' },
}
