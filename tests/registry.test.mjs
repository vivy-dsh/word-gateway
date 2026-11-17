import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry } from '../src/registry.mjs'
import { CAPABILITIES, deriveAuthRef } from '../src/capabilities.mjs'

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'capability-hub-'))
  return { dir, file: join(dir, 'registry.json') }
}

test('默认插槽覆盖六个能力且默认不启用', () => {
  const { file } = workspace()
  const { slots } = createRegistry({ file }).state()
  assert.deepEqual(Object.keys(slots).sort(), [...CAPABILITIES].sort())
  for (const capability of CAPABILITIES) {
    assert.equal(slots[capability].enabled, false)
    assert.ok(slots[capability].model)
    // 实时语音是常驻 WebSocket，其余能力都是 HTTP。
    const prefix = capability === 'realtime' ? 'wss://' : 'https://'
    assert.ok(slots[capability].baseURL.startsWith(prefix), `${capability} 基址应以 ${prefix} 开头`)
  }
  assert.equal(slots.asr.authRef, 'DASHSCOPE_API_KEY')
  assert.equal(slots.decision.authRef, 'QWEN_TOKEN_PLAN_API_KEY')
  assert.equal(slots.realtime.kind, 'moss')
  assert.equal(slots.realtime.model, 'moss-live-1.0')
  assert.equal(slots.realtime.authRef, 'MOSS_API_KEY')
})

test('切到模思会带出它自己的基址、首个候选与凭据名', () => {
  const { file } = workspace()
  const registry = createRegistry({ file })
  const asr = registry.patch('asr', { kind: 'moss' })
  assert.equal(asr.baseURL, 'https://api.mosi.cn')
  assert.equal(asr.model, 'moss-transcribe-1.0')
  assert.equal(asr.authRef, 'MOSS_API_KEY')
  const tts = registry.patch('tts', { kind: 'moss' })
  assert.equal(tts.model, 'moss-tts-1.5-flash')
  // 模思没有向量模型：切过去后模型为空、保存被拒，而不是留着百炼的 id 发到模思端点。
  assert.throws(() => registry.patch('embedding', { kind: 'moss' }), /模型名不能为空/)
})

test('实时语音的基址只接受 wss，其它能力只接受 https', () => {
  const { file } = workspace()
  const registry = createRegistry({ file })
  assert.throws(() => registry.patch('realtime', { baseURL: 'https://api.mosi.cn/v1/realtime' }), /wss/)
  assert.throws(() => registry.patch('asr', { baseURL: 'wss://api.mosi.cn/v1/realtime' }), /https/)
})

test('未知能力被拒绝', () => {
  const { file } = workspace()
  const registry = createRegistry({ file })
  assert.throws(() => registry.patch('chat', { enabled: true }), /未知能力/)
  assert.throws(() => registry.resolve('vision'), /未知能力/)
})

test('未知字段与非 https 基址被拒绝', () => {
  const { file } = workspace()
  const registry = createRegistry({ file })
  assert.throws(() => registry.patch('asr', { apiKey: 'sk-x' }), /未知字段/)
  assert.throws(() => registry.patch('asr', { baseURL: 'http://insecure.example' }), /https/)
  assert.throws(() => registry.patch('asr', { kind: 'openrouter' }), /未知接入点/)
})

test('改接入点会重新派生凭据名，显式写过的值不动', () => {
  const { file } = workspace()
  const registry = createRegistry({ file })
  const next = registry.patch('tts', { kind: 'siliconflow' })
  assert.equal(next.authRef, deriveAuthRef('siliconflow'))
  const pinned = registry.patch('tts', { kind: 'minimax', authRef: 'MY_CUSTOM_KEY' })
  assert.equal(pinned.authRef, 'MY_CUSTOM_KEY')
  const moved = registry.patch('tts', { kind: 'dashscope' })
  assert.equal(moved.authRef, 'MY_CUSTOM_KEY')
})

test('保存是原子的：落盘可解析且没有残留临时文件', () => {
  const { dir, file } = workspace()
  const registry = createRegistry({ file })
  registry.patch('tts', { enabled: true, model: 'qwen-audio-3.1-tts-flash' })
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(parsed.version, 1)
  assert.equal(parsed.slots.tts.enabled, true)
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [])
  assert.equal('credentials' in parsed, false)
})

test('损坏的 registry 被改名备份并回落到默认值', () => {
  const { dir, file } = workspace()
  writeFileSync(file, '{ this is not json', 'utf8')
  const registry = createRegistry({ file, now: () => 1700000000000 })
  const state = registry.state()
  assert.equal(state.recovered, true)
  assert.equal(state.slots.asr.enabled, false)
  assert.ok(readdirSync(dir).some(name => name === 'registry.json.corrupt-1700000000000'))
})

test('resolve 只返回已启用的插槽', () => {
  const { file } = workspace()
  const registry = createRegistry({ file })
  assert.deepEqual(registry.resolve('asr'), [])
  registry.patch('asr', { enabled: true })
  const [binding] = registry.resolve('asr')
  assert.equal(binding.capability, 'asr')
  assert.equal(binding.kind, 'dashscope')
  assert.equal(binding.authRef, 'DASHSCOPE_API_KEY')
})
