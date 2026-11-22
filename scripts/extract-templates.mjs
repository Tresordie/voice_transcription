// 一次性脚本：从 scenario-templates 技能的 gallery HTML 提取 25 套总结模板 JSON，
// 生成 src/lib/ai/templates.ts（应用内置的预设模板数据）。
//
// 用法：node scripts/extract-templates.mjs [gallery.html 路径]
// 默认源：C:\Users\Administrator\.agents\skills\scenario-templates\assets\skill-templates-gallery.html
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_SRC =
  'C:/Users/Administrator/.agents/skills/scenario-templates/assets/skill-templates-gallery.html'
const OUT = path.resolve(import.meta.dirname, '../src/lib/ai/templates.ts')

const src = process.argv[2] ?? DEFAULT_SRC
const html = fs.readFileSync(src, 'utf8')

// 提取 const DATA = {...};（JSON 对象字面量，键带引号）
const start = html.indexOf('const DATA = ')
if (start < 0) throw new Error('未找到 const DATA = ...')
let i = start + 'const DATA = '.length
// 括号配对扫描（字符串内忽略花括号）
let depth = 0
let inStr = false
let quote = ''
let end = -1
for (; i < html.length; i++) {
  const c = html[i]
  if (inStr) {
    if (c === '\\') i++
    else if (c === quote) inStr = false
    continue
  }
  if (c === '"' || c === "'") {
    inStr = true
    quote = c
  } else if (c === '{') depth++
  else if (c === '}') {
    depth--
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}
if (end < 0) throw new Error('DATA 对象未闭合')
const raw = html.slice(start + 'const DATA = '.length, end)
const data = JSON.parse(raw)

const t = data.templates ?? []
if (!Array.isArray(t) || t.length === 0) throw new Error('DATA.templates 为空')

const SCENARIO_NAMES = { MTG: '🎙️ 会议', RPT: '📊 日报周报', TASK: '✅ 任务', SUM: '📥 邮件总结', WRT: '✉️ 邮件撰写' }
// 场景分组始终按模板 scenario 码派生（按出现顺序），不依赖 gallery 的 scenarios 字段结构
const scenarioIds = [...new Set(t.map((x) => x.scenario))]
const scenarios = scenarioIds.map((id) => ({ id, name: SCENARIO_NAMES[id] ?? id }))

const file = `// 本文件由 scripts/extract-templates.mjs 生成（数据源：scenario-templates 技能 gallery HTML）。
// 重新生成：node scripts/extract-templates.mjs [gallery.html 路径]
// 手改无效——请改数据源后重跑脚本。

/** 场景分组 */
export interface Scenario {
  id: string
  name: string
}

/** 一套总结模板 */
export interface SummaryTemplate {
  id: string
  scenario: string
  name: string
  type: string
  desc: string
  /** 适用输入说明（展示用） */
  input: string
  /** 输出模块列表（展示用） */
  modules: string[]
  /** 完整提示词（含 {{占位符}} 与 G-SPEC 输出契约） */
  prompt: string
}

export const G_SPEC: string = ${JSON.stringify(data.cc ?? '', null, 2).replace(/\n/g, '\n  ')}

export const SCENARIOS: Scenario[] = ${JSON.stringify(scenarios, null, 2).replace(/\n/g, '\n  ')}

export const TEMPLATES: SummaryTemplate[] = ${JSON.stringify(
    t.map((x) => ({
      id: x.id,
      scenario: x.scenario,
      name: x.name,
      type: x.type,
      desc: x.desc,
      input: x.input,
      modules: x.modules,
      prompt: x.prompt,
    })),
    null,
    2,
  ).replace(/\n/g, '\n  ')}
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, file, 'utf8')
console.log(`已生成 ${OUT}`)
console.log(`模板 ${t.length} 套，契约 ${data.cc?.length ?? 0} 字符`)
console.log('场景：', scenarioIds.join(', '))
