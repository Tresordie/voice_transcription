// 本地模型输出规整：streaming zipformer 的英文词表为全大写 BPE，
// 英文转写结果会是 "EVERY DESIGN YOU INTERACT..." 这种全大写形态。
// 此模块检测到"绝大多数单词全大写"时，转为句子式大小写；
// 正常大小写的文本（在线引擎、中文）不会被触碰。

/** 文本中的英文单词是否绝大多数（>80%）为全大写 */
export function isMostlyUpper(text: string): boolean {
  const words = text.match(/[A-Za-z']+/g) ?? []
  const counted = words.filter((w) => w.length >= 2)
  if (counted.length === 0) return false
  const upper = counted.filter((w) => w === w.toUpperCase()).length
  return upper / counted.length > 0.8
}

/** 全大写文本 → 句子式大小写（句首大写，独立 "i" → "I"） */
export function sentenceCase(text: string): string {
  let out = text.toLowerCase()
  // 句首（文本开头 / . ! ? 。 ！ ？ 换行 之后）字母大写
  out = out.replace(/(^|[.!?。！？]\s*|\n)([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase())
  // 独立的 "i" 恢复为 "I"
  out = out.replace(/\bi\b/g, 'I')
  return out
}

/** 本地引擎结果规整入口：仅在检测到全大写形态时改写 */
export function fixLocalCase(text: string): string {
  const t = text.trim()
  if (!t) return text
  return isMostlyUpper(t) ? sentenceCase(t) : text
}
