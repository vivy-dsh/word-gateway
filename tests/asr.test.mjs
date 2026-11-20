import assert from 'node:assert/strict'
import test from 'node:test'

import { createTranscribe, HubError } from '../src/speak.mjs'
import { transcribeWithDashscope, transcriptOf, toAudioDataUrl } from '../src/adapters/dashscope-asr.mjs'

/**
 * 识别的契约分两层：
 * - 适配器（dashscope-asr.mjs）：形状对不对——data URL、parameters、字段提取、网络重试；
 * - 服务（createTranscribe）：谁能不能用——插槽、适配器、音频、凭据，失败带 status + code。
 *
 * 这里全程不发真请求：适配器用假的 globalThis.fetch，服务层注入假适配器。
 */

const SLOT = { capability: 'asr', kind: 'dashscope', baseURL: 'https://example.invalid', model: 'qwen-audio-3.0-asr-flash', authRef: 'DASHSCOPE_API_KEY' }
const WAV = Buffer.alloc(64, 3)
const RESULT = { text: '你好呀', model: 'qwen-audio-3.0-asr-flash', requestId: 'req-1', durationMs: 1200, audioSeconds: 0.9 }

function build({ bindings = [SLOT], store = { DASHSCOPE_API_KEY: 'sk-test' }, transcriber } = {}) {
  const calls = []
  const transcribe = createTranscribe({
    registry: { resolve: () => bindings },
    credentials: { resolve: async ref => (store[ref] ? { value: store[ref], source: 'test' } : undefined) },
    transcribers: { asr: transcriber ?? (async input => { calls.push(input); return RESULT }) },
  })
  return { transcribe, calls }
}

async function rejectsWith(promise, status, code) {
  try {
    await promise
    assert.fail('应该抛错')
  } catch (error) {
    assert.ok(error instanceof HubError, `应该是 HubError，实际是 ${error?.name}`)
    assert.equal(error.status, status)
    assert.equal(error.code, code)
    return error
  }
}

test('asr 插槽没启用时明确说没启用，不打上游也不读凭据', async () => {
  const { transcribe, calls } = build({ bindings: [] })
  const error = await rejectsWith(transcribe('asr', { audio: WAV }), 409, 'NOT_ENABLED')
  assert.match(error.message, /没启用/)
  assert.equal(calls.length, 0)
})

test('空音频当场拒绝，且排在读凭据之前', async () => {
  const transcribe = createTranscribe({
    registry: { resolve: () => [SLOT] },
    credentials: { resolve: async () => undefined },
    transcribers: { asr: async () => RESULT },
  })
  await rejectsWith(transcribe('asr', { audio: Buffer.alloc(0) }), 400, 'EMPTY_AUDIO')
  await rejectsWith(transcribe('asr', {}), 400, 'EMPTY_AUDIO')
  await rejectsWith(transcribe('asr', { audio: '   ' }), 400, 'EMPTY_AUDIO')
})

test('缺凭据时报出引用名，不去发一个没有 key 的请求', async () => {
  const { transcribe, calls } = build({ store: {} })
  const error = await rejectsWith(transcribe('asr', { audio: WAV }), 502, 'TRANSCRIPTION_FAILED')
  assert.match(error.message, /DASHSCOPE_API_KEY/)
  assert.equal(calls.length, 0)
})

test('接入点类型没有适配器时如实说，不假装能识别', async () => {
  const { transcribe } = build({ bindings: [{ ...SLOT, kind: 'volcengine' }] })
  const error = await rejectsWith(transcribe('asr', { audio: WAV }), 501, 'NO_ADAPTER')
  assert.match(error.message, /volcengine/)
})

test('成功时把音频、格式与采样率原样交给适配器', async () => {
  const { transcribe, calls } = build()
  const result = await transcribe('asr', { audio: WAV, format: 'wav', sampleRate: 16000 })
  assert.equal(result.text, '你好呀')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].apiKey, 'sk-test')
  assert.equal(calls[0].sampleRate, 16000)
  assert.equal(calls[0].binding.model, 'qwen-audio-3.0-asr-flash')
})

test('上游报错原样透出，不被吞成一句笼统的失败', async () => {
  const { transcribe } = build({ transcriber: async () => { throw new Error('百炼返回 401：Invalid API-key provided.') } })
  const error = await rejectsWith(transcribe('asr', { audio: WAV }), 502, 'TRANSCRIPTION_FAILED')
  assert.match(error.message, /Invalid API-key/)
})

test('识别出空文本不算失败：静音/无语音是正常结果', async () => {
  const { transcribe } = build({ transcriber: async () => ({ text: '', model: 'qwen-audio-3.0-asr-flash' }) })
  const result = await transcribe('asr', { audio: WAV })
  assert.equal(result.text, '')
})

test('音频必须用 data URL：裸 base64 串服务端会判 500（这条钉住形状）', () => {
  const url = toAudioDataUrl(WAV, 'wav')
  assert.match(url, /^data:audio\/wav;base64,/)
  assert.equal(Buffer.from(url.split(',')[1], 'base64').length, WAV.length)
  assert.ok(!url.startsWith('data:audio/wav;base64,data:'), '不能重复包裹')
})

test('返回体里的文本按已验证的顺序提取', () => {
  assert.equal(transcriptOf({ output: { text: ' 甲 ' } }), '甲')
  assert.equal(transcriptOf({ text: '乙' }), '乙')
  assert.equal(transcriptOf({ output: { choices: [{ message: { content: [{ text: '丙' }] } }] } }), '丙')
  assert.equal(transcriptOf({ sentences: [{ text: '丁' }, { text: '戊' }] }), '丁戊')
  assert.equal(transcriptOf({}), '')
  assert.equal(transcriptOf(null), '')
})

/** 用一个可替换的 global fetch 包住调用，结束后恢复。 */
async function withFetch(impl, run) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try { return await run() } finally { globalThis.fetch = original }
}

test('适配器打的是原生多模态路径，并带上 format/sample_rate', async () => {
  const seen = []
  await withFetch(async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ output: { text: '你好呀' }, request_id: 'req-9', usage: { duration: 1 } }) }
  }, async () => {
    const result = await transcribeWithDashscope({ binding: SLOT, apiKey: 'sk-test', audio: WAV, format: 'wav', sampleRate: 16000 })
    assert.equal(result.text, '你好呀')
    assert.equal(result.requestId, 'req-9')
    assert.equal(result.audioSeconds, 1)
  })
  assert.equal(seen.length, 1)
  assert.match(seen[0].url, /\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/)
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-test')
  assert.equal(seen[0].body.model, 'qwen-audio-3.0-asr-flash')
  assert.equal(seen[0].body.parameters.format, 'wav')
  assert.equal(seen[0].body.parameters.sample_rate, '16000')
  assert.match(seen[0].body.input.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/)
})

test('网络层失败重试一次：这台机器上大请求体偶尔被掐断', async () => {
  let attempts = 0
  await withFetch(async () => {
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } })
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: '第二次成功' }) }
  }, async () => {
    const result = await transcribeWithDashscope({ binding: SLOT, apiKey: 'sk-test', audio: WAV })
    assert.equal(result.text, '第二次成功')
  })
  assert.equal(attempts, 2)
})

test('HTTP 错误不重试：4xx/5xx 重试只会把明确的错误拖成慢错误', async () => {
  let attempts = 0
  await withFetch(async () => {
    attempts += 1
    return { ok: false, status: 400, text: async () => JSON.stringify({ message: '模型不存在' }) }
  }, async () => {
    await assert.rejects(
      transcribeWithDashscope({ binding: SLOT, apiKey: 'sk-test', audio: WAV }),
      /百炼返回 400：模型不存在/,
    )
  })
  assert.equal(attempts, 1)
})

test('没有 key 或没有模型时本地就拒绝，不发请求', async () => {
  let called = 0
  await withFetch(async () => { called += 1; return { ok: true, status: 200, text: async () => '{}' } }, async () => {
    await assert.rejects(transcribeWithDashscope({ binding: SLOT, apiKey: '', audio: WAV }), /缺少凭据/)
    await assert.rejects(transcribeWithDashscope({ binding: { ...SLOT, model: '' }, apiKey: 'sk-test', audio: WAV }), /没有配置 asr 模型/)
    await assert.rejects(transcribeWithDashscope({ binding: SLOT, apiKey: 'sk-test', audio: Buffer.alloc(0) }), /音频是空的/)
  })
  assert.equal(called, 0)
})
