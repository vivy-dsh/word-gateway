import { CAPABILITIES } from './capabilities.mjs'
import { HubError, createSpeak, createTranscribe } from './speak.mjs'

const prefix = '/dsh-capability-hub/api'
const BODY_LIMIT = 64 * 1024
/** ASR 要把音频 base64 带上来：16k/16bit 单声道 60 秒约 1.9MB，编码后约 2.6MB，留足余量。 */
const ASR_BODY_LIMIT = 12 * 1024 * 1024

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** 音频响应：时长放头里，调用方（语音插件）就不必自己解析 wav。 */
function sendAudio(res, result) {
  res.writeHead(200, {
    'content-type': result.mime,
    'content-length': String(result.audio.length),
    'content-disposition': `inline; filename="tts.${result.format}"`,
    'x-duration-ms': String(result.durationMs || 0),
    'x-tts-model': result.model,
    'x-tts-voice': result.voice,
    'cache-control': 'no-store',
  })
  res.end(result.audio)
}

async function readBody(req, limit = BODY_LIMIT) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > limit) throw new Error('请求体过大')
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
 * 面板与语音插件共用的 HTTP 面：读状态、改插槽、读写凭据，外加 `tts` 合成与 `asr` 识别。
 *
 * 只有 `tts` 与 `asr` 有 invoke 路由：它们各自有真实调用方（语音合成、语音识别）。
 * 其余能力（embedding / omni / 实时语音）还没有确定的调用方与形状，所以不开口子
 * ——空接口比没有接口更难收回。
 *
 * @param ctx - 插件上下文（需要 webServer 与 credentials）
 * @param registry - createRegistry 的返回值
 * @param catalog - 可选的能力候选读取器（createCatalog 的返回值）；缺省时该路由返回空目录
 * @param speak - 可选的合成实现（createSpeak 的返回值）。缺省时按当前 ctx 现建一个，
 *                与 index.mjs 提供给语音插件的那份逻辑相同。
 * @param transcribe - 可选的识别实现（createTranscribe 的返回值），同上。
 */
export function registerHubHttp(ctx, registry, catalog, speak = createSpeak({ registry, credentials: ctx.credentials }), transcribe = createTranscribe({ registry, credentials: ctx.credentials })) {
  return ctx.webServer.register({ kind: 'prefix', path: prefix, handler: async (req, res) => {
    const fail = (status, code, error) => send(res, status, { ok: false, code, error })
    const denied = rejected(ctx, req)
    if (denied) return fail(denied.status, denied.code, denied.error)

    const describe = async state => {
      const entries = {}
      for (const ref of refsOf(state)) entries[ref] = await ctx.credentials.describe(ref)
      return entries
    }
    const body = async (limit = BODY_LIMIT) => {
      try { return await readBody(req, limit) } catch { throw new Error('请求体不是合法 JSON') }
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
      // 合成：文本进、音频出。只有 tts 有这个口子，理由见上面的注释。
      // 逻辑全在 speak.mjs：面板走这里，语音插件走进程内，同一份。
      if (req.method === 'POST' && url.pathname === `${prefix}/tts`) {
        const payload = await body()
        try {
          return sendAudio(res, await speak('tts', { text: payload?.text, voice: payload?.voice }))
        } catch (error) {
          if (error instanceof HubError) return fail(error.status, error.code, error.message)
          throw error
        }
      }
      // 识别：音频进、文本出。与 /tts 对称，请求体里带 base64 音频，所以单独放宽上限。
      // 有真实调用方（dsh-local-asr 的「世界网关」引擎），不是空接口。
      if (req.method === 'POST' && url.pathname === `${prefix}/asr`) {
        const payload = await body(ASR_BODY_LIMIT)
        try {
          const result = await transcribe('asr', { audio: payload?.audio, format: payload?.format, sampleRate: payload?.sampleRate })
          return send(res, 200, { ok: true, ...result })
        } catch (error) {
          if (error instanceof HubError) return fail(error.status, error.code, error.message)
          throw error
        }
      }
      return fail(404, 'NOT_FOUND', '没有这个接口')
    } catch (error) {
      return fail(400, 'REJECTED', String(error?.message ?? error))
    }
  } })
}
