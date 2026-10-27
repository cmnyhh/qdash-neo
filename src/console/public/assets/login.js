/**
 * 登录页脚本。
 *
 * 为什么必须用 fetch 而不是原生 `<form action>`：CSP 里有 `form-action 'none'`，
 * 原生提交会被浏览器直接拦掉（表现：点了没反应、控制台里只有一条 CSP 报错）。
 *
 * 口令只在这一个请求体里出现一次，之后靠 HttpOnly 会话 cookie，JS 读不到它。
 */

// 当前挂载前缀：/login → ''；/qdash-neo/login → '/qdash-neo'
const BASE = location.pathname.replace(/\/login$/, '')

const form = document.getElementById('login-form')
const userInput = document.getElementById('username')
const passwordInput = document.getElementById('password')
const errorBox = document.getElementById('login-error')
const submit = document.getElementById('login-submit')

/** @param {string} message */
function showError(message) {
  errorBox.textContent = message
  errorBox.hidden = !message
}

form.addEventListener('submit', async ev => {
  ev.preventDefault()
  if (submit.disabled) return
  showError('')

  const username = userInput.value.trim()
  const password = passwordInput.value
  if (!username || !password) {
    showError('用户名和口令都要填')
    return
  }

  submit.disabled = true
  submit.textContent = '登录中…'
  try {
    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      data = null
    }

    if (res.ok && data?.ok) {
      // replace 而不是 assign：登录页不该留在后退栈里
      location.replace(data.redirect || `${BASE}/`)
      return
    }

    if (res.status === 429) {
      showError(data?.error?.message ?? '尝试次数过多，请稍后再试')
    } else if (res.status === 401) {
      showError('用户名或口令不正确')
      passwordInput.value = ''
      passwordInput.focus()
    } else {
      showError(data?.error?.message ?? `登录失败（HTTP ${res.status}）`)
    }
  } catch (err) {
    showError(`连不上控制台：${err?.message ?? err}`)
  } finally {
    submit.disabled = false
    submit.textContent = '登录'
  }
})
