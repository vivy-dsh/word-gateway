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

test('默认插槽覆盖五个能力且默认不启用', () => {
  const { file } = workspace()
  const { slots } = createRegistry({ file }).state()
  assert.deepEqual(Object.keys(slots).sort(), [...CAPABILITIES].sort())
  for (const capability of CAPABILITIES) {
    assert.equal(slots[capability].enabled, false)
    assert.ok(slots[capability].model)
    assert.ok(slots[capability].baseURL.startsWith('https://'))
  }
  assert.equal(slots.asr.authRef, 'DASHSCOPE_API_KEY')
  assert.equal(slots.decision.authRef, 'QWEN_TOKEN_PLAN_API_KEY')
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
  const next = registry.patch('asr', { kind: 'siliconflow' })
  assert.equal(next.authRef, deriveAuthRef('siliconflow'))
  const pinned = registry.patch('asr', { kind: 'minimax', authRef: 'MY_CUSTOM_KEY' })
  assert.equal(pinned.authRef, 'MY_CUSTOM_KEY')
  const moved = registry.patch('asr', { kind: 'dashscope' })
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
