/**
 * 预制的模型候选：面板「从 N 个候选填入」在宿主注册表之外的第二来源。
 *
 * 为什么需要它：宿主只枚举 chat 模型（`llm` 注册表），asr / tts / embedding
 * 没有对应注册表，用户只能手抄 id。这里按 `(接入点, 能力)` 放一组确认过的 id，
 * 离线可用、不需要任何 key。
 *
 * 维护方式：`node scripts/explore-endpoints.mjs` 会拿真实 `/models` 列表核对本表，
 * 报出「命中 / 不在列表 / 列表里有但本表没有」三种情况；发现新模型时手工加一行即可。
 * 表里的 id 会随厂商更新而过期，所以它只是候选，输入框永远可以手填。
 */

/** 本表最近一次人工核对的日期；explore 脚本会打印它。 */
export const VERIFIED_AT = '2026-11-11'

/**
 * 各接入点的模型列表地址（不含 `/models` 后缀）。
 * Token Plan 没有列表接口（实测 404），留空表示只支持手填。
 */
export const LIST_BASE = {
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  minimax: 'https://api.minimax.chat/v1',
  'qwen-token-plan': '',
}

/** 新建插槽时的默认模型名；为空表示必须手填。 */
export const DEFAULT_MODEL = {
  asr: 'qwen-audio-3.1-asr-flash',
  tts: 'qwen-audio-3.1-tts-flash',
  decision: 'decision-model-preview',
  embedding: 'qwen3.7-text-embedding',
  omni: 'qwen-omni-turbo',
}

/** 面板直接展示的名字；缺省时用 id。 */
const LABELS = {
  'qwen-audio-3.1-asr-flash': '百炼 · 语音识别 3.1（Flash）',
  'qwen-audio-3.1-tts-flash': '百炼 · 语音合成 3.1（Flash）',
  'paraformer-v2': '百炼 · Paraformer v2（文件转写）',
  'cosyvoice-v2': '百炼 · CosyVoice v2',
  'cosyvoice-v1': '百炼 · CosyVoice v1',
  'qwen3.7-text-embedding': '百炼 · qwen3.7 文本向量',
  'text-embedding-v4': '百炼 · text-embedding v4',
  'text-embedding-v3': '百炼 · text-embedding v3',
  'qwen-omni-turbo': '百炼 · Qwen-Omni Turbo',
  'qwen-omni-turbo-latest': '百炼 · Qwen-Omni Turbo（latest）',
  'decision-model-preview': 'Token Plan · 决策模型（预览，免费）',
  'FunAudioLLM/SenseVoiceSmall': '硅基流动 · SenseVoice Small',
  'FunAudioLLM/CosyVoice2-0.5B': '硅基流动 · CosyVoice2 0.5B',
  'BAAI/bge-m3': '硅基流动 · bge-m3',
  'Qwen/Qwen3-Embedding-0.6B': '硅基流动 · Qwen3-Embedding 0.6B',
  'Qwen/Qwen3-Embedding-8B': '硅基流动 · Qwen3-Embedding 8B',
  'speech-02-hd': 'MiniMax · speech-02-hd',
  'speech-02-turbo': 'MiniMax · speech-02-turbo',
}

/**
 * `预设[能力][接入点] = [模型 id]`。
 * 只放确认过的 id；不确定的名字不写进来——候选里出现错名字比空着更糟。
 */
export const PRESET = {
  asr: {
    dashscope: ['qwen-audio-3.1-asr-flash', 'paraformer-v2'],
    siliconflow: ['FunAudioLLM/SenseVoiceSmall'],
  },
  tts: {
    dashscope: ['qwen-audio-3.1-tts-flash', 'cosyvoice-v2', 'cosyvoice-v1'],
    siliconflow: ['FunAudioLLM/CosyVoice2-0.5B'],
    minimax: ['speech-02-hd', 'speech-02-turbo'],
  },
  decision: {
    'qwen-token-plan': ['decision-model-preview'],
  },
  embedding: {
    dashscope: ['qwen3.7-text-embedding', 'text-embedding-v4', 'text-embedding-v3'],
    siliconflow: ['BAAI/bge-m3', 'Qwen/Qwen3-Embedding-0.6B', 'Qwen/Qwen3-Embedding-8B'],
  },
  omni: {
    dashscope: ['qwen-omni-turbo', 'qwen-omni-turbo-latest'],
  },
}

/**
 * 某能力在某接入点下的预制候选（含展示名）。
 * @param capability - 能力名
 * @param kind - 接入点类型
 * @returns `[{ id, name, source: 'preset' }]`；没有则空数组
 */
export function presetFor(capability, kind) {
  const ids = PRESET[capability]?.[kind] ?? []
  return ids.map(id => ({ id, name: LABELS[id] ?? id, source: 'preset' }))
}

/** 所有出现过的模型 id，按能力归组——explore 脚本用它判断「哪些还没进表」。 */
export function presetIds() {
  const ids = {}
  for (const [capability, kinds] of Object.entries(PRESET)) {
    ids[capability] = Object.values(kinds).flat()
  }
  return ids
}
