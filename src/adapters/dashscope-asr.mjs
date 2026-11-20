/**
 * DashScope（百炼）语音识别：wav 字节进、文本出。
 *
 * 与 tts 那个适配器并列，互不影响；路由只负责转交。
 *
 * 已实测的形状（2026-11-18，见 docs/logs/2026-11-world-gateway/v0.2.0-capability-service-asr/）：
 * - 只走原生路径 `aigc/multimodal-generation`，`content[].type='input_audio'`，
 *   外加 `parameters.format` / `parameters.sample_rate`。
 * - 兼容模式 `/compatible-mode/v1/audio/transcriptions` 在这个接入点是 **404**，没有这条路。
 * - `input_audio.data` 必须是 **data URL**（`data:audio/wav;base64,…`）：
 *   裸 base64 串会被服务端判 500（返回体是流式的 sentence/text 骨架，text 为空）。
 *
 * 两个现实：
 * 1. 大请求体（几十 KB 起）在这台机器上走代理时会在传输层断（ECONNRESET / UND_ERR_SOCKET），
 *    与内容无关、只与体积有关。所以**网络层失败重试一次**，不做无限重试。
 * 2. 识别慢：4.4 秒中文音频实测约 21 秒（含一次重试），所以默认超时给到 120 秒。
 */

/** 音频上限：60 秒 16k 16bit 单声道约 1.9MB，base64 再涨 1/3，留足余量。 */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000

/** 把 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com` 拼成具体路径，别重复斜杠。 */
function joinUrl(base, path) {
  const root = String(base ?? '').trim().replace(/\/+$/, '')
  if (!root) throw new Error('baseURL 为空')
  const host = root.replace(/\/compatible-mode\/v\d+$/, '')
  return `${host}${path}`
}

/**
 * 从识别返回里取文本。不同模型/协议层放的字段不一样，按已验证的顺序找，找不到就返回 ''。
 * 不抛：调用方要靠「空文本」判断这次是不是真识别出了东西。
 * @param json - 已解析的返回体
 */
export function transcriptOf(json) {
  const direct = json?.output?.text ?? json?.text
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const content = json?.output?.choices?.[0]?.message?.content
  if (Array.isArray(content)) {
    const joined = content.map(item => (typeof item === 'string' ? item : item?.text)).filter(Boolean).join('')
    if (joined.trim()) return joined.trim()
  }
  const sentences = json?.output?.sentences ?? json?.sentences
  if (Array.isArray(sentences)) {
    const joined = sentences.map(item => item?.text).filter(Boolean).join('')
    if (joined.trim()) return joined.trim()
  }
  return ''
}

/** 音频字节 → data URL。裸 base64 服务端不收，这一点必须在这里固定住。 */
export function toAudioDataUrl(bytes, format = 'wav') {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const mime = String(format || 'wav').toLowerCase() === 'wav' ? 'audio/wav' : `audio/${String(format).toLowerCase()}`
  return `data:${mime};base64,${buf.toString('base64')}`
}

async function postJson(url, apiKey, body, timeoutMs) {
  let lastNetworkError = null
  // 只对网络层失败重试：HTTP 4xx/5xx 重试没有意义，会把一个明确的错误拖成慢错误。
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new Error(`识别超时（>${Math.round(timeoutMs / 1000)}s）`)
      lastNetworkError = error
      if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 1200)); continue }
      throw new Error(`连不上百炼：${error?.cause?.code ?? error?.message ?? error}`)
    }
    const text = await res.text()
    if (!res.ok) {
      let detail = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text)
        detail = parsed?.message ?? parsed?.error?.message ?? detail
      } catch {}
      const error = new Error(`百炼返回 ${res.status}：${detail}`)
      error.status = res.status
      throw error
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('百炼返回的不是 JSON')
    }
  }
  throw new Error(`连不上百炼：${lastNetworkError?.message ?? '未知网络错误'}`)
}

/**
 * 识别一段音频。
 * @param options.binding - `{ baseURL, model, authRef }`，来自 registry 的 resolve
 * @param options.apiKey - 已解密的凭据值；没有就直接报错，别发出无 key 的请求
 * @param options.audio - wav 字节（Buffer）或 base64 串
 * @param options.format - `wav`（目前只验过这一种）
 * @param options.sampleRate - 采样率，缺省 16000（与 dsh-local-asr 的规范音频一致）
 * @param options.timeoutMs - 单次请求超时
 * @returns `{ text, model, requestId, durationMs }`；文本可能为空串（静音/无语音），这不算失败
 */
export async function transcribeWithDashscope({ binding, apiKey, audio, format = 'wav', sampleRate, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) throw new Error(`缺少凭据：${binding?.authRef ?? 'API key'} 还没填`)
  const model = String(binding?.model ?? '').trim()
  if (!model) throw new Error('没有配置 asr 模型')

  const bytes = Buffer.isBuffer(audio) ? audio : (typeof audio === 'string' ? Buffer.from(audio, 'base64') : null)
  if (!bytes || bytes.length === 0) throw new Error('要识别的音频是空的')
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error(`音频太大（${bytes.length} 字节，上限 ${MAX_AUDIO_BYTES}）`)

  const started = Date.now()
  const json = await postJson(
    joinUrl(binding.baseURL, '/api/v1/services/aigc/multimodal-generation/generation'),
    apiKey,
    {
      model,
      input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: toAudioDataUrl(bytes, format) } }] }] },
      parameters: { format: String(format || 'wav').toLowerCase(), sample_rate: String(sampleRate || 16000) },
    },
    timeoutMs,
  )

  return {
    text: transcriptOf(json),
    model,
    requestId: json?.request_id ?? null,
    durationMs: Date.now() - started,
    audioSeconds: Number(json?.usage?.duration ?? 0) || 0,
  }
}
