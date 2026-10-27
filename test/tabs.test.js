/**
 * 选项卡注册表单测：`node --test test/tabs.test.js`
 *
 * 这一层要证明的不是"能注册"，而是三种失败形态**都有明确原因**：
 *   - id 撞车 → 第二个被拒，且说清被谁占用（否则插件作者只能靠猜）
 *   - 描述写错 → 立刻报错，不静默渲染成空白页（"装了没反应"是最难查的）
 *   - 动作返回值不可序列化 → 明确报错，而不是让前端收到 null
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TabError, TabRegistry } from '../src/console/tabs.js'

const make = () => {
  const logs = []
  return { reg: new TabRegistry({ log: (level, msg) => logs.push({ level, msg }) }), logs }
}

const basic = (over = {}) => ({
  id: 'voice',
  title: '语音',
  order: 50,
  owner: 'qdash-neo-plugin-voice',
  layout: [{ type: 'status', items: [{ label: '状态', value: '就绪' }] }],
  ...over,
})

test('选项卡：注册后出现在列表里，且按 order 排序', () => {
  const { reg } = make()
  reg.register(basic({ id: 'b', order: 200 }))
  reg.register(basic({ id: 'a', order: 10 }))
  assert.deepEqual(reg.list().map(t => t.id), ['a', 'b'])
  assert.equal(reg.size, 2)
  assert.equal(reg.has('a'), true)
})

test('选项卡：同 id 再注册被拒，原因里带占用者', () => {
  const { reg } = make()
  reg.register(basic())
  assert.throws(
    () => reg.register(basic({ owner: '另一个插件' })),
    err => {
      assert.ok(err instanceof TabError)
      assert.equal(err.code, 'tab-conflict')
      assert.equal(err.status, 400)
      assert.match(err.message, /已被占用/)
      assert.equal(err.conflictWith, 'qdash-neo-plugin-voice')
      return true
    },
  )
  // 冲突不影响已有选项卡
  assert.equal(reg.size, 1)
})

test('选项卡：id 非法（大写/下划线/超长/空）一律拒绝', () => {
  const { reg } = make()
  for (const id of ['Voice', 'vo_ice', '', 'a'.repeat(41), '-lead']) {
    assert.throws(() => reg.register(basic({ id })), /id 非法/, `应拒绝 ${JSON.stringify(id)}`)
  }
})

test('选项卡：缺 title / 空 layout / 未知块类型都给明确原因', () => {
  const { reg } = make()
  assert.throws(() => reg.register(basic({ title: '  ' })), /缺少 title/)
  assert.throws(() => reg.register(basic({ layout: [] })), /layout 不能为空/)
  assert.throws(() => reg.register(basic({ layout: [{ type: 'chart' }] })), /type 非法/)
})

test('选项卡：actions 的处理函数不进序列化结果，前端拿不到函数', () => {
  const { reg } = make()
  reg.register(
    basic({
      layout: [
        {
          type: 'actions',
          actions: [{ id: 'ping', label: '测试', run: () => 'pong' }],
        },
      ],
    }),
  )
  const [tab] = reg.list()
  const block = tab.layout[0]
  assert.equal(block.type, 'actions')
  assert.deepEqual(block.actions, [{ id: 'ping', label: '测试', description: '', confirm: '' }])
  // 可 JSON 化 —— 这一条就是"HTTP 能送出去"的证明
  assert.equal(JSON.parse(JSON.stringify(tab)).layout[0].actions.length, 1)
})

test('选项卡：动作 id 重复 / 缺 run 会被拒', () => {
  const { reg } = make()
  assert.throws(
    () =>
      reg.register(
        basic({
          layout: [
            {
              type: 'actions',
              actions: [
                { id: 'go', label: '一', run: () => 1 },
                { id: 'go', label: '二', run: () => 2 },
              ],
            },
          ],
        }),
      ),
    /动作 id 重复/,
  )
  assert.throws(
    () => reg.register(basic({ layout: [{ type: 'actions', actions: [{ id: 'go', label: '一' }] }] })),
    /缺少 run/,
  )
})

test('选项卡：表格块的列/行被校验并限长', () => {
  const { reg } = make()
  const rows = Array.from({ length: 600 }, (_, i) => [`第 ${i} 行`])
  reg.register(
    basic({
      layout: [{ type: 'table', title: '最近发送', columns: [{ label: '内容', num: false }], rows }],
    }),
  )
  const block = reg.list()[0].layout[0]
  assert.equal(block.rows.length, 500, '批量数据必须有上限：这是每 5 秒轮询一次的接口')
  assert.deepEqual(block.columns, [{ label: '内容', num: false }])

  assert.throws(() => reg.register(basic({ id: 't2', layout: [{ type: 'table', columns: [] }] })), /columns 不能为空/)
})

test('选项卡：注销后从列表消失，disposer 幂等', () => {
  const { reg } = make()
  const dispose = reg.register(basic())
  assert.equal(reg.size, 1)
  dispose()
  assert.equal(reg.size, 0)
  dispose() // 再调一次不该抛
})

test('选项卡：onChange 在注册/注销时各通知一次', () => {
  const { reg } = make()
  const seen = []
  const off = reg.onChange(list => seen.push(list.length))
  const dispose = reg.register(basic())
  dispose()
  off()
  reg.register(basic({ id: 'other' }))
  assert.deepEqual(seen, [1, 0], '退订之后不该再收到通知')
})

test('选项卡：动作只在服务端执行，返回值走 JSON', async () => {
  const { reg } = make()
  reg.register(
    basic({
      layout: [
        {
          type: 'actions',
          actions: [
            { id: 'echo', run: payload => ({ got: payload }) },
            { id: 'boom', run: () => BigInt(1) },
          ],
        },
      ],
    }),
  )
  const ok = await reg.run('voice', 'echo', { a: 1 })
  assert.deepEqual(ok, { ok: true, result: { got: { a: 1 } } })
  await assert.rejects(() => reg.run('voice', 'boom'), /不可序列化/)
  await assert.rejects(
    () => reg.run('voice', 'nope'),
    err => {
      assert.equal(err.status, 404)
      return true
    },
  )
  await assert.rejects(() => reg.run('ghost', 'echo'), /没有这个选项卡/)
})

test('选项卡：数量上限（防止轮询把标签页拖死）', () => {
  const { reg } = make()
  for (let i = 0; i < 50; i += 1) reg.register(basic({ id: `t${i}`, order: i }))
  assert.throws(() => reg.register(basic({ id: 'overflow' })), /上限/)
})

test('选项卡：clear 一次清空并通知', () => {
  const { reg } = make()
  reg.register(basic())
  let called = 0
  reg.onChange(() => {
    called += 1
  })
  reg.clear()
  assert.equal(reg.size, 0)
  assert.equal(called, 1)
})

/* ---------------- form 的可编辑标记 ---------------- */

test('form 块：带 submit 必须透传，否则前端永远只读', () => {
  const { reg } = make()
  reg.register({
    id: 'voice',
    title: '语音库',
    owner: 'p',
    layout: [
      {
        type: 'form',
        title: '可编辑',
        fields: [{ path: 'endpoint', label: '地址', type: 'string', value: 'http://x' }],
        submit: { id: 'save', label: '保存' },
      },
      {
        type: 'form',
        title: '只读',
        fields: [{ path: 'b', label: 'B', type: 'string', value: 'w' }],
      },
    ],
  })

  const layout = reg.list()[0].layout
  assert.equal(
    layout[0].submit?.id,
    'save',
    'submit 被规范化丢掉的话，blocks.js 只会渲染静态文本，面板上永远是「只读」',
  )
  assert.equal(layout[0].submit?.label, '保存')
  assert.equal(layout[1].submit, undefined, '不带 submit 的仍维持只读')
})

test('form 块：submit.id 为空或非法时当作只读，不报错', () => {
  const { reg } = make()
  reg.register({
    id: 'v2',
    title: 'T',
    owner: 'p',
    layout: [
      { type: 'form', fields: [{ path: 'a', label: 'A' }], submit: { id: '   ' } },
      { type: 'form', fields: [{ path: 'b', label: 'B' }], submit: 'not-an-object' },
    ],
  })
  const layout = reg.list()[0].layout
  assert.equal(layout[0].submit, undefined)
  assert.equal(layout[1].submit, undefined)
})
