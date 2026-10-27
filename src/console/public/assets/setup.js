/**
 * 首次设置页的脚本。
 *
 * **必须是独立文件**：控制台 CSP 是 `script-src 'self'`，内联 `<script>` 会被直接拒绝。
 * 表现是"页面能打开、按钮点了没反应，控制台里也没有明显报错"——
 * 第一版就是写成内联的，于是只有默认样式的裸页面 + 一个死按钮。
 */
const form = document.getElementById('setup-form')
const passwordInput = document.getElementById('setup-password')
const confirmInput = document.getElementById('setup-confirm')
const submitButton = document.getElementById('setup-submit')
const errorBox = document.getElementById('setup-error')

function fail(message) {
  errorBox.textContent = message
  errorBox.hidden = false
}

form.addEventListener('submit', async ev => {
  // 必须拦下：CSP 的 `form-action 'none'` 会拒绝原生提交，而且我们本来就要走 JSON 接口
  ev.preventDefault()
  errorBox.hidden = true

  const password = passwordInput.value
  if (password.length < 8) {
    fail('口令至少 8 位')
    return
  }
  if (password !== confirmInput.value) {
    fail('两次输入不一致')
    return
  }

  submitButton.disabled = true
  submitButton.textContent = '保存中…'
  try {
    const res = await fetch('api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      location.replace(data.redirect || 'login')
      return
    }
    fail(data?.error?.message || `设置失败（HTTP ${res.status}）`)
  } catch {
    fail('连不上服务，检查一下宿主是否还在运行')
  } finally {
    submitButton.disabled = false
    submitButton.textContent = '保存并进入'
  }
})
