/**
 * 世界网关的能力目录：只声明「有哪几种能力、默认怎么接」，不含任何供应商调用。
 *
 * 能力名是封闭枚举：配置里出现未列出的名字一律报错，避免长出自由字符串。
 */

import { DEFAULT_MODEL } from './candidates.mjs'

/** 本网关负责的能力。chat / vision 不在此列——它们归 DSH 的「设置 → 模型」。 */
export const CAPABILITIES = ['asr', 'tts', 'decision', 'embedding', 'omni']

/** 已知接入点类型。新增一类供应商 = 在这里加一个 kind（adapter 另开一轮）。 */
export const KINDS = ['dashscope', 'qwen-token-plan', 'siliconflow', 'minimax']

const DASHSCOPE_BASE = 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com'
const TOKEN_PLAN_BASE = 'https://token-plan.maas.qianwenaiapi.com'

/** 每个能力的展示文案与默认接入参数；`invoke` 一律未实现。模型名取自 candidates 的默认表。 */
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
}

/**
 * 由接入点类型派生凭据引用名，规则与 DSH 的 `deriveKeyRef` 一致：
 * `qwen-token-plan` → `QWEN_TOKEN_PLAN_API_KEY`。
 * 所以把主设置里的 provider id 起成同一个名字时，两边自动共用同一份凭据。
 * @param kind - 接入点类型
 * @returns 形如 `DASHSCOPE_API_KEY` 的凭据引用名
 */
export function deriveAuthRef(kind) {
  return `${kind.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}
