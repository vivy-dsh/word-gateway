/**
 * 预制候选表的不变量：能力/接入点名必须封闭在枚举内，默认模型必须自己就在候选里。
 * 这些断言让「加一行候选」不至于加出一个错名字。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPABILITIES, KINDS } from '../src/capabilities.mjs'
import { DEFAULT_MODEL, LIST_BASE, PRESET, VERIFIED_AT, presetFor, presetIds } from '../src/candidates.mjs'

test('预制表只用已声明的能力名与接入点类型', () => {
  for (const [capability, kinds] of Object.entries(PRESET)) {
    assert.ok(CAPABILITIES.includes(capability), `未知能力：${capability}`)
    for (const [kind, ids] of Object.entries(kinds)) {
      assert.ok(KINDS.includes(kind), `未知接入点：${kind}`)
      assert.ok(Array.isArray(ids) && ids.length > 0, `${capability}/${kind} 不能是空数组`)
      for (const id of ids) assert.equal(typeof id, 'string', '候选必须是字符串 id')
    }
  }
})

test('每个能力都有默认模型，且默认模型就在该能力的预制候选里', () => {
  for (const capability of CAPABILITIES) {
    const model = DEFAULT_MODEL[capability]
    assert.ok(model, `${capability} 缺默认模型`)
    const listed = Object.values(PRESET[capability] ?? {}).flat()
    assert.ok(listed.includes(model), `${capability} 的默认模型 ${model} 不在候选表里`)
  }
})

test('presetFor 返回带来源标记的候选，没有预设时给空数组', () => {
  assert.deepEqual(presetFor('asr', 'dashscope')[0], {
    id: 'qwen-audio-3.1-asr-flash',
    name: '百炼 · 语音识别 3.1（Flash）',
    source: 'preset',
  })
  assert.deepEqual(presetFor('decision', 'dashscope'), [])
  assert.deepEqual(presetFor('asr', 'minimax'), [])
})

test('没有列表接口的接入点为空字符串，有接口的都是 https', () => {
  assert.equal(LIST_BASE['qwen-token-plan'], '')
  for (const kind of KINDS) {
    const base = LIST_BASE[kind]
    assert.equal(typeof base, 'string')
    if (base) assert.ok(base.startsWith('https://'), `${kind} 的列表地址必须是 https`)
  }
})

test('presetIds 按能力归组且不含重复', () => {
  const ids = presetIds()
  for (const capability of Object.keys(PRESET)) {
    assert.deepEqual([...new Set(ids[capability])].sort(), [...ids[capability]].sort())
  }
  assert.match(VERIFIED_AT, /^\d{4}-\d{2}-\d{2}$/)
})
