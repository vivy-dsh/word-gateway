import assert from 'node:assert/strict'
import test from 'node:test'

import { createSpeak, createStatus, HubError } from '../src/speak.mjs'

/**
 * `speak` 是「合成一次」的唯一实现：面板走 HTTP、语音插件走进程内，两个入口共用它。
 * 这里直接测它，把适配器换成假上游，不发网络请求。
 */

const SLOT = { capability: 'tts', kind: 'dashscope', baseURL: 'https://example.invalid', model: 'qwen3-tts-flash', authRef: 'DASHSCOPE_API_KEY' }
const AUDIO = { audio: Buffer.alloc(96, 1), durationMs: 960, mime: 'audio/wav', format: 'wav', model: 'qwen3-tts-flash', voice: 'Cherry' }

function build({ bindings = [SLOT], store = { DASHSCOPE_API_KEY: 'sk-test' }, speaker } = {}) {
  const calls = []
  const speak = createSpeak({
    registry: { resolve: () => bindings },
    credentials: { resolve: async ref => (store[ref] ? { value: store[ref], source: 'test' } : undefined) },
    speakers: { tts: speaker ?? (async input => { calls.push(input); return AUDIO }) },
  })
  return { speak, calls }
}

/** 失败必须带 status + code：HTTP 路由要给状态码，进程内调用要靠它判断。 */
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

test('插槽没启用时明确说没启用，不打上游也不读凭据', async () => {
  const { speak, calls } = build({ bindings: [] })
  const error = await rejectsWith(speak('tts', { text: '你好' }), 409, 'NOT_ENABLED')
  assert.match(error.message, /没启用/)
  assert.equal(calls.length, 0)
})

test('空文本当场拒绝，而且排在读凭据之前（免费检查放前面）', async () => {
  // 没有凭据也没有 speaker：如果先读凭据，就会报 502 而不是 400。
  const speak = createSpeak({
    registry: { resolve: () => [SLOT] },
    credentials: { resolve: async () => undefined },
    speakers: { tts: async () => AUDIO },
  })
  await rejectsWith(speak('tts', { text: '   ' }), 400, 'EMPTY_TEXT')
  await rejectsWith(speak('tts', {}), 400, 'EMPTY_TEXT')
})

test('缺凭据时报出引用名，不去发一个没有 key 的请求', async () => {
  const { speak, calls } = build({ store: {} })
  const error = await rejectsWith(speak('tts', { text: '你好' }), 502, 'SYNTHESIS_FAILED')
  assert.match(error.message, /DASHSCOPE_API_KEY/)
  assert.equal(calls.length, 0)
})

test('接入点类型没有适配器时如实说，不假装能合成', async () => {
  const { speak } = build({ bindings: [{ ...SLOT, kind: 'volcengine' }] })
  const error = await rejectsWith(speak('tts', { text: '你好' }), 501, 'NO_ADAPTER')
  assert.match(error.message, /volcengine/)
})

test('未实现的能力名不会走到适配器', async () => {
  const { speak } = build()
  await rejectsWith(speak('embedding', { text: '你好' }), 501, 'NO_ADAPTER')
})

test('成功时把文本、音色与绑定原样交给适配器', async () => {
  const { speak, calls } = build()
  const result = await speak('tts', { text: '你好', voice: 'Cherry' })
  assert.equal(result, AUDIO)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, '你好')
  assert.equal(calls[0].voice, 'Cherry')
  assert.equal(calls[0].apiKey, 'sk-test')
  assert.equal(calls[0].binding.model, 'qwen3-tts-flash')
})

test('上游报错原样透出，不被吞成一句笼统的失败', async () => {
  const { speak } = build({ speaker: async () => { throw new Error('百炼返回 401：Invalid API-key provided.') } })
  const error = await rejectsWith(speak('tts', { text: '你好' }), 502, 'SYNTHESIS_FAILED')
  assert.match(error.message, /Invalid API-key/)
})

/**
 * `status` 回答的是「现在能不能合成」，不做合成。
 * 语音插件靠它判断「世界网关语音包在不在跑」——之前那一步是 fetch 自己的 /health，
 * 服务端没有浏览器会话，永远 401，面板上这个包就永远显示跑不起来。
 */
function statusOf({ bindings = [SLOT], store = { DASHSCOPE_API_KEY: 'sk-test' } } = {}) {
  return createStatus({
    registry: { resolve: () => bindings },
    credentials: { resolve: async ref => (store[ref] ? { value: store[ref], source: 'test' } : undefined) },
    speakers: { tts: async () => AUDIO },
  })
}

test('status: 一切就绪时说就绪，并带上模型名', async () => {
  const health = await statusOf()('tts')
  assert.equal(health.ready, true)
  assert.equal(health.model, 'qwen3-tts-flash')
  assert.equal(health.error, undefined)
})

test('status: 插槽没启用时如实说，不谎报就绪', async () => {
  const health = await statusOf({ bindings: [] })('tts')
  assert.equal(health.ready, false)
  assert.match(health.error, /没启用/)
})

test('status: 缺凭据时说缺哪一把，且不透露凭据内容', async () => {
  const health = await statusOf({ store: {} })('tts')
  assert.equal(health.ready, false)
  assert.match(health.error, /DASHSCOPE_API_KEY/)
  assert.ok(!JSON.stringify(health).includes('sk-'), '就绪信息里不该出现凭据')
})

test('status: 接入点类型没有适配器时说没适配器', async () => {
  const health = await statusOf({ bindings: [{ ...SLOT, kind: 'volcengine' }] })('tts')
  assert.equal(health.ready, false)
  assert.match(health.error, /volcengine/)
})

test('status: 不需要文本，也不产生任何合成调用', async () => {
  let calls = 0
  const status = createStatus({
    registry: { resolve: () => [SLOT] },
    credentials: { resolve: async () => ({ value: 'sk-test' }) },
    speakers: { tts: async () => { calls++; return AUDIO } },
  })
  await status('tts')
  assert.equal(calls, 0, 'status 只是看状态，不该触发上游')
})

