/**
 * 能力候选目录：内置预制表 + 宿主注册表，缺服务就退化，单家失败不影响别家。
 * 断言都在证明「不编造」——预制表只放确认过的 id，宿主那边只读现成清单。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createCatalog } from '../src/catalog.mjs'
import { CAPABILITIES } from '../src/capabilities.mjs'
import { presetFor } from '../src/candidates.mjs'

/** 只提供 `ctx.get`，其余都不要。 */
function contextWith(services) {
  return { get: name => services[name] }
}

const llm = (providers, models) => ({
  listProviders: () => providers,
  listModels: async provider => {
    const rows = models[provider]
    if (rows instanceof Error) throw rows
    return rows ?? []
  },
})

test('decision 收齐同名 provider 的模型，别的 provider 不进候选', async () => {
  const catalog = createCatalog(contextWith({
    llm: llm(
      [{ id: 'dashscope', name: 'DashScope' }, { id: 'unrelated-gateway', name: 'Unrelated' }],
      {
        dashscope: [
          { provider: 'dashscope', id: 'qwen-max', name: 'Qwen Max' },
          { provider: 'dashscope', id: 'qwen-plus' }, // 没有 name 时用 id 顶上
        ],
        'unrelated-gateway': [{ provider: 'unrelated-gateway', id: 'mystery', name: 'Mystery' }],
      },
    ),
  }))
  const directory = await catalog()
  assert.deepEqual(directory.models.decision.dashscope, [
    { id: 'qwen-max', name: 'Qwen Max', source: 'host' },
    { id: 'qwen-plus', name: 'qwen-plus', source: 'host' },
  ])
  assert.deepEqual(directory.models.decision.unrelated, undefined, '名字对不上接入点的 provider 不该被塞进候选')
  assert.deepEqual(directory.failures, [])
})

test('omni 在预制候选之后追加声明了音频/视频输入的宿主模型', async () => {
  const catalog = createCatalog(contextWith({
    llm: llm([{ id: 'dashscope', name: 'DashScope' }], {
      dashscope: [
        { provider: 'dashscope', id: 'text-only', name: 'Text' },
        { provider: 'dashscope', id: 'audio-in', name: 'Audio', inputModalities: ['text', 'audio'] },
        { provider: 'dashscope', id: 'qwen-omni-turbo', name: 'Duplicated with preset' },
        { provider: 'dashscope', id: 'unknown', name: 'Unknown' },
      ],
    }),
  }))
  const directory = await catalog()
  const omni = directory.models.omni.dashscope
  const ids = omni.map(model => model.id)
  assert.deepEqual(ids.slice(0, 2), ['qwen-omni-turbo', 'qwen-omni-turbo-latest'], '预制候选在前')
  assert.ok(ids.includes('audio-in'), '声明音频输入的宿主模型要进来')
  assert.equal(ids.filter(id => id === 'qwen-omni-turbo').length, 1, '同名 id 不该重复')
  assert.ok(directory.models.decision.dashscope.some(model => model.id === 'text-only'), 'decision 不按模态过滤')
})

test('没有 llm 服务时仍给出预制候选，并保留每个能力的说明', async () => {
  const directory = await createCatalog(contextWith({}))()
  for (const capability of CAPABILITIES) {
    const kinds = directory.models[capability]
    assert.ok(Object.keys(kinds).length > 0, `${capability} 至少要有预制候选`)
    for (const kind of Object.keys(kinds)) {
      assert.deepEqual(kinds[kind], presetFor(capability, kind), `${capability}/${kind} 应等于预制表`)
    }
    assert.ok(directory.notes[capability], `${capability} 必须有说明`)
  }
  assert.deepEqual(directory.failures, [])
})

test('一家 provider 抛错只记进 failures，不影响别家', async () => {
  const catalog = createCatalog(contextWith({
    llm: llm(
      [{ id: 'dashscope', name: 'DashScope' }, { id: 'siliconflow', name: 'SiliconFlow' }],
      {
        dashscope: new Error('boom'),
        siliconflow: [{ provider: 'siliconflow', id: 'Qwen/Qwen2.5-7B', name: 'Qwen2.5 7B' }],
      },
    ),
  }))
  const directory = await catalog()
  assert.deepEqual(directory.failures, ['dashscope'])
  assert.deepEqual(directory.models.decision.siliconflow, [{ id: 'Qwen/Qwen2.5-7B', name: 'Qwen2.5 7B', source: 'host' }])
  assert.equal(directory.models.decision.dashscope, undefined, '检索失败的那家不该留下一个空候选键')
})

test('listProviders 自己抛错时整块退化，预制候选不丢', async () => {
  const catalog = createCatalog(contextWith({
    llm: { listProviders: () => { throw new Error('registry down') }, listModels: async () => [] },
  }))
  const directory = await catalog()
  assert.deepEqual(directory.models.decision, { 'qwen-token-plan': presetFor('decision', 'qwen-token-plan') })
  assert.deepEqual(directory.failures, [])
})
