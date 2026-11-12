/**
 * 渲染回归：世界网关分区必须能在真实 React 18 客户端渲染下出内容。
 *
 * 这个文件存在的原因很具体：`CredentialRow` 曾把凭据名作为 React 保留 prop `ref`
 * 传给函数组件，React 18 抛 "Function components cannot have string refs"，整块
 * 分区被 SlotErrorBoundary 吞成一个空的 `[data-slot-error]` div——分区在导航里
 * 看得见、点进去全白。SSR 渲染不会复现（React 在服务端忽略 ref），所以这里用
 * jsdom + react-dom/client 走真实客户端路径。
 *
 * 依赖 `deepseek-harness` 子模块里的 react/react-dom/jsdom；那份依赖不在时整组跳过，
 * 不让别的机器因为缺装依赖而红。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE_PATH = join(HERE, '..', 'src', 'client.js')
const HARNESS = join(HERE, '..', '..', '..', 'deepseek-harness', 'packages', 'client', 'ui-settings-general', 'package.json')

const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

/**
 * 在 jsdom 里装载客户端半，返回真实 React 与注册到的组件。
 * @returns 浏览器面，或 `undefined`（harness 依赖没装）
 */
function browserHalf() {
  try {
    const require = createRequire(HARNESS)
    const { JSDOM } = require('jsdom')
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:3082/', pretendToBeVisual: true })
    const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    define('window', dom.window)
    define('document', dom.window.document)
    define('navigator', dom.window.navigator)
    define('MessageChannel', dom.window.MessageChannel)
    define('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }))
    const React = require('react')
    const { createRoot } = require('react-dom/client')
    let factory
    new Function('window', SOURCE)({ __ModuleLoader__: { load: module => { factory = module.factory } } })
    const plugin = factory(id => (id === 'react' ? React : require(id)))
    let Component
    plugin.apply({
      effect: fn => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
      slots: {
        inject: (_name, callback) => { callback(); return () => {} },
        register: (_options, component) => { Component = component; return () => {} },
      },
    })
    return { React, createRoot, Component, document: dom.window.document }
  } catch {
    return undefined
  }
}

const browser = browserHalf()
const skip = browser === undefined ? 'deepseek-harness 的 react/react-dom/jsdom 不可用' : false

/** 与 `capabilities.mjs` 的默认插槽同形，只填渲染需要的字段。 */
function readyState(overrides = {}) {
  const slot = (patch = {}) => ({
    enabled: false,
    kind: 'dashscope',
    baseURL: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com',
    model: 'qwen-audio-3.1-asr-flash',
    authRef: 'DASHSCOPE_API_KEY',
    note: '',
    ...patch,
  })
  return {
    phase: 'ready',
    error: null,
    notice: null,
    recovered: false,
    busy: null,
    creds: {},
    catalog: null,
    drafts: {},
    keys: {},
    slots: { asr: slot(), tts: slot(), decision: slot(), embedding: slot(), omni: slot() },
    ...overrides,
  }
}

/** 只读快照的假 store：渲染不该触发任何写入。 */
function fakeStore(state) {
  const noop = () => {}
  return {
    get: () => state,
    subscribe: () => () => {},
    load: async () => {},
    edit: noop,
    discard: noop,
    setKey: noop,
    save: async () => {},
    saveKey: async () => {},
    clearKey: async () => {},
    dispose: noop,
  }
}

/**
 * 按渲染器的 props 形状（kit→inject→owner）挂一次组件，返回渲染结果与捕获的错误。
 * @param state - store 快照
 * @param props - 额外 props（默认只有 owner 注入的 store）
 * @returns `{ html, failure }`
 */
async function renderOnce(state, props) {
  const { React, createRoot, Component, document } = browser
  const container = document.createElement('div')
  document.body.append(container)
  let failure
  class Boundary extends React.Component {
    constructor(properties) {
      super(properties)
      this.state = { failed: false }
    }
    static getDerivedStateFromError(error) {
      failure = error
      return { failed: true }
    }
    render() {
      return this.state.failed ? React.createElement('div', { 'data-slot-error': 'settings.section' }) : this.props.children
    }
  }
  createRoot(container).render(React.createElement(Boundary, null, React.createElement(Component, props ?? { store: fakeStore(state), close() {} })))
  for (let i = 0; i < 5 && failure === undefined; i += 1) {
    await new Promise(resolve => { setTimeout(resolve, 40) })
  }
  const html = container.innerHTML
  container.remove()
  return { html, failure }
}

test('组件不再把 ref 当 prop 名传给函数组件', { skip }, () => {
  // React 18 对字符串 ref 直接抛错；这条断言把那个 bug 的形态钉死。
  assert.doesNotMatch(SOURCE, /function CredentialRow\(\{[^}]*\bref\b/)
  assert.doesNotMatch(SOURCE, /\bref:\s*value\.authRef/)
})

test('就绪态渲染出 5 张能力卡且没有错误边界兜底', { skip }, async () => {
  const { html, failure } = await renderOnce(readyState())
  assert.equal(failure, undefined, `渲染不该抛错：${failure?.message ?? ''}`)
  assert.doesNotMatch(html, /data-slot-error/)
  assert.equal(html.match(/wg-card"/g)?.length, 5)
  for (const title of ['世界网关', '语音识别', '语音合成', '决策模型', '向量化', '全模态理解']) {
    assert.ok(html.includes(title), `缺少「${title}」`)
  }
  assert.ok(html.includes('已启用 0 / 5'), '缺少启用计数')
})

test('加载态与错误态各自有可见文案', { skip }, async () => {
  const loading = await renderOnce(readyState({ phase: 'loading', slots: null }))
  assert.equal(loading.failure, undefined)
  assert.ok(loading.html.includes('正在读取插槽状态'))

  const failed = await renderOnce(readyState({ phase: 'error', slots: null, error: 'HTTP 401' }))
  assert.equal(failed.failure, undefined)
  assert.ok(failed.html.includes('读取失败：HTTP 401'))
  assert.ok(failed.html.includes('重试'))
})

test('目录给了候选就出现取词器，没给就说明为什么只能手填', { skip }, async () => {
  const withModels = await renderOnce(readyState({
    catalog: {
      models: { decision: { dashscope: [{ id: 'qwen-max', name: 'Qwen Max' }, { id: 'qwen-plus', name: 'Qwen Plus' }] } },
      notes: {},
      failures: [],
    },
  }))
  assert.equal(withModels.failure, undefined)
  assert.ok(withModels.html.includes('从 2 个候选填入'), '决策模型卡应有取词器')
  assert.ok(withModels.html.includes('Qwen Max · qwen-max'), '取词器应带模型名')

  const withoutModels = await renderOnce(readyState({
    catalog: { models: {}, notes: { asr: '宿主不枚举转写模型' }, failures: [] },
  }))
  assert.equal(withoutModels.failure, undefined)
  assert.ok(withoutModels.html.includes('宿主不枚举转写模型'), '没有候选时应给出原因')
  assert.ok(!withoutModels.html.includes('候选填入'), '没有候选时不该出现取词器')
})

test('目录请求失败不影响分区渲染', { skip }, async () => {
  // catalog 为 null 就等价于 /catalog 失败：面板照常出卡，只是没有候选。
  const { html, failure } = await renderOnce(readyState({ catalog: null }))
  assert.equal(failure, undefined)
  assert.equal(html.match(/wg-card"/g)?.length, 5)
})
