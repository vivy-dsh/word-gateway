/**
 * `/api/tts`：世界网关唯一的 invoke 路由，也是语音插件「世界网关语音包」的落点。
 *
 * 这里不连真百炼：用一个本地 HTTP 替身扮成 DashScope，把「请求形状、凭据来源、
 * 音频头修复、错误透出」四件事固定下来。真机验证见
 * `docs/logs/2026-11-world-gateway/v0.1.4-voice-dashscope/`。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { repairWavHeader, synthesizeWithDashscope, wavDurationMs } from '../src/adapters/dashscope-tts.mjs'
import { registerHubHttp } from '../src/http.mjs'

const HOST = '127.0.0.1:3082'
const PREFIX = '/dsh-capability-hub/api'

/** 造一段 24kHz/单声道/16bit 的 wav；`brokenHeader` 时把长度写成流式占位值。 */
function makeWav({ samples = 24000, brokenHeader = false } = {}) {
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 12) * 8000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(24000, 24)
  header.writeUInt32LE(48000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(brokenHeader ? 0x7ffffff0 : data.length, 40)
  return Buffer.concat([header, data])
}

/** 起一个假 DashScope：记录收到的请求，按 `route` 决定回什么。 */
async function fakeDashscope(route) {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const parsed = raw ? JSON.parse(raw) : {}
    seen.push({ url: req.url, auth: req.headers.authorization, body: parsed })
    route(req, res, parsed, seen)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, seen, close: () => new Promise(resolve => server.close(resolve)) }
}

/**
 * 捕获 handler 的假 ctx：凭据按 `store` 返回，插槽按 `bindings` 返回。
 *
 * `resolve` 是**真实** DSH credentials 服务的读值方法（返回 `{ value, source }`）。
 * 这里一度写成 `get`，测试全绿而线上 400「ctx.credentials.get is not a function」——
 * 替身必须照着真实接口写，否则测的是假替身不是产品。
 */
function harness({ bindings, store = {} }) {
  let handler
  const ctx = {
    get: name => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    webServer: { register: options => { handler = options.handler; return () => {} } },
    credentials: {
      describe: async () => ({ configured: true }),
      set: async () => {},
      unset: async () => {},
      resolve: async ref => (store[ref] ? { value: store[ref], source: 'test' } : undefined),
    },
  }
  const registry = { state: () => ({ version: 1, slots: {}, recovered: false }), patch: () => {}, resolve: () => bindings }
  registerHubHttp(ctx, registry)
  return handler
}

/** 跑一次 POST，返回状态码、响应头与原始字节。 */
async function post(handler, path, payload) {
  let status = 0
  let headers = {}
  let body = Buffer.alloc(0)
  const res = {
    writeHead: (code, value) => { status = code; headers = value ?? {} },
    end: chunk => { body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? '')) },
  }
  const req = Object.assign(
    (async function* () { if (payload !== undefined) yield Buffer.from(JSON.stringify(payload)) })(),
    { method: 'POST', url: path, headers: { host: HOST, 'content-type': 'application/json' } },
  )
  await handler(req, res)
  return { status, headers, body }
}

const SLOT = { capability: 'tts', kind: 'dashscope', baseURL: 'https://placeholder', model: 'qwen3-tts-flash', authRef: 'DASHSCOPE_API_KEY' }

test('tts 走 aigc 形状：拿到 OSS 链接后下载，并修好流式 wav 头', async () => {
  const broken = makeWav({ samples: 24000, brokenHeader: true })
  // 假服务自己的地址在 listen 之后才知道：用一个闭包变量接住，别在 handler 里读 `ds.base`。
  let base = ''
  const ds = await fakeDashscope((req, res) => {
    if (req.url.endsWith('/aigc/multimodal-generation/generation')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ output: { audio: { url: `${base}/audio.wav` } } }))
      return
    }
    if (req.url === '/audio.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(broken.length) })
      res.end(broken)
      return
    }
    res.writeHead(500); res.end('{}')
  })
  base = ds.base
  try {
    const handler = harness({ bindings: [{ ...SLOT, baseURL: base }], store: { DASHSCOPE_API_KEY: 'sk-test' } })
    const { status, headers, body } = await post(handler, `${PREFIX}/tts`, { text: '你好', voice: 'Cherry' })
    assert.equal(status, 200)
    assert.equal(headers['content-type'], 'audio/wav')
    assert.equal(body.length, broken.length)
    // 头被修过：声明长度等于实际，时长 1 秒而不是 12 小时
    assert.equal(body.readUInt32LE(body.indexOf('data') + 4), broken.length - 44)
    assert.equal(Number(headers['x-duration-ms']), 1000)
    // 请求形状：模型、音色、语言都对；key 从 registry 的 authRef 取，不在请求体里
    assert.equal(ds.seen[0].url, '/api/v1/services/aigc/multimodal-generation/generation')
    assert.equal(ds.seen[0].auth, 'Bearer sk-test')
    assert.deepEqual(ds.seen[0].body, { model: 'qwen3-tts-flash', input: { text: '你好', voice: 'Cherry', language_type: 'Chinese' } })
  } finally { await ds.close() }
})

test('tts 在 aigc 形状失败时改走 SpeechSynthesizer', async () => {
  const wav = makeWav({ samples: 12000 })
  const ds = await fakeDashscope((req, res) => {
    if (req.url.endsWith('/aigc/multimodal-generation/generation')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'ModelNotFound', message: 'Model not exist.' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ output: { audio: { data: wav.toString('base64') } } }))
  })
  try {
    // 把假服务伪装成百炼主机根：替换 baseURL 的 origin 即可（joinUrl 会拼回 /api/v1/...）
    const slot = { ...SLOT, baseURL: ds.base }
    const result = await synthesizeWithDashscope({ binding: slot, apiKey: 'sk-test', text: '你好' })
    assert.equal(result.mime, 'audio/wav')
    assert.equal(result.audio.length, wav.length)
    assert.equal(result.durationMs, 500)
    assert.equal(result.voice, 'Cherry')
    assert.ok(ds.seen.some(item => item.url === '/api/v1/services/audio/tts/SpeechSynthesizer'))
  } finally { await ds.close() }
})

test('插槽没启用时明确说没启用，而不是含糊的失败', async () => {
  const handler = harness({ bindings: [] })
  const { status, body } = await post(handler, `${PREFIX}/tts`, { text: '你好' })
  assert.equal(status, 409)
  assert.equal(JSON.parse(String(body)).code, 'NOT_ENABLED')
})

test('凭据缺失时报出引用名，不去发一个没有 key 的请求', async () => {
  const handler = harness({ bindings: [SLOT], store: {} })
  const { status, body } = await post(handler, `${PREFIX}/tts`, { text: '你好' })
  assert.equal(status, 502)
  const parsed = JSON.parse(String(body))
  assert.equal(parsed.code, 'SYNTHESIS_FAILED')
  assert.match(parsed.error, /DASHSCOPE_API_KEY/)
})

test('空文本当场拒绝，不打上游', async () => {
  const handler = harness({ bindings: [SLOT], store: { DASHSCOPE_API_KEY: 'sk-test' } })
  const { status, body } = await post(handler, `${PREFIX}/tts`, { text: '   ' })
  assert.equal(status, 400)
  assert.equal(JSON.parse(String(body)).code, 'EMPTY_TEXT')
})

test('非 dashscope 的接入点如实报「没有适配器」', async () => {
  const handler = harness({ bindings: [{ ...SLOT, kind: 'minimax' }], store: { DASHSCOPE_API_KEY: 'sk-test' } })
  const { status, body } = await post(handler, `${PREFIX}/tts`, { text: '你好' })
  assert.equal(status, 501)
  assert.equal(JSON.parse(String(body)).code, 'NO_ADAPTER')
})

test('repairWavHeader 只动畸形头，正常 wav 原样返回', () => {
  const good = makeWav({ samples: 100 })
  assert.equal(repairWavHeader(good), good)
  const broken = makeWav({ samples: 100, brokenHeader: true })
  const fixed = repairWavHeader(broken)
  assert.notEqual(fixed, broken)
  assert.equal(wavDurationMs(broken), Math.round((0x7ffffff0 / 48000) * 1000))
  assert.equal(wavDurationMs(fixed), Math.round((200 / 48000) * 1000))
})
