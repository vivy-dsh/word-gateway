#!/usr/bin/env node
/**
 * 核对预制候选：拿各接入点的真实 `/models` 列表，和 `src/candidates.mjs` 对账。
 *
 * 用法（在插件目录下）：
 *   node scripts/explore-endpoints.mjs              # 有人类可读的报告
 *   node scripts/explore-endpoints.mjs --json       # 机器可读
 *   node scripts/explore-endpoints.mjs --check      # 有 key 时核对，缺 id 就非 0 退出
 *
 * key 从环境变量读：DASHSCOPE_API_KEY / QWEN_TOKEN_PLAN_API_KEY / SILICONFLOW_API_KEY / MINIMAX_API_KEY。
 * 没有 key 也能跑：只报「这个接入点有没有列表接口」。
 */

import { DEFAULT_MODEL, LIST_BASE, PRESET, VERIFIED_AT, presetIds } from '../src/candidates.mjs'
import { CAPABILITIES, KINDS } from '../src/capabilities.mjs'

const KEY_ENV = {
  dashscope: 'DASHSCOPE_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  siliconflow: 'SILICONFLOW_API_KEY',
  minimax: 'MINIMAX_API_KEY',
}

const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const check = args.has('--check')
const TIMEOUT_MS = 15000

/**
 * 拉一个接入点的模型列表。
 * @param kind - 接入点类型
 * @returns `{ kind, base, status, ids, note }`
 */
async function listModels(kind) {
  const base = LIST_BASE[kind]
  if (!base) return { kind, base: '', status: 'none', ids: [], note: '该接入点没有列表接口（实测 404），只能手填' }
  const key = String(process.env[KEY_ENV[kind]] ?? '').trim()
  const headers = { accept: 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  try {
    const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const text = await response.text()
    if (!response.ok) {
      return { kind, base, status: response.status === 401 || response.status === 403 ? 'unauthorized' : 'http', ids: [], note: `HTTP ${response.status}：${text.slice(0, 120).replace(/\s+/g, ' ')}` }
    }
    let payload
    try { payload = JSON.parse(text) } catch { return { kind, base, status: 'bad-json', ids: [], note: text.slice(0, 120) } }
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
    const ids = rows.map(row => (typeof row?.id === 'string' ? row.id : '')).filter(Boolean)
    return { kind, base, status: 'ok', ids, note: `${ids.length} 个模型` }
  } catch (error) {
    return { kind, base, status: 'unreachable', ids: [], note: String(error?.message ?? error) }
  }
}

/** 把某接入点的真实列表与预制表对账。 */
function reconcile(entry) {
  const result = { kind: entry.kind, base: entry.base, status: entry.status, note: entry.note, byCapability: {} }
  if (entry.status !== 'ok') return result
  const live = new Set(entry.ids)
  const known = new Set()
  for (const capability of CAPABILITIES) {
    const preset = PRESET[capability]?.[entry.kind] ?? []
    if (!preset.length) continue
    for (const id of preset) known.add(id)
    result.byCapability[capability] = {
      hit: preset.filter(id => live.has(id)),
      missing: preset.filter(id => !live.has(id)),
    }
  }
  result.unclassified = entry.ids.filter(id => !known.has(id))
  return result
}

const reports = []
for (const kind of KINDS) reports.push(reconcile(await listModels(kind)))

const expectedDefaults = Object.entries(DEFAULT_MODEL).map(([capability, model]) => {
  const kind = Object.keys(PRESET[capability] ?? {})[0]
  const listed = kind ? (PRESET[capability][kind] ?? []).includes(model) : false
  return { capability, model, kind: kind ?? '', listed }
})

if (asJson) {
  console.log(JSON.stringify({ verifiedAt: VERIFIED_AT, reports, expectedDefaults, presetIds: presetIds() }, null, 2))
} else {
  console.log(`预制候选核对 · 表最近核对日期 ${VERIFIED_AT}\n`)
  for (const report of reports) {
    const head = report.status === 'ok' ? `✓ ${report.note}` : `· ${report.status} — ${report.note}`
    console.log(`${report.kind}  ${report.base || '(无列表接口)'}  ${head}`)
    for (const [capability, row] of Object.entries(report.byCapability)) {
      const parts = [`命中 ${row.hit.length}`, `不在列表 ${row.missing.length}`]
      if (row.missing.length) parts.push(`→ ${row.missing.join(', ')}`)
      console.log(`    ${capability}: ${parts.join(' · ')}`)
    }
    if (report.unclassified?.length) {
      console.log(`    未归类 ${report.unclassified.length}：${report.unclassified.slice(0, 8).join(', ')}${report.unclassified.length > 8 ? ' …' : ''}`)
    }
  }
  const bad = expectedDefaults.filter(row => row.listed === false)
  if (bad.length) {
    for (const row of bad) console.log(`⚠ 默认模型不在预制表里：${row.capability} → ${row.model}`)
  }
}

if (check) {
  const problems = []
  for (const report of reports) {
    for (const [capability, row] of Object.entries(report.byCapability ?? {})) {
      for (const id of row.missing) problems.push(`${report.kind}/${capability}: ${id} 不在真实列表里`)
    }
  }
  for (const row of expectedDefaults) if (row.listed === false) problems.push(`${row.capability}: 默认模型 ${row.model} 不在预制表里`)
  if (problems.length) {
    console.error(`\n核对失败 ${problems.length} 项：`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('\n核对通过。')
}
