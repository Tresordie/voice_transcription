// 时间轴可视化：识别 markdown 表格中的时间轴数据，转换为 timeline.md 规范样式的
// 直观时间轴（事件样式：竖线+彩色节点+日期胶囊；任务样式：状态节点+卡片+划线）。
// 全部使用行内样式 + hex 颜色，保证在预览/导出 HTML/打印 PDF/Word 兼容 HTML 中一致。
// 颜色语义来自 scenario-templates/timeline.md 规范。

export interface TimelineEntry {
  time: string
  title: string
  desc: string
  status: string
}

export interface TimelineData {
  entries: TimelineEntry[]
  /** event = 事件时间轴（蓝/棕/红阶段点）；task = 任务时间轴（状态节点+逾期红） */
  style: 'event' | 'task'
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 是否为时间列（表头关键字或 mm:ss 值特征） */
function isTimeText(s: string): boolean {
  return /时间|日期|时间戳|时间点|when|date/i.test(s) || /^\d{1,2}:\d{2}$/.test(s.trim())
}

/**
 * 检测表格是否为时间轴数据：需要「时间列」+「事件/任务列」。
 * 时间列判定：表头含时间关键字，或该列的值全部形如 mm:ss / 日期。
 */
export function detectTimeline(header: string[], rows: string[][]): TimelineData | null {
  if (rows.length < 2 || header.length < 2) return null

  const timeCol =
    header.findIndex((h) => isTimeText(h)) >= 0
      ? header.findIndex((h) => isTimeText(h))
      : // 值特征兜底：第一列全为 mm:ss 形态
        rows.every((r) => /^\d{1,2}:\d{2}(\.\d+)?$/.test((r[0] ?? '').trim()))
        ? 0
        : -1
  if (timeCol < 0) return null

  const used = new Set<number>([timeCol])
  const pick = (re: RegExp): number => {
    const idx = header.findIndex((h, i) => !used.has(i) && re.test(h))
    if (idx >= 0) {
      used.add(idx)
      return idx
    }
    return -1
  }
  const statusCol = pick(/状态|完成情况|进度|结果/i)
  let titleCol = pick(/事件|标题|事项|任务|议题|节点|动作|阶段/i)
  let descCol = pick(/内容|说明|详情|描述|要点|备注|结论|负责人|发言人/i)
  if (titleCol < 0) {
    // 无显式标题列：取第一个未占用列
    titleCol = header.findIndex((_, i) => !used.has(i))
    if (titleCol >= 0) used.add(titleCol)
  }
  if (titleCol < 0) return null

  const entries: TimelineEntry[] = []
  for (const r of rows) {
    const time = (r[timeCol] ?? '').trim()
    const title = (r[titleCol] ?? '').trim()
    const status = statusCol >= 0 ? (r[statusCol] ?? '').trim() : ''
    const rest = header
      .map((_, i) => i)
      .filter((i) => !used.has(i))
      .map((i) => (r[i] ?? '').trim())
      .filter(Boolean)
    const desc = [descCol >= 0 ? (r[descCol] ?? '').trim() : '', ...rest]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' · ')
    if (!time && !title) continue
    entries.push({ time, title, desc, status })
  }
  if (entries.length < 2) return null

  const style: 'event' | 'task' = statusCol >= 0 ? 'task' : 'event'
  return { entries: entries.slice(0, 40), style }
}

// ---------- 阶段/状态配色（timeline.md 语义） ----------

function phaseColor(text: string): string {
  if (/完成|✅|成功|通过|正常|已解决/i.test(text)) return '#1a7f37'
  if (/失败|风险|⚠|异常|故障|错误|升级/i.test(text)) return '#b42318'
  if (/卡点|阻塞|停滞|延期|待确认|待补|pending/i.test(text)) return '#9a6700'
  return '#0b6bcb'
}

function taskStatus(text: string): { color: string; icon: string; done: boolean } {
  if (/完成|✅|已归档|已关闭/i.test(text)) return { color: '#22c55e', icon: '✅', done: true }
  if (/归档|📦/i.test(text)) return { color: '#6b7280', icon: '📦', done: true }
  if (/逾期|失败|❌|超时/i.test(text)) return { color: '#ef4444', icon: '❌', done: false }
  return { color: '#3b82f6', icon: '🚧', done: false }
}

// ---------- HTML 渲染（行内样式，预览/导出通用） ----------

/** 事件时间轴：竖线 + 阶段彩点 + 日期胶囊 + 标题/描述 */
function eventTimelineHtml(data: TimelineData): string {
  const items = data.entries
    .map((e) => {
      const color = phaseColor(`${e.time} ${e.title} ${e.status}`)
      return `<div style="position:relative;margin-bottom:16px;padding-left:4px;">
  <span style="position:absolute;left:-24px;top:6px;width:11px;height:11px;border-radius:50%;background:${color};border:2px solid #ffffff;box-shadow:0 0 0 1px #d1d5db;"></span>
  ${e.time ? `<span style="display:inline-block;background:#eff6ff;color:#0b6bcb;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600;">${esc(e.time)}</span>` : ''}
  <div style="font-weight:700;color:#111827;margin-top:3px;">${esc(e.title)}</div>
  ${e.desc ? `<div style="color:#6b7280;font-size:13px;margin-top:2px;">${esc(e.desc)}</div>` : ''}
</div>`
    })
    .join('\n')
  return `<div style="border:1px solid #e5e7eb;border-radius:12px;background:#ffffff;padding:20px 24px 8px;">
  <div style="position:relative;padding-left:26px;">
    <div style="position:absolute;left:9px;top:8px;bottom:14px;width:2px;background:#d1d5db;"></div>
    ${items}
  </div>
</div>`
}

/** 任务时间轴：状态节点 + 标题（完成划线）+ 描述 + 状态徽章 */
function taskTimelineHtml(data: TimelineData): string {
  const items = data.entries
    .map((e) => {
      const st = taskStatus(e.status || e.title)
      const done = st.done || /✅/.test(e.status)
      const overdue = /逾期|超时|❌/.test(`${e.status} ${e.title}`)
      const titleStyle = done
        ? 'font-weight:700;color:#9ca3af;text-decoration:line-through;'
        : overdue
          ? 'font-weight:700;color:#b42318;'
          : 'font-weight:700;color:#111827;'
      return `<div style="position:relative;margin-bottom:14px;">
  <span style="position:absolute;left:-24px;top:2px;width:14px;height:14px;border-radius:50%;background:#ffffff;border:3px solid ${st.color};"></span>
  <div style="${titleStyle}">${st.icon} ${esc(e.title)}${e.status ? ` <span style="display:inline-block;border-radius:999px;padding:0 8px;font-size:11px;font-weight:600;background:${st.color};color:#ffffff;">${esc(e.status)}</span>` : ''}</div>
  ${e.time ? `<div style="color:#6b7280;font-size:12px;margin-top:1px;">⏱ ${esc(e.time)}${overdue ? ' · <span style="color:#b42318;font-weight:600;">已逾期</span>' : ''}</div>` : ''}
  ${e.desc ? `<div style="color:#6b7280;font-size:13px;margin-top:2px;">${esc(e.desc)}</div>` : ''}
</div>`
    })
    .join('\n')
  return `<div style="border:1px solid #e5e7eb;border-radius:12px;background:#ffffff;padding:20px 24px 8px;">
  <div style="position:relative;padding-left:26px;">
    <div style="position:absolute;left:9px;top:8px;bottom:12px;width:2px;background:#d1d5db;"></div>
    ${items}
  </div>
</div>`
}

export function renderTimelineHtml(data: TimelineData): string {
  return data.style === 'task' ? taskTimelineHtml(data) : eventTimelineHtml(data)
}

// ---------- SVG 生成（PPT 插图用：svgTextToPng 转 PNG） ----------

/** 紧凑纵向时间轴 SVG（PPT 单页展示，最多 12 条） */
export function timelineEntriesToSvg(data: TimelineData): string {
  const entries = data.entries.slice(0, 12)
  const rowH = 56
  const width = 760
  const height = entries.length * rowH + 40
  const body = entries
    .map((e, i) => {
      const y = 30 + i * rowH
      const isTask = data.style === 'task'
      const color = isTask ? taskStatus(e.status || e.title).color : phaseColor(`${e.time} ${e.title} ${e.status}`)
      const title = esc(e.title.slice(0, 40))
      const desc = esc(e.desc.slice(0, 56))
      const time = esc(e.time.slice(0, 24))
      return `<g>
  <circle cx="52" cy="${y}" r="7" fill="${color}" stroke="#ffffff" stroke-width="2"/>
  <text x="76" y="${y - 6}" font-size="17" font-weight="700" fill="#111827">${title}</text>
  <text x="76" y="${y + 16}" font-size="13" fill="#6b7280">${desc}</text>
  ${time ? `<text x="${width - 40}" y="${y}" font-size="14" text-anchor="end" font-weight="600" fill="#0b6bcb">${time}</text>` : ''}
</g>`
    })
    .join('\n')
  const lineH = entries.length * rowH
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <line x1="52" y1="24" x2="52" y2="${24 + lineH - rowH + 8}" stroke="#d1d5db" stroke-width="2"/>
  ${body}
</svg>`
}
