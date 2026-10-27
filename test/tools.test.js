/**
 * 工具层：读图降级、写类走队列、白名单挂载。
 *
 * 用假 `tools`（register/schemas/restrict/guard）验证，因为这些 API 由宿主提供，
 * 单测里拿不到真的 ToolRuntime；但**调用顺序与容错**是我们要保证的部分。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyToolPolicy,
  createQqTools,
  imageBytesOf,
  parseChatKey,
  sniffMediaType,
} from '../src/tools/index.js'

/** 最小的假工具运行时 */
function fakeTools({ available = [], failRegister = [] } = {}) {
  const registered = new Map()
  const calls = { restrict: [], guard: [] }
  return {
    registered,
    calls,
    register(def) {
      if (failRegister.includes(def.name)) throw new Error(`duplicate tool ${def.name}`)
      registered.set(def.name, def)
      return () => registered.delete(def.name)
    },
    schemas() {
      return [...available, ...registered.keys()].map(name => ({ name }))
    },
    restrict(filter) {
      calls.restrict.push(filter)
      return () => {}
    },
    guard(fn) {
      calls.guard.push(fn)
      return () => {}
    },
  }
}

test('会话键解析：群 / 私聊 / 未知', () => {
  assert.deepEqual(parseChatKey('g:123'), { kind: 'group', groupId: '123' })
  assert.deepEqual(parseChatKey('u:456'), { kind: 'private', userId: '456' })
  assert.equal(parseChatKey('x:1').kind, 'unknown')
})

test('图片类型嗅探：按魔数判断，不认扩展名', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  assert.equal(sniffMediaType(png), 'image/png')
  assert.equal(sniffMediaType(jpg), 'image/jpeg')
  assert.equal(sniffMediaType(gif), 'image/gif')
  assert.equal(sniffMediaType(webp), 'image/webp')
  assert.equal(sniffMediaType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null)
  assert.equal(sniffMediaType(new Uint8Array(0)), null)
})

test('取图字节：base64:// 能解出来，空值返回 null', async () => {
  const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  const bytes = await imageBytesOf({ file: `base64://${b64}` })
  assert.equal(bytes.length, 4)
  assert.equal(bytes[0], 0x89)
  assert.equal(await imageBytesOf({}), null)
  assert.equal(await imageBytesOf(null), null)
})

test('读图降级：没有附件服务时返回"看不了"，不抛错（用户要求）', async () => {
  // 12 字节的 PNG 头：sniffMediaType 要求至少 12 字节
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const client = { call: async () => ({ file: `base64://${Buffer.from(png).toString('base64')}` }) }
  const created = createQqTools({ chatKey: 'g:1', client, attachments: null, config: { tools: {} } })
  const def = created.defs.find(d => d.name === 'qq_get_image')
  const out = await def.execute({ file: 'a.png' }, { deferContext: () => {} })
  assert.equal(out.ok, false)
  assert.match(String(out.reason), /看不了|没有可用的图片通道/)
})

test('读图：有附件服务时把图交给 deferContext（模型才能看见）', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 0, 0, 0])
  const client = { call: async () => ({ file: `base64://${Buffer.from(png).toString('base64')}` }) }
  const deferred = []
  const attachments = {
    saveImage: async ({ data, mediaType }) => ({
      attachmentId: 'att-1',
      mediaType,
      bytes: data.length,
      width: 100,
      height: 50,
    }),
  }
  const created = createQqTools({ chatKey: 'g:1', client, attachments, config: { tools: {} } })
  const def = created.defs.find(d => d.name === 'qq_get_image')
  const out = await def.execute({ file: 'a.png' }, { deferContext: ctx => deferred.push(ctx) })

  assert.equal(out.ok, true)
  assert.equal(out.mediaType, 'image/png')
  assert.equal(deferred.length, 1, '必须 defer 一次')
  const block = deferred[0].content[0]
  assert.equal(block.type, 'image')
  assert.equal(block.attachment.attachmentId, 'att-1')
})

test('写类工具：入出站队列，不直连 OneBot', async () => {
  const client = { call: async () => assert.fail('写类不该直连 OneBot') }
  const queued = []
  const created = createQqTools({
    chatKey: 'g:1',
    client,
    enqueue: (k, text, meta) => queued.push({ k, text, meta }),
    enqueueSegments: (k, segments, meta) => queued.push({ k, segments, meta }),
    config: { tools: {} },
  })

  const send = created.defs.find(d => d.name === 'qq_send_message')
  const r = await send.execute({ text: '在' }, {})
  assert.equal(r.ok, true)
  // queued 是**实际发出条数**（按 outbound.split 拆过之后），不是布尔
  assert.equal(r.queued, 1)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].text, '在')
  assert.equal(created.sent.count, 1, '要记一笔，出站侧据此跳过自动转发')

  const img = created.defs.find(d => d.name === 'qq_send_image')
  await img.execute({ file: '/tmp/a.png' }, {})
  assert.equal(queued[1].segments[0].type, 'image')
})

test('白名单挂载：注册 QQ 工具、与真实清单求交集、高危不进 allow', () => {
  const tools = fakeTools({ available: ['fs_read', 'web_search', 'bash', 'mcp__x__y'] })
  const state = applyToolPolicy(tools, {
    chatKey: 'g:1',
    config: { tools: { externalAllow: ['mcp__x__y', 'mcp__gone__z'], internalAllow: ['bash'] } },
    deps: { client: { call: async () => ({}) } },
    log: () => {},
  })

  assert.ok(tools.registered.has('qq_get_image'), '读能力要注册')
  assert.ok(tools.registered.has('qq_send_message'), '写能力要注册')
  assert.equal(tools.registered.has('qq_kick'), false, '踢人默认不注册')

  const allow = tools.calls.restrict[0].allow
  assert.ok(allow.includes('qq_get_image'))
  assert.ok(allow.includes('fs_read'), '只读内置自动进白名单')
  assert.equal(allow.includes('bash'), false, '高危即便配了也不进 allow')
  assert.equal(allow.includes('mcp__x__y'), true)
  assert.equal(state.missing.includes('mcp__gone__z'), true, '不存在的项要留痕')
  assert.equal(tools.calls.guard.length, 1, 'guard 作为第二道保险')
})

test('白名单挂载：tools.enabled=false 时一个都不给', () => {
  const tools = fakeTools({ available: ['fs_read'] })
  const state = applyToolPolicy(tools, {
    chatKey: 'g:1',
    config: { tools: { enabled: false } },
    deps: {},
    log: () => {},
  })
  assert.deepEqual(state.names, [])
  assert.deepEqual(tools.calls.restrict[0], { allow: [] })
  assert.equal(tools.registered.size, 0)
})

test('白名单挂载：重名注册失败不炸（只留痕）', () => {
  const tools = fakeTools({ available: [], failRegister: ['qq_get_image'] })
  const state = applyToolPolicy(tools, {
    chatKey: 'g:1',
    config: { tools: {} },
    deps: { client: { call: async () => ({}) } },
    log: () => {},
  })
  assert.equal(tools.registered.has('qq_get_image'), false)
  assert.equal(state.names.includes('qq_get_image'), false, '注册失败的不该出现在白名单里')
})

test('白名单守卫：不在 allow 里的工具在**执行期**也被拒（restrict 管不到 scoped 注册）', () => {
  const tools = fakeTools({ available: ['fs_read'] })
  applyToolPolicy(tools, {
    chatKey: 'g:1',
    config: { tools: {} },
    deps: { client: { call: async () => ({}) } },
    log: () => {},
  })

  const guard = tools.calls.guard[0]
  assert.ok(guard, '必须挂守卫')
  // 高危：名字模式命中
  assert.match(guard({ name: 'bash' }), /高危/)
  // 不在白名单：哪怕它是别的插件 scoped 注册的、restrict 漏出来的，执行期也要拒
  assert.match(guard({ name: 'some_scoped_tool' }), /不在白名单/)
  // 白名单内的放行
  assert.equal(guard({ name: 'qq_get_image' }), undefined)
  assert.equal(guard({ name: 'fs_read' }), undefined)
  // 拿不到名字不误伤（传输层/嵌套调用）
  assert.equal(guard({}), undefined)
})

test('memory_add：写进 Memory，kind 校验、impression 必须带 target', async () => {
  const written = []
  const memory = {
    remember: (chatKey, item) => {
      written.push({ chatKey, ...item })
      return { id: 7 }
    },
  }
  const created = createQqTools({ chatKey: 'g:1', client: {}, memory, config: { tools: {} } })
  const def = created.defs.find(d => d.name === 'memory_add')
  assert.ok(def, 'memory_add 必须存在')

  const ok = await def.execute({ kind: 'topic', text: '在聊踢人工具' }, {})
  assert.equal(ok.ok, true)
  assert.equal(ok.id, 7)
  assert.equal(written[0].chatKey, 'g:1', '要写进跟注入同一个 chatKey')
  assert.equal(written[0].kind, 'topic')

  const imp = await def.execute({ kind: 'impression', text: '话不多但护短', target: '白绫' }, {})
  assert.equal(imp.ok, true)
  assert.equal(written[1].target, '白绫')

  await assert.rejects(() => def.execute({ kind: 'nope', text: 'x' }, {}), /kind/)
  await assert.rejects(() => def.execute({ kind: 'impression', text: '没说是谁' }, {}), /target/)
  await assert.rejects(() => def.execute({ kind: 'topic', text: '   ' }, {}), /text/)

  // 记忆没开：返回说明而不是抛错（模型据此知道"没记下来"）
  const noMem = createQqTools({ chatKey: 'g:1', client: {}, memory: null, config: { tools: {} } })
  const r = await noMem.defs.find(d => d.name === 'memory_add').execute({ kind: 'topic', text: 'x' }, {})
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /记忆未启用/)
})

test('踢人：只有管理员能授权，其他人要求时拒绝执行（群友也能打"把某某踢了"）', async () => {
  const calls = []
  const client = {
    call: async (action, params) => {
      calls.push({ action, params })
      return { ok: true }
    },
  }
  const make = (owners, sender) =>
    createQqTools({
      chatKey: 'g:1',
      client,
      config: { tools: {} },
      ownerIds: owners,
      senderId: () => sender,
    })
  const kick = t => t.defs.find(d => d.name === 'qq_kick')

  // 管理员：正常执行
  await kick(make(['100001'], '100001')).execute({ user_id: '999' }, {})
  assert.equal(calls[0].action, 'set_group_kick')
  assert.equal(String(calls[0].params.user_id), '999')

  // 群友：拒绝，且不能真的调 OneBot
  await assert.rejects(
    () => kick(make(['100001'], '20001')).execute({ user_id: '999' }, {}),
    /只有管理员/,
  )
  assert.equal(calls.length, 1, '被拒绝时不能发出去')

  // 没配管理员：谁都不能踢（宁可不踢，也不要"谁都能踢"）
  await assert.rejects(() => kick(make([], '20001')).execute({ user_id: '999' }, {}), /没有配置管理员/)
  assert.equal(calls.length, 1)
})

test('读图：deferContext 必须收到完整 UserMessage（缺 id/source 会让整回合报错）', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const client = { call: async () => ({ file: `base64://${Buffer.from(png).toString('base64')}` }) }
  const attachments = {
    saveImage: async () => ({
      attachmentId: 'sha256:abc',
      mediaType: 'image/png',
      width: 1,
      height: 1,
      bytes: png.length,
      name: '图',
    }),
  }
  const created = createQqTools({ chatKey: 'g:1', client, attachments, config: { tools: {} } })
  let got = null
  const out = await created.defs
    .find(d => d.name === 'qq_get_image')
    .execute({ file: 'a.png' }, { deferContext: m => { got = m } })

  assert.equal(out.ok, true)
  assert.ok(got, '必须注入上下文')
  // MessageBase：id / content / source 三个字段缺一个，DSH 就会在挂载时抛错
  assert.equal(typeof got.id, 'string')
  assert.ok(got.id.length > 0, 'id 不能为空')
  assert.equal(got.role, 'user')
  assert.equal(got.content[0].type, 'image')
  assert.equal(got.source?.kind, 'user', 'source.kind 缺失会让 DSH 抛 reading kind')
})

test('工具输出：schema 必须接受数组（群成员列表就是数组，写死 object 会 INVALID_TOOL_OUTPUT）', () => {
  const created = createQqTools({ chatKey: 'g:1', client: { call: async () => [] }, config: { tools: {} } })
  const def = created.defs.find(d => d.name === 'qq_member_list')
  assert.ok(def, 'qq_member_list 应存在')
  const schema = def.output.schema
  // 必须是 oneOf：DSH 的校验器不支持 anyOf，用了会让整个工具注册失败
  assert.ok(Array.isArray(schema.oneOf), '用 oneOf，不要 anyOf')
  assert.equal(schema.anyOf, undefined, 'anyOf 不被支持，会让工具注册失败')
  const types = schema.oneOf.map(x => x.type)
  assert.ok(types.includes('array'), '数组必须允许')
  assert.ok(types.includes('object'))
  assert.ok(types.includes('null'), 'kick 这类可能返回 null')
})

test('reply_to 不在本轮批里 → 降级为普通消息，内容不丢', async () => {
  const queued = []
  const created = createQqTools({
    chatKey: 'g:1',
    client: { call: async () => ({}) },
    enqueue: (k, text, meta) => queued.push({ k, text, meta }),
    config: { tools: {} },
    canReply: id => id === '100',
  })
  const send = created.defs.find(d => d.name === 'qq_send_message')

  await send.execute({ text: '回你', reply_to: '100' }, {})
  assert.equal(queued[0].meta.replyTo, '100', '合法的要带上引用')

  /**
   * 抄错一位是模型常犯的小错。拒绝等于丢掉整条消息，用户只看到"它没说话"；
   * 而不校验的话，OneBot 返回"找不到消息"→ 进死信重试三次 → 同样是什么都没有。
   * 所以降级：不认识就当作没传，消息照发。
   */
  await send.execute({ text: '回错', reply_to: '999' }, {})
  assert.equal(queued[1].meta.replyTo, undefined, '不合法的引用要去掉')
  assert.equal(queued[1].text, '回错', '但内容必须照发')
})
