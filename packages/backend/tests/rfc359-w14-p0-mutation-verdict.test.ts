// Compact Bun reporter transcripts from the observed historical mutations.
// IDs, stack prefixes and timings are normalized; no database/process runs here.
import { describe, expect, test } from 'bun:test'
import { PHASES, validatePhaseLog, type Phase } from '../../../scripts/rfc359-p0-mutations'

const diagnostics: Readonly<Record<string, readonly string[]>> = {
  'p0-12-protocol': [
    String.raw`error: expect(received).toContain(expected)
Expected to contain: "<workflow-clarify>"
Received: "## Workgroup output protocol\nThis is the worker turn.\nEmit only declared workgroup JSON ports in <workflow-output nonce=\"nonce-1\">.\nAllowed ports: wg_result, wg_messages, wg_tasks_add."
      at <anonymous> (/repo/packages/backend/tests/rfc359-t7e-workgroup-clarify-ask-gate.test.ts:260:43)`,
  ],
  'p0-12-budget': [
    `357 |     expect(worker.clarifyEnabled).toBe(false)
error: expect(received).toBe(expected)
Expected: false
Received: true
      at <anonymous> (/repo/packages/backend/tests/rfc359-t7e-workgroup-clarify-ask-gate.test.ts:357:35)`,
  ],
  'p0-5': [
    `ConflictError: node_run run-1 is terminal ('failed'); refuse to overwrite (clarify-deferred-answer)
    code: "illegal-node-run-transition"
      at setNodeRunStatusTx (/repo/packages/backend/src/modules/task-execution/infrastructure/nodeRunLifecycleTransition.ts:88:11)`,
  ],
  'p0-6': [
    `ValidationError: stored definition is not JSON
  status: 422,
 details: { error: "JSON Parse error: Unexpected EOF" },
    code: "workflow-definition-corrupt"
      at workflowFromPersistenceRow (/repo/packages/backend/src/modules/resource-catalog/infrastructure/workflowPersistence.ts:45:11)`,
    `error: expect(received).toMatchObject(expected)
- {
-   "status": 409,
- }
+ [ValidationError: stored definition is not JSON]
      at <anonymous> (/repo/packages/backend/tests/rfc359-t6-corrupt-workflow-delete.test.ts:89:15)`,
  ],
  'p0-7': [
    `error: deferred-question-dispatcher-not-bound
      at autoDispatchDeferredQuestions (/repo/packages/backend/tests/fixtures/rfc359-p0-mutations.ts:16:42)
      at <anonymous> (/repo/packages/backend/tests/rfc359-t1-deferred-question-dispatch.test.ts:47:15)`,
    `134 |         expect(task, task?.errorMessage ?? undefined).toMatchObject({
error: deferred-question-dispatcher-not-bound
-   "status": "done",
+   "status": "failed",
+   "errorMessage": "deferred-question-dispatcher-not-bound",
      at <anonymous> (/repo/packages/backend/tests/rfc359-w5-t21b-execution-chain.test.ts:134:55)`,
  ],
  'p0-9-launchers': ['agent', 'script'].map(
    (kind) => `error: {"blockCode":"${kind}-launcher-not-wired"}
-     "handled": "action-launched",
+     "handled": "action-launch-failed",
-   "stop": "async-boundary",
+   "stop": "failed-or-blocked",
      at <anonymous> (/repo/packages/backend/tests/rfc359-w14-legacy-mission-execution.test.ts:380:11)`,
  ),
  'p0-9-terminal-observer': ['agent', 'script'].map(
    (kind) => `422 |         expect(settlement).toEqual({
error: expect(received).toEqual(expected)
-   "attemptStatus": "validated",
-   "wakeDeliveryKeys": [
-     "${kind}-exec:task-1",
-   ],
+   "attemptStatus": "claimed",
+   "wakeDeliveryKeys": [],
      at <anonymous> (/repo/packages/backend/tests/rfc359-w14-legacy-mission-execution.test.ts:422:28)`,
  ),
  'p0-11-barrier': [
    `108 |       expect((await listActiveOps(db)).map((op) => op.phase)).toEqual([])
error: expect(received).toEqual(expected)
- []
+ [
+   "intent",
+ ]
      at <anonymous> (/repo/packages/backend/tests/rfc359-t7d-postgresql-skill-catalog-boot.test.ts:108:63)`,
  ],
  'p0-11-reverify': [
    `169 |       expect(isSkillBootVerified(skill.id)).toBe(true)
error: expect(received).toBe(expected)
Expected: true
Received: false
      at <anonymous> (/repo/packages/backend/tests/rfc359-t7d-postgresql-skill-catalog-boot.test.ts:169:45)`,
  ],
  'p0-10-unsettled-release': [
    `[rfc359-p0-10-state] {"taskId":"t7b_task-1","ownerState":"claimed","unresolvedEffectCount":1}
TaskExecutionError: task 't7b_task-1' still has unresolved effects or resource holds
  status: 409,
    code: "task-execution-recovery-required"
      at <anonymous> (/repo/packages/backend/src/modules/task-execution/infrastructure/taskOwnershipPersistence.ts:381:15)`,
  ],
  'p0-3-boot-omitted': [
    `135 |     expect(recoveredOwner?.state).toBe('released')
error: expect(received).toBe(expected)
Expected: "released"
Received: "claimed"
      at <anonymous> (/repo/packages/backend/tests/rfc359-w3-t4-boot-recovery.test.ts:135:35)`,
  ],
  'p0-4-revoked-reconcile': [
    `193 |     expect(state).toEqual({
error: expect(received).toEqual(expected)
  {
    "ownerState": "revoked",
-   "reapedRuns": [
-     "run-1",
-   ],
-   "reapedTasks": [
-     "task-1",
-   ],
-   "runStatus": "interrupted",
-   "taskStatus": "interrupted",
+   "reapedRuns": [],
+   "reapedTasks": [],
+   "runStatus": "running",
+   "taskStatus": "running",
  }
      at <anonymous> (/repo/packages/backend/tests/rfc359-w3-t4-boot-recovery.test.ts:193:19)`,
    `528 |     expect(state).toEqual({
error: expect(received).toEqual(expected)
  {
-   "auditOutcome": "success",
-   "auditOutcomeMessage": null,
-   "lifecycleRevision": 2,
+   "auditOutcome": "apply-failed",
+   "auditOutcomeMessage": "ownerless task mutation refused durable owner for 'task-1'",
+   "eventTypes": [],
+   "lifecycleRevision": 1,
    "nodeRunStatus": "pending",
    "ownerState": "revoked",
+   "repaired": [],
+   "resolvedAt": null,
+   "resumed": [],
+   "skipped": [
      {
+       "reason": "apply-failed-or-lease-held",
        "taskId": "task-1",
      },
    ],
    "taskId": "task-1",
-   "taskStatus": "interrupted",
+   "taskStatus": "pending",
  }
      at <anonymous> (/repo/packages/backend/tests/rfc359-w8-auto-repair-conformance.test.ts:528:19)`,
  ],
}

function phase(id: string): Phase {
  const found = PHASES.find((item) => item.id === id)
  if (!found) throw new Error(`Missing mutation phase ${id}`)
  return found
}

function transcript(id: string, provider = 'sqlite'): string {
  const selected = phase(id)
  return [
    'bun test v1.3.13 (bf2e2cec)',
    ...(selected.mutation ? [`[rfc359-p0-mutation] installed=${selected.mutation}`] : []),
    ...selected.passes.map((item) => `(pass) ${item.suite} [${provider}] > ${item.name} [12.34ms]`),
    ...selected.failures.flatMap(({ test: item }, index) => [
      diagnostics[id]![index]!,
      `(fail) ${item.suite} [${provider}] > ${item.name} [12.34ms]`,
    ]),
    '',
    ` ${selected.passes.length} pass`,
    ` ${selected.failures.length} fail`,
    ' 10 expect() calls',
    '',
  ].join('\n')
}

function verdict(id: string, log: string, exitCode = 1) {
  return validatePhaseLog(log, exitCode, phase(id), 'sqlite')
}

describe('RFC-359 AC7 historical mutation verdict', () => {
  test('accepts current controls and each observed failure transcript, including ANSI output', () => {
    for (const item of PHASES) {
      const code = item.mutation ? 1 : 0
      expect(verdict(item.id, transcript(item.id), code).valid).toBe(true)
      expect(verdict(item.id, `\u001b[32m${transcript(item.id)}\u001b[0m`, code).valid).toBe(true)
      expect(
        validatePhaseLog(transcript(item.id, 'postgresql'), code, item, 'postgresql').valid,
      ).toBe(true)
    }
  })

  test('rejects arbitrary exit 1 and a mutant process that exits successfully', () => {
    expect(verdict('current-before', transcript('current-before'), 1).valid).toBe(false)
    expect(verdict('p0-12-protocol', transcript('p0-12-protocol'), 0).valid).toBe(false)
    expect(verdict('p0-12-protocol', transcript('p0-12-protocol'), 2).valid).toBe(false)
  })

  test('rejects missing or wrong provider and missing or wrong test names', () => {
    const log = transcript('p0-12-protocol')
    for (const changed of [
      log.replaceAll(' [sqlite]', ''),
      log.replaceAll(' [sqlite]', ' [postgresql]'),
      log.replace(/^\(fail\) .+\n/m, ''),
      log.replace(/^\(fail\) .+$/m, '(fail) unrelated test'),
      log.replace(/^\(pass\) .+\n/m, ''),
    ])
      expect(verdict('p0-12-protocol', changed).valid).toBe(false)
  })

  test('rejects hook/import errors even alongside the expected failures', () => {
    const log = transcript('p0-12-protocol')
    for (const extra of [
      '# Unhandled error between tests\nerror: Cannot find package mutant',
      ' 1 error',
      '(fail) RFC-359 fixture [sqlite] > (unnamed)',
    ])
      expect(verdict('p0-12-protocol', `${log}\n${extra}\n`).valid).toBe(false)
    expect(
      verdict(
        'p0-5',
        'bun test\n# Unhandled error between tests\nerror: NameTooLong\n 0 pass\n 1 fail\n 1 error\n',
      ).valid,
    ).toBe(false)
  })

  test('rejects each wrong assertion or database error while retaining the expected failing name', () => {
    const changes = [
      [
        'p0-12-protocol',
        'Expected to contain: "<workflow-clarify>"',
        'Expected to contain: "other"',
      ],
      ['p0-12-budget', 'Expected: false', 'Expected: true'],
      ['p0-5', 'code: "illegal-node-run-transition"', 'code: "unrelated"'],
      ['p0-6', 'error: "JSON Parse error: Unexpected EOF"', 'error: "unrelated"'],
      ['p0-6', '+ [ValidationError: stored definition is not JSON]', '+ [TypeError: unrelated]'],
      ['p0-7', '+   "status": "failed",', '+   "status": "interrupted",'],
      [
        'p0-7',
        '+   "errorMessage": "deferred-question-dispatcher-not-bound",',
        '+   "errorMessage": "unrelated",',
      ],
      ['p0-9-launchers', 'agent-launcher-not-wired', 'unrelated-launch-failure'],
      ['p0-9-launchers', '+     "handled": "action-launch-failed",', '+     "handled": "blocked",'],
      [
        'p0-9-terminal-observer',
        '+   "attemptStatus": "claimed",',
        '+   "attemptStatus": "rejected",',
      ],
      [
        'p0-9-terminal-observer',
        '+   "wakeDeliveryKeys": [],',
        '+   "wakeDeliveryKeys": ["agent-exec:task-1"],',
      ],
      ['p0-11-barrier', '+   "intent",', '+   "fs-staged",'],
      ['p0-11-reverify', 'Received: false', 'Received: true'],
      ['p0-10-unsettled-release', '"ownerState":"claimed"', '"ownerState":"released"'],
      ['p0-10-unsettled-release', '"unresolvedEffectCount":1', '"unresolvedEffectCount":0'],
      ['p0-10-unsettled-release', 'code: "task-execution-recovery-required"', 'code: "unrelated"'],
      ['p0-10-unsettled-release', 'taskOwnershipPersistence.ts', 'unrelated-fixture.ts'],
      ['p0-3-boot-omitted', 'Received: "claimed"', 'Received: "revoked"'],
      ['p0-3-boot-omitted', 'recoveredOwner?.state', 'unrelated?.state'],
      ['p0-4-revoked-reconcile', '"ownerState": "revoked"', '"ownerState": "claimed"'],
      ['p0-4-revoked-reconcile', '+   "reapedRuns": [],', '+   "reapedRuns": ["run-1"],'],
      ['p0-4-revoked-reconcile', '+   "reapedTasks": [],', '+   "reapedTasks": ["task-1"],'],
      ['p0-4-revoked-reconcile', '+   "runStatus": "running",', '+   "runStatus": "done",'],
      ['p0-4-revoked-reconcile', '+   "taskStatus": "running",', '+   "taskStatus": "done",'],
    ] as const
    for (const [id, from, to] of changes) {
      expect(verdict(id, transcript(id).replace(from, to)).valid).toBe(false)
    }
  })

  test('rejects timeout or unrelated exception in place of each observed omission failure', () => {
    for (const id of [
      'p0-9-launchers',
      'p0-9-terminal-observer',
      'p0-11-barrier',
      'p0-11-reverify',
      'p0-10-unsettled-release',
      'p0-3-boot-omitted',
      'p0-4-revoked-reconcile',
    ]) {
      for (const replacement of [
        'error: Test timed out after 60000ms',
        'TypeError: Cannot read properties of undefined',
      ]) {
        expect(verdict(id, transcript(id).replace(diagnostics[id]![0]!, replacement)).valid).toBe(
          false,
        )
      }
      expect(verdict(id, `${transcript(id)}\nerror: Test timed out after 60000ms\n`).valid).toBe(
        false,
      )
      expect(verdict(id, `${transcript(id)}\nTimeoutError: fixture deadline\n`).valid).toBe(false)
    }
  })

  test('requires the release witness exactly once and linked to the same failing task', () => {
    const id = 'p0-10-unsettled-release'
    const log = transcript(id)
    const witness = log.match(/^\[rfc359-p0-10-state\] .+$/m)![0]
    for (const changed of [
      log.replace(`${witness}\n`, ''),
      `${log}\n${witness}\n`,
      log.replace('"taskId":"t7b_task-1"', '"taskId":"unrelated-task"'),
      `${witness}\n${log.replace(`${witness}\n`, '')}`,
    ])
      expect(verdict(id, changed).valid).toBe(false)
    expect(
      verdict('current-before', `${transcript('current-before')}\n${witness}\n`, 0).valid,
    ).toBe(false)
  })

  test('requires the S4 historical refusal, same task, unchanged owner/node and absent durable effects', () => {
    const id = 'p0-4-revoked-reconcile'
    const log = transcript(id)
    const s4 = diagnostics[id]![1]!
    for (const [from, to] of [
      ['+   "auditOutcome": "apply-failed",', '+   "auditOutcome": "preflight-stale",'],
      ['ownerless task mutation refused durable owner', 'unrelated transaction error'],
      ["for 'task-1'", "for 'unrelated-task'"],
      ['\n    "taskId": "task-1",\n', '\n    "taskId": "unrelated-task",\n'],
      ['+   "eventTypes": [],', '+   "eventTypes": ["task.lifecycle-transitioned.v1"],'],
      ['-   "lifecycleRevision": 2,', '-   "lifecycleRevision": 3,'],
      ['+   "lifecycleRevision": 1,', '+   "lifecycleRevision": 2,'],
      ['"nodeRunStatus": "pending"', '"nodeRunStatus": "interrupted"'],
      ['"ownerState": "revoked"', '"ownerState": "released"'],
      ['+   "repaired": [],', '+   "repaired": ["unrelated"],'],
      ['+   "resolvedAt": null,', '+   "resolvedAt": 1788600000000,'],
      ['+   "resumed": [],', '+   "resumed": ["task-1"],'],
      ['+   "skipped": [', '+   "skipped": []'],
      ['apply-failed-or-lease-held', 'no-single-eligible'],
      ['-   "taskStatus": "interrupted",', '-   "taskStatus": "done",'],
      ['+   "taskStatus": "pending",', '+   "taskStatus": "running",'],
      ['rfc359-w8-auto-repair-conformance.test.ts', 'unrelated-fixture.ts'],
    ] as const)
      expect(verdict(id, log.replace(s4, s4.replace(from, to))).valid).toBe(false)
    for (const replacement of [
      'error: Test timed out after 5000ms',
      'TypeError: Cannot read properties of undefined',
      '',
    ])
      expect(verdict(id, log.replace(s4, replacement)).valid).toBe(false)
    expect(verdict(id, `${s4}\n${log.replace(s4, '')}`).valid).toBe(false)
  })

  test('requires diagnostics to precede their own failing test, not a different result', () => {
    const log = transcript('p0-7')
    const rootDiagnostic = diagnostics['p0-7']![1]!
    const moved = `${rootDiagnostic}\n${log.replace(rootDiagnostic, '')}`
    expect(verdict('p0-7', moved).valid).toBe(false)
  })

  test('rejects skip/todo, extra failures and duplicate successful results', () => {
    const log = transcript('p0-12-protocol')
    for (const changed of [
      log.replace('(pass)', '(skip)'),
      log.replace('(pass)', '(todo)'),
      `${log}(fail) unrelated test\n`,
      `${log}${log.match(/^\(pass\) .+$/m)![0]}\n`,
    ])
      expect(verdict('p0-12-protocol', changed).valid).toBe(false)
  })

  test('rejects missing, duplicate, wrong or unexpected mutation markers', () => {
    const log = transcript('p0-12-protocol')
    const marker = '[rfc359-p0-mutation] installed=p0-12-protocol'
    for (const changed of [
      log.replace(`${marker}\n`, ''),
      log.replace(marker, `${marker}\n${marker}`),
      log.replace(marker, '[rfc359-p0-mutation] installed=p0-5'),
    ])
      expect(verdict('p0-12-protocol', changed).valid).toBe(false)
    expect(verdict('current-before', `${marker}\n${transcript('current-before')}`, 0).valid).toBe(
      false,
    )
  })

  test('rejects missing or inconsistent completion counts', () => {
    const log = transcript('p0-12-protocol')
    for (const changed of [
      log.replace(' 1 fail', ' 0 fail'),
      log.replace(' 1 pass', ' 0 pass'),
      log.replace(' 10 expect() calls\n', ''),
      `${log} 1 fail\n`,
    ])
      expect(verdict('p0-12-protocol', changed).valid).toBe(false)
  })
})
