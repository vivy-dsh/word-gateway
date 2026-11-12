/**
 * `/api/catalog` 的接线：前缀、会话校验、目录返回值。
 *
 * 这条路由是本轮新加的，活体验证要重启进程才生效；这里用一个假 ctx 直接驱动
 * handler，先把「注册到了哪个前缀、拿到什么响应」固定下来。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHubHttp } from '../src/http.mjs'

const HOST = '127.0.0.1:3082'
const PREFIX = '/dsh-capability-hub/api'

/** 捕获 `ctx.webServer.register` 的 handler，其余服务给最小可用替身。 */
function harness(catalog) {
  let handler
  const ctx = {
    get: name => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    webServer: { register: options => { handler = options.handler; return () => {} } },
    credentials: { describe: async () => ({ configured: false }), set: async () => {}, unset: async () => {} },
  }
  const registry = { state: () => ({ version: 1, slots: {}, recovered: false }), patch: () => {}, resolve: () => [] }
  registerHubHttp(ctx, registry, catalog)
  return handler
}

/**
 * 跑一次 GET，收齐状态码与响应体。
 * @param handler - 被捕获的 handler
 * @param path - 请求路径
 * @returns `{ status, body }`
 */
async function get(handler, path) {
  let status = 0
  let body = ''
  const res = { writeHead: code => { status = code }, end: chunk => { body = String(chunk ?? '') } }
  await handler({ method: 'GET', url: path, headers: { host: HOST } }, res)
  return { status, body: JSON.parse(body || '{}') }
}

test('GET /catalog 返回目录内容', async () => {
  const handler = harness(async () => ({ models: { decision: { dashscope: [{ id: 'qwen-max', name: 'Qwen Max' }] } }, notes: { asr: '只能手填' }, failures: [] }))
  const { status, body } = await get(handler, `${PREFIX}/catalog`)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.models.decision.dashscope, [{ id: 'qwen-max', name: 'Qwen Max' }])
  assert.equal(body.notes.asr, '只能手填')
})

test('目录读取抛错时返回 400 而不是挂掉', async () => {
  const handler = harness(async () => { throw new Error('llm down') })
  const { status, body } = await get(handler, `${PREFIX}/catalog`)
  assert.equal(status, 400)
  assert.equal(body.ok, false)
  assert.match(body.error, /llm down/)
})

test('没有目录读取器时也给出空目录形状', async () => {
  const handler = harness(undefined)
  const { status, body } = await get(handler, `${PREFIX}/catalog`)
  assert.equal(status, 200)
  assert.deepEqual(body.models, {})
  assert.deepEqual(body.failures, [])
})

test('非本机 Host 一律拒绝，目录路由也不例外', async () => {
  const handler = harness(async () => ({ models: {}, notes: {}, failures: [] }))
  let status = 0
  const res = { writeHead: code => { status = code }, end: () => {} }
  await handler({ method: 'GET', url: `${PREFIX}/catalog`, headers: { host: 'evil.example:3082' } }, res)
  assert.equal(status, 403)
})
