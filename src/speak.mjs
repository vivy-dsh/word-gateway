import { synthesizeWithDashscope } from './adapters/dashscope-tts.mjs'

/** 支持「文本进、音频出」的能力 → 各自的适配器。加新能力就在这里加一行。 */
const SPEAKERS = { tts: synthesizeWithDashscope }

/**
 * 合成的失败要带状态码和机器可读的 code：HTTP 路由直接把状态给出去，
 * 插件之间在进程内调用则靠 `status` / `code` 判断，不必解析字符串。
 */
export class HubError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HubError'
    this.status = status
    this.code = code
  }
}

/**
 * 世界网关的「合成一次」：读插槽 → 校验 → 取凭据 → 打上游。
 *
 * 为什么单独成一个文件：同一次合成有两个入口——面板/浏览器走 HTTP（要过会话校验），
 * 语音插件走进程内调用（服务端没有浏览器会话，走 HTTP 必然 401）。
 * 两个入口共用这一份，才不会出现「面板能合成、插件不能」这种分裂。
 *
 * 检查顺序是刻意的：先验请求（免费、不碰凭据），再读凭据，最后才打上游。
 *
 * @param registry - createRegistry 的返回值
 * @param credentials - 宿主的 credentials 服务（`resolve(ref)` → `{ value }`）
 * @param speakers - 可选，覆盖能力→适配器的表；测试用它避开真实上游
 */
export function createSpeak({ registry, credentials, speakers = SPEAKERS }) {
  /**
   * @param capability - 能力名，目前只实现了 `tts`
   * @param input - `{ text, voice }`
   * @returns 适配器结果：`{ audio, durationMs, mime, format, model, voice }`
   * @throws HubError（status + code，消息可直接展示）
   */
  return async function speak(capability, input = {}) {
    const bindings = registry.resolve(capability)
    if (!bindings.length) throw new HubError(409, 'NOT_ENABLED', `世界网关的 ${capability} 插槽没启用`)
    const binding = bindings[0]
    const speaker = speakers[capability]
    if (!speaker) throw new HubError(501, 'NO_ADAPTER', `还没实现 ${capability} 的合成`)
    if (binding.kind !== 'dashscope') throw new HubError(501, 'NO_ADAPTER', `还没有 ${binding.kind} 的 ${capability} 适配器`)

    const text = typeof input.text === 'string' ? input.text : ''
    if (!text.trim()) throw new HubError(400, 'EMPTY_TEXT', '要合成的内容是空的')

    // 每次现解析，不缓存——凭据换了不用重启。
    const resolved = await credentials.resolve(binding.authRef)
    const apiKey = typeof resolved?.value === 'string' ? resolved.value : ''
    if (!apiKey) throw new HubError(502, 'SYNTHESIS_FAILED', `缺少凭据：${binding.authRef} 还没填`)

    try {
      return await speaker({ binding, apiKey, text, voice: input.voice, timeoutMs: 60_000 })
    } catch (error) {
      throw new HubError(502, 'SYNTHESIS_FAILED', String(error?.message ?? error))
    }
  }
}

/**
 * 世界网关的「现在能不能合成」：不合成，只回答就绪与否。
 *
 * 为什么也要进程内：语音插件判断「世界网关语音包在不在跑」时，原先去 fetch 网关的
 * `/health`——那是服务端请求，过不了会话校验，永远 401，于是面板上这个包永远显示
 * 「跑不起来」。真正的判据（插槽启用了吗、适配器有吗、凭据填了吗）本来就在进程里，
 * 直接读就行，不必绕一圈 HTTP。
 *
 * 只回答能力级就绪，不透露凭据内容。
 *
 * @returns `{ capability, ready, error? }`
 */
export function createStatus({ registry, credentials, speakers = SPEAKERS }) {
  return async function status(capability) {
    const bindings = registry.resolve(capability)
    if (!bindings.length) return { capability, ready: false, error: `世界网关的 ${capability} 插槽没启用` }
    const binding = bindings[0]
    if (!speakers[capability]) return { capability, ready: false, error: `还没实现 ${capability} 的合成` }
    if (binding.kind !== 'dashscope') return { capability, ready: false, error: `还没有 ${binding.kind} 的 ${capability} 适配器` }
    const ref = String(binding.authRef ?? '')
    if (ref) {
      const resolved = await credentials.resolve(ref)
      if (!resolved?.value) return { capability, ready: false, error: `缺少凭据：${ref} 还没填` }
    }
    return { capability, ready: true, model: binding.model ?? '', kind: binding.kind }
  }
}
