/**
 * qdn-probe Client 半 — 验证「profile 插件的浏览器半能否上屏」
 *
 * 目标（M0 判据）：
 *   A. 侧栏长出一个图标，点开渲染出自己的面板  → 需要 sidebar.panellist + main 两个槽
 *   B. label 走 ctx.locale                        → 语言这条路
 *   C. inject 写错包名 → 记录报错原文              → M3 闸门要匹配的形态
 *
 * 形态照抄官方 lib/client.js：window.__ModuleLoader__.load({ id, factory })
 * 不引入任何构建器。
 */
window.__ModuleLoader__.load({
  id: 'qdn-probe',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const TAG = '[qdn-probe-client]'
    console.log(TAG, 'factory evaluated')

    const PANEL_ID = 'qdn-probe'

    function ProbeIcon() {
      return h(
        'span',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            font: '600 12px/1 system-ui, sans-serif',
            color: 'currentColor',
          },
        },
        'P',
      )
    }

    function ProbePanel() {
      const [slots, setSlots] = React.useState('?')
      React.useEffect(() => {
        console.log(TAG, 'panel mounted')
        setSlots('mounted')
      }, [])
      return h(
        'div',
        { style: { padding: 24, font: '13px/1.7 system-ui, sans-serif' } },
        h('h2', { style: { margin: '0 0 8px', fontSize: 16 } }, 'qdn-probe 上屏成功'),
        h('div', null, 'sidebar.panellist + main 两个槽都注册成功了。'),
        h('div', null, '状态：' + slots),
      )
    }

    function apply(ctx) {
      console.log(TAG, 'apply')
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, ProbePanel),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 900, label: () => '探针' },
          ProbeIcon,
        ),
      )
    }

    return { name: 'qdn-probe-client', apply, inject: ['slots'] }
  },
})
