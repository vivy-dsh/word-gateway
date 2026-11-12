import { CAPABILITIES } from './capabilities.mjs'

const prefix = '/dsh-capability-hub/api'
const BODY_LIMIT = 64 * 1024

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > BODY_LIMIT) throw new Error('请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/** 与 dsh-local-voice 相同的本机访问约束：只认回环 Host，写请求必须同源，并过一遍会话校验。 */
function rejected(ctx, req) {
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(String(req.headers.host ?? '').toLowerCase())) {
    return { status: 403, code: 'HOST_REJECTED', error: '只接受本机访问' }
  }
  if (req.method !== 'GET' && req.headers.origin) {
    let same = false
    try { same = new URL(req.headers.origin).host.toLowerCase() === String(req.headers.host).toLowerCase() } catch { same = false }
    if (!same) return { status: 403, code: 'ORIGIN_REJECTED', error: '跨站请求被拒绝' }
  }
  const conn = ctx.get('connection')
  if (!conn || typeof conn.requestRejection !== 'function') return { status: 503, code: 'AUTH_UNAVAILABLE', error: '会话验证不可用' }
  const rejection = conn.requestRejection(req)
  if (rejection !== undefined && rejection !== null && rejection !== false) {
    return { status: typeof rejection === 'number' ? rejection : 403, code: 'AUTH_REJECTED', error: '会话未通过验证' }
  }
  return null
}

function refsOf(state) {
  return [...new Set(Object.values(state.slots).map(slot => slot.authRef))]
}

/**
 * 面板与后续插件共用的 HTTP 面。本轮只读状态、改插槽、读写凭据；
 * 没有 invoke 路由——能力调用在适配器到位前一律未实现。
 * @param ctx - 插件上下文（需要 webServer 与 credentials）
 * @param registry - createRegistry 的返回值
 * @param catalog - 可选的能力候选读取器（createCatalog 的返回值）；缺省时该路由返回空目录
 */
export function registerHubHttp(ctx, registry, catalog) {
  return ctx.webServer.register({ kind: 'prefix', path: prefix, handler: async (req, res) => {
    const fail = (status, code, error) => send(res, status, { ok: false, code, error })
    const denied = rejected(ctx, req)
    if (denied) return fail(denied.status, denied.code, denied.error)

    const describe = async state => {
      const entries = {}
      for (const ref of refsOf(state)) entries[ref] = await ctx.credentials.describe(ref)
      return entries
    }
    const body = async () => {
      try { return await readBody(req) } catch { throw new Error('请求体不是合法 JSON') }
    }

    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === `${prefix}/state`) {
        const state = registry.state()
        return send(res, 200, { ok: true, ...state, credentials: await describe(state) })
      }
      if (req.method === 'GET' && url.pathname === `${prefix}/resolve`) {
        const capability = String(url.searchParams.get('capability') ?? '')
        if (!CAPABILITIES.includes(capability)) return fail(400, 'UNKNOWN_CAPABILITY', `未知能力：${capability}`)
        const bindings = registry.resolve(capability)
        if (!bindings.length) return send(res, 200, { ok: false, error: 'not_enabled', bindings: [] })
        return send(res, 200, { ok: true, bindings })
      }
      if (req.method === 'GET' && url.pathname === `${prefix}/catalog`) {
        const directory = typeof catalog === 'function' ? await catalog() : { models: {}, notes: {}, failures: [] }
        return send(res, 200, { ok: true, ...directory })
      }
      if (req.method === 'POST' && url.pathname === `${prefix}/slot`) {
        const payload = await body()
        if (typeof payload?.capability !== 'string') return fail(400, 'BAD_REQUEST', '缺少 capability')
        if (payload.patch === null || typeof payload.patch !== 'object' || Array.isArray(payload.patch)) return fail(400, 'BAD_REQUEST', 'patch 必须是对象')
        registry.patch(payload.capability, payload.patch)
        const state = registry.state()
        return send(res, 200, { ok: true, ...state, credentials: await describe(state) })
      }
      if (req.method === 'POST' && url.pathname === `${prefix}/credential`) {
        const payload = await body()
        const ref = String(payload?.ref ?? '')
        if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(ref)) return fail(400, 'BAD_REF', '凭据引用名不合法')
        if (payload.clear === true) await ctx.credentials.unset(ref)
        else {
          const value = typeof payload?.value === 'string' ? payload.value.trim() : ''
          if (!value) return fail(400, 'EMPTY_VALUE', '凭据不能为空；要清除请用 clear')
          await ctx.credentials.set(ref, value)
        }
        return send(res, 200, { ok: true, ref, credential: await ctx.credentials.describe(ref) })
      }
      return fail(404, 'NOT_FOUND', '没有这个接口')
    } catch (error) {
      return fail(400, 'REJECTED', String(error?.message ?? error))
    }
  } })
}
