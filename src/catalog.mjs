/**
 * 世界网关的能力候选目录：内置预制表 + 宿主已有注册表，两个来源合起来。
 *
 * 为什么两个来源：宿主只有 `llm` 注册表（chat 模型），asr / tts / embedding
 * 没有对应注册表。因此预制表保证这三个能力也有真实候选（离线可用），
 * 宿主注册表则覆盖「用户在『设置 → 模型』里配过的接入点」。
 * 两个来源都不发明模型名：预制表里只放确认过的 id，宿主那边只读现成的清单。
 */

import { CAPABILITIES, KINDS } from './capabilities.mjs'
import { presetFor } from './candidates.mjs'

const DISCOVERY_TIMEOUT_MS = 4000
const AUDIO_MODALITIES = new Set(['audio', 'video'])

/** 没有宿主候选来源的能力，告诉面板候选从哪来、为什么可能为空。 */
const NOTES = {
  asr: '候选含内置预制表；宿主不枚举转写模型，所以也可以手填。',
  tts: '候选含内置预制表；宿主没有语音合成注册表。',
  decision: '候选来自「设置 → 模型」里与接入点同名的 provider，以及内置预制表。',
  embedding: '候选含内置预制表；宿主没有向量模型注册表。',
  omni: '候选只列声明支持音频/视频输入的模型，外加内置预制表。',
}

/**
 * @param promise - 待限时等待的承诺
 * @param ms - 上限毫秒数
 * @returns 原承诺的结果；超时则以 `timeout` 拒绝
 */
function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms)
    }),
  ]).finally(() => { clearTimeout(timer) })
}

/** 同一接入点下按 id 去重：宿主候选在前，预制候选补在后。 */
function push(list, entry) {
  if (list.some(item => item.id === entry.id)) return
  list.push(entry)
}

/**
 * 建一个只读目录读取器。宿主服务一律用 `ctx.get()` 可选读取：缺了就退化，不报错。
 * @param ctx - 插件上下文
 * @returns 返回 `{ models, notes, failures }` 的异步函数
 */
export function createCatalog(ctx) {
  return async function readCatalog() {
    const models = {}
    for (const capability of CAPABILITIES) {
      models[capability] = {}
      for (const kind of KINDS) {
        const presets = presetFor(capability, kind)
        if (presets.length) models[capability][kind] = presets
      }
    }
    const failures = []

    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
      let providers = []
      try {
        providers = llm.listProviders() ?? []
      } catch {
        providers = []
      }
      for (const provider of providers) {
        const id = provider?.id
        // 只有与接入点同名的 provider 才能被选中：registry 只认 capabilities.KINDS。
        if (typeof id !== 'string' || !KINDS.includes(id)) continue
        let rows = []
        try {
          rows = await withTimeout(llm.listModels(id), DISCOVERY_TIMEOUT_MS)
        } catch {
          failures.push(id)
          continue
        }
        for (const row of rows ?? []) {
          if (typeof row?.id !== 'string' || !row.id) continue
          const entry = { id: row.id, name: typeof row.name === 'string' && row.name ? row.name : row.id, source: 'host' }
          models.decision[id] ??= []
          push(models.decision[id], entry)
          if (Array.isArray(row.inputModalities) && row.inputModalities.some(m => AUDIO_MODALITIES.has(m))) {
            models.omni[id] ??= []
            push(models.omni[id], entry)
          }
        }
      }
    }

    return { models, notes: { ...NOTES }, failures }
  }
}
