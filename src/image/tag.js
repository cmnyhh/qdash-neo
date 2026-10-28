/**
 * 把文本里的 `[图片:<file>]` 换成描述。
 *
 * ## 为什么单独一个文件
 *
 * `[图片:xxx]` 会出现在**两处** prompt 里：
 *
 *   - 「群聊记录」(`pipeline/context.js` 的 `renderContextBlock`)
 *   - 「最近对话」(`memory/index.js` 的 `renderRecent`)
 *
 * 这两段是**拼起来用**的（前者是上下文窗口内、后者补窗口外），所以
 * **替换规则必须完全一致** —— 否则同一张图在前一段显示成描述、
 * 在后一段只剩 `[图片]`，模型会以为那是**两张不同的图**。
 *
 * 这个错误真的发生过：先只改了 `renderContextBlock`，忘了 `renderRecent`，
 * 于是「最近对话」里全是 `[图片]`，而映射里 7 条描述都在。
 * 排查时还以为是模型没调 `image_mark`。
 *
 * 所以抽成一个函数：**要改规则，只改这里**。
 *
 * ## 两条硬约束
 *
 * 1. **绝不输出 id**。历史里的图不允许再读一次（视觉 token 是大头，
 *    而旧图对当下几乎无用）。没有 id，`qq_get_image` 连调都调不了 ——
 *    这比写"不要回看"的禁令可靠：禁令会被忽略，缺参数不会。
 * 2. **查不到就降级成 `[图片]`**，不抛错、不阻塞。描述是锦上添花，
 *    渲染路径不能因为它失败。
 *
 * @param {string} text 可能含 `[图片:xxx]` 的原文
 * @param {((file: string) => string|undefined|null)|null} [imageDesc] 查描述的同步函数
 * @returns {string}
 */
export function renderImageTags(text, imageDesc = null) {
  const t = String(text ?? '')
  if (!t.includes('[图片')) return t

  return t.replace(/\[图片:([^\]]+)\]/g, (_match, file) => {
    let desc = ''
    try {
      desc = String(imageDesc?.(String(file).trim()) ?? '').trim()
    } catch {
      // 查映射失败当作"没描述"，绝不让渲染抛错
      desc = ''
    }
    return desc ? `[${desc}]` : '[图片]'
  })
}
