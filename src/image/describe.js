/**
 * 给一张图写一句话说明（供以后翻聊天记录时用）。
 *
 * ## 为什么是独立调用，而不是让模型顺手记
 *
 * 试过让模型自己调 `image_mark` 记一句 —— **它不调**。
 * 原因很实在：看完图它就去回复群友了，"记一句给以后的自己看"对当下毫无收益，
 * 提示词里写了、工具返回值里也催了，都没用。
 *
 * 所以改成**内核自己调一次**：不看模型的自觉。
 *
 * ## 为什么绑定到 `qq_get_image`，而不是图片一进来就跑
 *
 * 图片进来时大多没人看（群里刷屏、表情包），每条都跑一次纯浪费。
 * 挂在 `qq_get_image` 里意味着：**只有模型真的要看图时才生成描述** ——
 * 而那种图恰恰是以后最可能被翻出来的。
 *
 * ## 复用同一份字节
 *
 * 调用方传的是 `attachments.saveImage()` 的返回值（`ref`），
 * 所以**不重复下载、不重复编码** —— 这是"原子"能做到的部分。
 * 唯一的额外成本是这一次模型调用本身（视觉 token）。
 */

/** 一句话描述的提示词。刻意短：这只是备注，不是影评。 */
const SYSTEM =
  '你在给聊天记录里的一张图写备注，供以后翻到时参考。' +
  '只写一句，不要客套、不要解释你在做什么。'

const PROMPT =
  '这张图是什么？一句话，20 字以内。\n' +
  '如果是表情包/梗图，只写它的**含义**（"无语""笑死""摸鱼摆烂"），不要描述画面；\n' +
  '如果是正经照片或截图，写**画面**（"柴犬趴在键盘上打字"）。\n' +
  '直接给那句话，不要引号、不要"这张图是"。'

/**
 * @param {object} opts
 * @param {object} opts.llm        DSH 的 `ctx.llm`
 * @param {object} opts.attachment `attachments.saveImage()` 的返回值
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {number} [opts.timeoutMs] 超时就放弃（这是锦上添花，不该拖慢主流程）
 * @param {Function} [opts.log]
 * @returns {Promise<string>} 描述；失败返回空串（调用方据此不写映射）
 */
export async function describeImage({
  llm,
  attachment,
  provider,
  model,
  timeoutMs = 12_000,
  log = () => {},
}) {
  if (!llm || typeof llm.stream !== 'function') return ''
  if (!attachment || !provider || !model) return ''

  const controller = new AbortController()
  let timer = null
  try {
    const stream = llm.stream({
      provider,
      model,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            // 和 `deferContext` 用的是同一种 block：复用已保存的附件，不再传字节
            { type: 'image', attachment },
          ],
        },
      ],
      // 一句话而已，给多了纯浪费（推理模型会先花几十 token 思考）
      maxTokens: 200,
      temperature: 0,
      signal: controller.signal,
    })

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`看图超时（${timeoutMs}ms）`))
      }, timeoutMs)
    })

    const consume = async () => {
      let text = ''
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        else if (chunk.type === 'error') {
          throw new Error(chunk.error?.message ?? chunk.message ?? '流返回 error')
        }
      }
      return text
    }

    const raw = await Promise.race([consume(), timeout])
    const line = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim()
      .slice(0, 60)

    return line
  } catch (err) {
    // 描述是锦上添花：失败就当作没有，绝不影响看图本身
    log('warn', `qdash-neo: 生成图片描述失败 msg=${err?.message}`)
    return ''
  } finally {
    if (timer) clearTimeout(timer)
  }
}
