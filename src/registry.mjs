import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { CAPABILITIES, CAPABILITY_SPECS, KINDS, deriveAuthRef } from './capabilities.mjs'

const FIELDS = ['enabled', 'kind', 'baseURL', 'model', 'authRef', 'note']
const LIMITS = { baseURL: 512, model: 200, authRef: 128, note: 500 }
const AUTH_REF_RE = /^[A-Z][A-Z0-9_]{1,127}$/

function defaultSlots() {
  const slots = {}
  for (const capability of CAPABILITIES) {
    const { defaults } = CAPABILITY_SPECS[capability]
    slots[capability] = {
      enabled: false,
      kind: defaults.kind,
      baseURL: defaults.baseURL,
      model: defaults.model,
      authRef: deriveAuthRef(defaults.kind),
      note: '',
    }
  }
  return slots
}

function text(value, field) {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length > LIMITS[field]) throw new Error(`${field} 超过 ${LIMITS[field]} 个字符`)
  return trimmed
}

function validate(capability, current, patch) {
  if (!CAPABILITIES.includes(capability)) throw new Error(`未知能力：${String(capability)}`)
  const next = { ...current }
  for (const [field, value] of Object.entries(patch ?? {})) {
    if (!FIELDS.includes(field)) throw new Error(`未知字段：${field}`)
    if (field === 'enabled') {
      if (typeof value !== 'boolean') throw new Error('enabled 必须是布尔值')
      next.enabled = value
      continue
    }
    next[field] = text(value, field)
  }
  if (!KINDS.includes(next.kind)) throw new Error(`未知接入点类型：${next.kind}`)
  if (!next.baseURL.startsWith('https://')) throw new Error('baseURL 必须以 https:// 开头')
  if (/\s/.test(next.baseURL)) throw new Error('baseURL 不能包含空白字符')
  if (!next.model) throw new Error('模型名不能为空')
  // 接入点类型变了而凭据引用还是上一个类型的默认值时，跟着改；用户写过的值不动。
  if (patch?.kind !== undefined && patch.authRef === undefined && current.authRef === deriveAuthRef(current.kind)) {
    next.authRef = deriveAuthRef(next.kind)
  }
  if (!next.authRef) next.authRef = deriveAuthRef(next.kind)
  if (!AUTH_REF_RE.test(next.authRef)) throw new Error('凭据引用名只能是大写字母、数字与下划线，且以字母开头')
  next.note = next.note ?? ''
  return next
}

/**
 * 能力插槽的持久化：`registry.json` 是唯一真源，不含任何密钥。
 * 写入先落 `.tmp` 再 `rename`，读坏文件时改名备份并回落到默认值。
 * @param options.file - registry.json 的绝对路径
 * @param options.now - 备份文件名用的时间戳来源（测试可注入）
 */
export function createRegistry({ file, now = () => Date.now() }) {
  let recovered = false
  let slots = defaultSlots()

  function load() {
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const next = defaultSlots()
      for (const capability of CAPABILITIES) {
        const stored = parsed?.slots?.[capability]
        if (!stored) continue
        next[capability] = validate(capability, next[capability], stored)
      }
      slots = next
    } catch (error) {
      renameSync(file, `${file}.corrupt-${now()}`)
      recovered = true
      slots = defaultSlots()
      return { error }
    }
  }

  function save() {
    const body = `${JSON.stringify({ version: 1, slots }, null, 2)}\n`
    writeFileSync(`${file}.tmp`, body, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  load()

  return {
    /** 当前全部插槽（副本）与是否从损坏文件恢复过。 */
    state() {
      return { version: 1, slots: structuredClone(slots), recovered }
    },
    /** 改一个插槽并立刻落盘，返回新的插槽。 */
    patch(capability, patch) {
      const next = validate(capability, slots[capability], patch)
      slots[capability] = next
      save()
      return structuredClone(next)
    },
    /** 已启用插槽的绑定，按能力目录顺序；未启用返回空数组。 */
    resolve(capability) {
      if (!CAPABILITIES.includes(capability)) throw new Error(`未知能力：${String(capability)}`)
      const slot = slots[capability]
      if (!slot?.enabled) return []
      return [{ capability, kind: slot.kind, baseURL: slot.baseURL, model: slot.model, authRef: slot.authRef }]
    },
  }
}

export { defaultSlots, validate }
