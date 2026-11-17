/**
 * 世界网关的能力目录：只声明「有哪几种能力、默认怎么接」，不含任何供应商调用。
 *
 * 能力名是封闭枚举：配置里出现未列出的名字一律报错，避免长出自由字符串。
 */

import { DEFAULT_MODEL, presetFor } from './candidates.mjs'

/** 本网关负责的能力。chat / vision 不在此列——它们归 DSH 的「设置 → 模型」。 */
export const CAPABILITIES = ['asr', 'tts', 'decision', 'embedding', 'omni', 'realtime']

/** 已知接入点类型。新增一类供应商 = 在这里加一个 kind（adapter 另开一轮）。 */
export const KINDS = ['dashscope', 'qwen-token-plan', 'siliconflow', 'minimax', 'moss']

const DASHSCOPE_BASE = 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com'
const TOKEN_PLAN_BASE = 'https://token-plan.maas.qianwenaiapi.com'
const MOSS_BASE = 'https://api.mosi.cn'

/**
 * 每个接入点的 HTTP 基址。切接入点时用它换掉上一个接入点的基址，
 * 免得「选了模思、请求还发往百炼」这种配错能保存下来。
 * 百炼那一项保留 `{WorkspaceId}` 占位符：那是 MaaS 的既有默认，不在这里改。
 */
export const KIND_BASE = {
  dashscope: DASHSCOPE_BASE,
  'qwen-token-plan': TOKEN_PLAN_BASE,
  siliconflow: 'https://api.siliconflow.cn',
  minimax: 'https://api.minimax.chat',
  moss: MOSS_BASE,
}

/**
 * 每个能力的展示文案与默认接入参数。
 * `transport: 'websocket'` 的能力（实时语音）基址必须是 `wss://`，其余一律 `https://`。
 */
export const CAPABILITY_SPECS = {
  asr: {
    title: '语音识别',
    hint: '一段音频 → 文本。给语音输入、会议与语音条做准备。',
    defaults: { kind: 'dashscope', baseURL: DASHSCOPE_BASE, model: DEFAULT_MODEL.asr },
  },
  tts: {
    title: '语音合成',
    hint: '一段文本 → 音频。Live2D 说话时读取这里，但接入由那个项目自己决定。',
    defaults: { kind: 'dashscope', baseURL: DASHSCOPE_BASE, model: DEFAULT_MODEL.tts },
  },
  decision: {
    title: '决策模型',
    hint: '状态与问题 → 选项 + 置信度。用于路由、判定一类的结构化选择。',
    defaults: { kind: 'qwen-token-plan', baseURL: TOKEN_PLAN_BASE, model: DEFAULT_MODEL.decision },
  },
  embedding: {
    title: '向量化',
    hint: '文本 → 向量。记忆召回的候选，是否换库由对照测决定。',
    defaults: { kind: 'dashscope', baseURL: DASHSCOPE_BASE, model: DEFAULT_MODEL.embedding },
  },
  omni: {
    title: '全模态理解',
    hint: '音频 / 视频 → 文本。能「听」的那一类模型。',
    defaults: { kind: 'dashscope', baseURL: DASHSCOPE_BASE, model: DEFAULT_MODEL.omni },
  },
  realtime: {
    title: '实时语音',
    hint: '一条常驻的全双工音频通道，不是一问一答。这里只记接入参数；WS 管线与回声消除尚未实现。',
    transport: 'websocket',
    defaults: { kind: 'moss', baseURL: 'wss://api.mosi.cn/v1/realtime', model: DEFAULT_MODEL.realtime },
  },
}

/**
 * 某能力在某接入点下的默认基址与模型。
 * 模型取该接入点预制候选的第一个（表里按推荐顺序排），没有候选时为空——
 * 空模型会在保存时被拒，让「这家没有这类模型」当场暴露，而不是沿用上一家的 id。
 * @param capability - 能力名
 * @param kind - 接入点类型
 * @returns `{ baseURL, model }`；未知组合回落到能力自带的默认值
 */
export function defaultsFor(capability, kind) {
  const spec = CAPABILITY_SPECS[capability]
  if (!spec) throw new Error(`未知能力：${String(capability)}`)
  const websocket = spec.transport === 'websocket'
  // 实时语音目前只有模思给出过 wss 地址；别的接入点没有可确认的地址，沿用其 HTTP 基址，
  // 保存时会被 `wss://` 校验挡下（宁可报错，也不编一个地址）。
  const baseURL = websocket && kind === 'moss'
    ? spec.defaults.baseURL
    : KIND_BASE[kind] ?? spec.defaults.baseURL
  return { baseURL, model: presetFor(capability, kind)[0]?.id ?? '' }
}

/**
 * 由接入点类型派生凭据引用名，规则与 DSH 的 `deriveKeyRef` 一致：
 * `qwen-token-plan` → `QWEN_TOKEN_PLAN_API_KEY`、`moss` → `MOSS_API_KEY`。
 * 所以把主设置里的 provider id 起成同一个名字时，两边自动共用同一份凭据。
 * @param kind - 接入点类型
 * @returns 形如 `DASHSCOPE_API_KEY` 的凭据引用名
 */
export function deriveAuthRef(kind) {
  return `${kind.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}
