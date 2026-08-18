// RFC-310 —— 测试用 requirement adapter（真实外部程序）。
//
// 平台的 adapter runner 以子进程方式执行它：cwd=one-shot sink、env 只有
// PATH/HOME/TMPDIR/AW_ADAPTER_SINK/AW_EXTERNAL_ID/AW_REQUIREMENT_MOCK_URL。
// 它从 requirement mock 下载元数据与逐个文件（大文件用 curl 子进程直接落盘
// ——Bun fetch 对快生产者不背压，见 dev-gotchas），最后向 stdout 输出一行
// `aw-adapter@1` envelope。`--evil-escape` 是测试模式：尝试往 sink 外写文件，
// 供 safe-walk/路径边界负向用例使用。

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface MockFileMeta {
  fileId: string
  name: string
  role: string
  mediaType: string
  bytes: number
}

async function curlToFile(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const proc = Bun.spawn({
    cmd: ['curl', '-sS', '--fail', '-o', dest, url],
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const exit = await proc.exited
  if (exit !== 0) {
    throw new Error(`curl failed (${exit}): ${await new Response(proc.stderr).text()}`)
  }
}

async function main(): Promise<number> {
  const [mode, argument] = process.argv.slice(2)
  const sink = process.env.AW_ADAPTER_SINK
  const mockUrl = process.env.AW_REQUIREMENT_MOCK_URL
  if (!sink || !mockUrl) {
    console.error('missing AW_ADAPTER_SINK / AW_REQUIREMENT_MOCK_URL')
    return 2
  }

  if (mode === '--acquire') {
    const externalId = argument ?? process.env.AW_EXTERNAL_ID
    if (!externalId) {
      console.error('missing external id')
      return 2
    }
    const metaRes = await fetch(`${mockUrl}/requirements/${encodeURIComponent(externalId)}`)
    if (metaRes.status === 404) {
      console.error(`requirement not found: ${externalId}`)
      return 4
    }
    if (metaRes.status !== 200) {
      console.error(`metadata fetch failed: ${metaRes.status}`)
      return 5
    }
    const meta = (await metaRes.json()) as {
      revision: string
      title: string
      files: MockFileMeta[]
    }
    if (process.env.AW_ADAPTER_SLEEP_MS !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.AW_ADAPTER_SLEEP_MS)))
    }
    for (const file of meta.files) {
      await curlToFile(
        `${mockUrl}/requirements/${encodeURIComponent(externalId)}/files/${encodeURIComponent(file.fileId)}`,
        join(sink, 'files', file.name),
      )
    }
    if (process.env.AW_ADAPTER_EVIL === 'escape') {
      // 攻击模式：向 sink 外写文件。无 OS 沙箱（2026-08-18 裁决），写本身拦不
      // 住——防线是 safe import 只扫 sink 内，逃逸文件永远进不了 bundle。
      writeFileSync(join(sink, '..', 'escaped.txt'), 'should never be imported\n')
    }
    if (process.env.AW_ADAPTER_EVIL === 'symlink') {
      // 攻击模式：sink 内放符号链接（safe import 必须整包拒收）。
      symlinkSync('/etc/hosts', join(sink, 'files', 'sneaky-link'))
    }
    if (process.env.AW_ADAPTER_EVIL === 'bad-envelope') {
      console.log('this is not a valid envelope')
      return 0
    }
    console.log(
      JSON.stringify({
        protocol: 'aw-adapter@1',
        operation: 'acquire',
        sourceRevision: meta.revision,
        title: meta.title,
        files: meta.files.map((f) => ({ relativePath: `files/${f.name}`, role: f.role })),
      }),
    )
    return 0
  }

  if (mode === '--writeback-questions') {
    const externalId = process.env.AW_EXTERNAL_ID
    const questionsJson = process.env.AW_ADAPTER_QUESTIONS ?? '{"questions":[]}'
    const res = await fetch(
      `${mockUrl}/requirements/${encodeURIComponent(externalId ?? '')}/questions`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: questionsJson },
    )
    if (res.status !== 201) {
      console.error(`writeback failed: ${res.status}`)
      return 5
    }
    const body = (await res.json()) as { correlationId: string }
    console.log(
      JSON.stringify({
        protocol: 'aw-adapter@1',
        operation: 'questions.writeback',
        correlationRef: body.correlationId,
      }),
    )
    return 0
  }

  if (mode === '--collect-answers') {
    const externalId = process.env.AW_EXTERNAL_ID
    const correlationRef = argument
    if (!correlationRef) {
      console.error('missing correlation ref')
      return 2
    }
    const res = await fetch(
      `${mockUrl}/requirements/${encodeURIComponent(externalId ?? '')}/questions/${encodeURIComponent(correlationRef)}/answers`,
    )
    if (res.status !== 200) {
      console.error(`collect failed: ${res.status}`)
      return 5
    }
    const body = (await res.json()) as {
      complete: boolean
      answerRevision?: string
      answers?: { questionId: string; answer: string }[]
    }
    console.log(
      JSON.stringify({
        protocol: 'aw-adapter@1',
        operation: 'answers.collect',
        complete: body.complete,
        answerRevision: body.answerRevision ?? null,
        answers: body.answers ?? [],
      }),
    )
    return 0
  }

  console.error(`unknown mode: ${mode}`)
  return 2
}

process.exit(await main())
