/**
 * DashScope（百炼）语音合成：把一段文字变成 wav 字节。
 *
 * 为什么单独一个文件：世界网关的 http.mjs 只做路由与鉴权，供应商协议放在这里，
 * 以后加 minimax / siliconflow 是并列的另一个文件，不用改路由。
 *
 * 两条已验证的形状（2026-11-17 实测，见 docs/research/world-gateway-qwen-maas-smoke.md）：
 * - `aigc/multimodal-generation`：`qwen3-tts-flash` 这类，返回 `output.audio.url`（OSS 链接），
 *   还要再下载一次。
 * - `audio/tts/SpeechSynthesizer`：`qwen-audio-3.1-tts-flash` 这类，返回 `output.audio.data`
 *   （base64 wav）。
 * 两个都先试 aigc，失败再试 SpeechSynthesizer：前者是当前主流形状，后者兜底。
 *
 * 两个必须处理的现实：
 * 1. 百炼直出的 wav 头里 `data` 长度是流式占位值（0x7FFFFFFF 一类），必须按实际字节重写，
 *    否则播放器会以为这是十几小时的音频。
 * 2. 走代理时**大请求体**会在传输层被打断（实测 ECONNRESET / 握手超时，与内容无关只与体积有关）。
 *    所以这里不做 base64 上行，请求体始终是几百字节的 JSON。
 */

/** 音频上限：60 秒 24kHz 16bit 单声道约 2.9MB，留足余量。 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000

/** 把 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com` 拼成具体路径，别重复斜杠。 */
function joinUrl(base, path) {
  const root = String(base ?? '').trim().replace(/\/+$/, '')
  if (!root) throw new Error('baseURL 为空')
  // 兼容模式根直接输进来时（.../compatible-mode/v1）也要能认出主机根。
  const host = root.replace(/\/compatible-mode\/v\d+$/, '')
  return `${host}${path}`
}

/**
 * 修百炼流式 wav 头的长度字段。正常包原样返回，不复制。
 * @param buf - 原始字节
 * @returns 修好的 Buffer（必要时是新对象）
 */
export function repairWavHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return buf
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf
  const dataOff = buf.indexOf('data', 12, 'ascii')
  if (dataOff < 0 || dataOff + 8 > buf.length) return buf
  const declared = buf.readUInt32LE(dataOff + 4)
  const actual = buf.length - dataOff - 8
  if (declared <= actual && declared <= 0x7fffffff) return buf
  const fixed = Buffer.alloc(buf.length)
  buf.copy(fixed)
  fixed.writeUInt32LE(actual, dataOff + 4)
  fixed.writeUInt32LE(fixed.length - 8, 4)
  return fixed
}

/**
 * 从 wav 头算毫秒时长。非 wav 返回 0，不抛。
 * @param buf - wav 字节
 */
export function wavDurationMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return 0
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0
  let off = 12
  let byteRate = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ' && off + 20 <= buf.length) byteRate = buf.readUInt32LE(off + 16)
    if (id === 'data') {
      if (!byteRate || !size) return 0
      return Math.round((size / byteRate) * 1000)
    }
    off += 8 + size + (size % 2)
  }
  return 0
}

async function postJson(url, apiKey, body, timeoutMs) {
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
    if (error?.name === 'TimeoutError') throw new Error(`合成超时（>${Math.round(timeoutMs / 1000)}s）`)
    throw new Error(`连不上百炼：${error?.message ?? error}`)
  }
  const text = await res.text()
  if (!res.ok) {
    // 服务端的 code/message 要原样透出：鉴权、限流、模型不存在全靠这句话区分。
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

/** 下载 OSS 上的音频：只接受 http(s)，有大小上限，超时即断。 */
async function downloadAudio(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('百炼给的音频地址无效')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('百炼给的音频地址协议不支持')
  let res
  try {
    res = await fetch(parsed.href, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(`下载合成音频失败：${error?.message ?? error}`)
  }
  if (!res.ok) throw new Error(`下载合成音频失败：HTTP ${res.status}`)
  const length = Number(res.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_AUDIO_BYTES) throw new Error('合成音频过大')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_AUDIO_BYTES) throw new Error('合成音频过大')
  return buf
}

/**
 * 合成一段语音。
 * @param options.binding - `{ baseURL, model, authRef }`，来自 registry 的 resolve
 * @param options.apiKey - 已解密的凭据值；没有就直接报错，别发出无 key 的请求
 * @param options.text - 要说的内容
 * @param options.voice - 音色 id（如 `Cherry`）
 * @param options.timeoutMs - 单次请求超时
 * @returns `{ audio: Buffer, mime: 'audio/wav', format: 'wav', model, voice, durationMs }`
 */
export async function synthesizeWithDashscope({ binding, apiKey, text, voice, timeoutMs = 60_000 }) {
  if (!apiKey) throw new Error(`缺少凭据：${binding?.authRef ?? 'API key'} 还没填`)
  const model = String(binding?.model ?? '').trim()
  if (!model) throw new Error('没有配置 tts 模型')
  const say = String(text ?? '').trim()
  if (!say) throw new Error('要合成的内容是空的')
  if (say.length > 2000) throw new Error(`一次最多合成 2000 字（收到 ${say.length}）`)
  const speaker = String(voice ?? '').trim() || 'Cherry'

  const failures = []
  // 形状 A：aigc/multimodal-generation（返回 url）
  try {
    const json = await postJson(
      joinUrl(binding.baseURL, '/api/v1/services/aigc/multimodal-generation/generation'),
      apiKey,
      { model, input: { text: say, voice: speaker, language_type: 'Chinese' } },
      timeoutMs,
    )
    const audioUrl = json?.output?.audio?.url
    if (audioUrl) {
      const raw = await downloadAudio(audioUrl)
      const audio = repairWavHeader(raw)
      return { audio, mime: 'audio/wav', format: 'wav', model, voice: speaker, durationMs: wavDurationMs(audio) }
    }
    const b64 = json?.output?.audio?.data
    if (typeof b64 === 'string' && b64) {
      const audio = repairWavHeader(Buffer.from(b64, 'base64'))
      return { audio, mime: 'audio/wav', format: 'wav', model, voice: speaker, durationMs: wavDurationMs(audio) }
    }
    failures.push(`aigc：返回里没有 output.audio（${JSON.stringify(json).slice(0, 160)}）`)
  } catch (error) {
    failures.push(`aigc：${String(error?.message ?? error)}`)
  }

  // 形状 B：audio/tts/SpeechSynthesizer（返回 base64）
  try {
    const json = await postJson(
      joinUrl(binding.baseURL, '/api/v1/services/audio/tts/SpeechSynthesizer'),
      apiKey,
      { model, input: { text: say, voice: speaker } },
      timeoutMs,
    )
    const b64 = json?.output?.audio?.data
    if (typeof b64 === 'string' && b64) {
      const audio = repairWavHeader(Buffer.from(b64, 'base64'))
      return { audio, mime: 'audio/wav', format: 'wav', model, voice: speaker, durationMs: wavDurationMs(audio) }
    }
    failures.push('SpeechSynthesizer：返回里没有 output.audio.data')
  } catch (error) {
    failures.push(`SpeechSynthesizer：${String(error?.message ?? error)}`)
  }

  throw new Error(`合成失败：${failures.join('；')}`)
}
