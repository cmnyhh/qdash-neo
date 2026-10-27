/**
 * Markdown → 纯文本（出站前清洗，M2）。
 *
 * 为什么必须清：QQ 不渲染 Markdown。不清的话，模型回的「**重点**」「## 结论」「[链接](url)」
 * 会连符号一起显示，用户看到的是 `**重点**` 而不是加粗的重点 —— 等于把排版噪声发给用户。
 *
 * 三条设计约束：
 *   1. **只去符号、不动内容**。链接保留 URL（QQ 里点不开，但人能看到地址）；
 *      表格竖线保留 —— 那是 QQ 里唯一还剩的结构线索。
 *   2. **幂等**：`toPlainText(toPlainText(x)) === toPlainText(x)`。
 *      这是可测的正确性，不是洁癖：清洗一旦会被调用两次（重试、控制台预览），
 *      不幂等的实现会让文本越洗越少。
 *   3. **围栏代码块只去围栏行，内容照常清洗**。行内规则刻意保守
 *      （`**` 必须成对且首尾都紧贴非空白），所以 `**kwargs`、`a * b` 这类代码不会被误伤；
 *      统一处理是幂等的前提 —— 若围栏内容跳过清洗，第二次清洗就会把它当正文改写。
 */

/** 行内符号 → 纯文本。顺序有讲究：图片先于链接（`![a](b)` 也满足链接的形状） */
function stripInline(line) {
  return (
    line
      // ![alt](url) → alt (url)；没有 alt 时只留 url
      .replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_, alt, url) =>
        alt ? `${alt} (${url})` : url,
      )
      // [text](url) → text (url)
      .replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, '$1 ($2)')
      // 行内代码去反引号
      .replace(/`+([^`\n]+?)`+/g, '$1')
      // 粗体：首尾都必须紧贴非空白，避免把 `**kwargs` 或 `a ** b` 当成语法
      .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '$1')
      .replace(/__(?=\S)([^_\n]*?\S)__/g, '$1')
      // 删除线
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
      // 斜体：外侧不能再是词字符，否则 `a*b*c` 这种算式会被吃掉
      .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1')
      .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1')
  )
}

/** 行首块级符号 → 纯文本；返回 null 表示**整行删除**（不是留个空行） */
function stripBlock(line) {
  let s = line
  // 引用可以嵌套（> > 两层）
  while (/^\s{0,3}>\s?/.test(s)) s = s.replace(/^\s{0,3}>\s?/, '')
  // 分割线：必须在列表判断之前，否则 `---` 会被当成 "· --"
  // 删整行而不是留空行 —— 否则 `A\n---\nB` 会变成 `A\n\nB`，凭空多出一个段落
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(s)) return null
  // 标题井号
  s = s.replace(/^\s{0,3}#{1,6}\s+/, '')
  // 无序列表 → 中点（保留"这是一条"的结构感，又不会和 Markdown 语法混淆）
  s = s.replace(/^(\s*)[-*+]\s+/, '$1· ')
  // 有序列表保留序号（编号本身是信息）
  s = s.replace(/^(\s*)(\d{1,3})[.)]\s+/, '$1$2. ')
  return s
}

/**
 * @param {string} text
 * @returns {string} 纯文本（永不返回 null；空输入返回空串）
 */
export function toPlainText(text) {
  const src = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ') // nbsp → 普通空格，否则 QQ 里显示成奇怪的空位
  if (!src.trim()) return ''

  const out = []
  // 围栏 ```/~~~ 只需成对识别：进去后不再判断行首符号，出来继续
  let inFence = false

  for (const rawLine of src.split('\n')) {
    const isFence = /^\s{0,3}(```|~~~)/.test(rawLine)
    if (isFence) {
      // 围栏行本身丢掉（包括语言标记 ```js 那一行）
      inFence = !inFence
      continue
    }
    // 围栏内：内容按原文保留格式，但仍走行内清洗 —— 幂等的前提（见文件头第 3 条）
    const line = inFence ? rawLine : stripBlock(rawLine)
    if (line === null) continue
    out.push(stripInline(line).replace(/\s+$/, ''))
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n') // 3 行以上空行压成 1 个空行
    .trim()
}
