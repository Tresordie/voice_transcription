// Markdown → 微信聊天框纯文本格式
// 微信聊天输入不保留富文本，此转换生成在微信中观感良好的纯文本排版：
// 标题→emoji+【】、列表→符号行、表格→竖线行、加粗/链接内联还原
const H2_ICONS = ['🔹', '📌', '✅', '📈', '⚠️', '💡', '🗂️', '📝']

function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim()
}

/** 把 markdown 表格转为「列1: 值 ｜ 列2: 值」行式，返回行文本与跳过的行数 */
function tableToLines(lines: string[], start: number): { out: string[]; next: number } {
  const rows: string[][] = []
  let i = start
  for (; i < lines.length && lines[i].includes('|'); i++) {
    const cells = lines[i]
      .split('|')
      .map((c) => inline(c.trim()))
      .filter((c, idx, arr) => !(idx === 0 && !c) && !(idx === arr.length - 1 && !c))
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue // 分隔行
    rows.push(cells)
  }
  const out: string[] = []
  if (rows.length >= 2) {
    const header = rows[0]
    for (let r = 1; r < rows.length; r++) {
      out.push(
        rows[r]
          .map((c, ci) => `${header[ci] ?? ''}：${c}`)
          .filter((s) => !s.endsWith('：'))
          .join(' ｜ '),
      )
    }
  } else {
    for (const r of rows) out.push(r.join(' ｜ '))
  }
  return { out, next: i }
}

/** 逐行转换（不引入完整 md 解析器，覆盖 G-SPEC 输出用到的结构） */
export function markdownToWeChat(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let h2Count = 0
  let ordered = 0
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim().startsWith('```')) {
      inCode = !inCode
      if (!inCode) out.push('')
      continue
    }
    if (inCode) {
      out.push(raw)
      continue
    }
    const line = raw.trimEnd()
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    // 表格
    if (line.includes('|') && lines[i + 1]?.match(/^\s*\|?[\s:-]+\|/)) {
      const t = tableToLines(lines, i)
      out.push(...t.out)
      i = t.next - 1
      continue
    }
    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const text = inline(h[2])
      if (level === 1) out.push(`📌【${text}】`)
      else if (level === 2) out.push(`${H2_ICONS[h2Count++ % H2_ICONS.length]} 【${text}】`)
      else out.push(`▫️ ${text}`)
      out.push('')
      ordered = 0
      continue
    }
    // 列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ul) {
      out.push(`• ${inline(ul[1])}`)
      continue
    }
    const ol = line.match(/^\s*(\d+)[.、]\s+(.*)$/)
    if (ol) {
      ordered++
      out.push(`${ordered}. ${inline(ol[2])}`)
      continue
    }
    // 引用
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      out.push(`💬 ${inline(quote[1])}`)
      continue
    }
    // 分割线
    if (/^(-{3,}|={3,}|\*{3,})$/.test(line.trim())) {
      out.push('————————')
      continue
    }
    // 常规段落
    out.push(inline(line))
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
