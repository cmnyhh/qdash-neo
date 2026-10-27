/**
 * 插件存储。
 *
 * **只给 KV，不给建表**。这是刻意的限制，不是偷懒：
 *
 * - 建表意味着插件要能执行 DDL，等于把整个库交给它（`drop table messages` 只差一个手滑）
 * - 建表还带出迁移问题：插件 v2 要加列，谁执行 `ALTER TABLE`？让插件执行还是内核代执行，
 *   两条路都要设计一套声明式 schema，复杂度远超收益
 * - KV 够用：待办、提醒、签到记录这类东西用 JSON 塞进 value 就行
 *
 * 命名空间用 `feature:<插件名>:` 前缀。卸载插件时按前缀清理即可，
 * 不需要跨表操作。
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 插件名规则：小写字母开头，只允许 a-z0-9_，最长 32。挡住空格、冒号、引号、SQL 片段 */
const NS_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** 子目录名：允许点号（`mp3` / `tmp.d` 这类），但不允许出现 `/` */
const SUB_RE = /^[A-Za-z0-9_.-]{1,64}$/

/** 键名规则：非空、不超过 128 字符、不含 `%`（`kvList` 走 LIKE，`%` 会破坏前缀匹配） */
const KEY_RE = /^[^%\u0000]{1,128}$/

export class PluginStorage {
  /**
   * @param {{ getStore?: () => object|null, store?: object|null, log?: Function }} deps
   *   `getStore` 优先 —— store 在 service.start() 里才创建，插件注册可能早于它。
   */
  constructor({ getStore = null, store = null, log = () => {} } = {}) {
    this.getStore = getStore ?? (() => store)
    this.log = log
  }

  get store() {
    try {
      return this.getStore()
    } catch {
      return null
    }
  }

  /**
   * 取一个命名空间的存储句柄。
   *
   * @param {string} name 插件自己的名字（会做格式校验）
   * @returns {{ get: Function, set: Function, del: Function, list: Function, clear: Function }}
   */
  forFeature(name) {
    const raw = String(name ?? '').trim()
    // 不转小写：`Todo` 和 `todo` 应该被当成两个名字而拒绝，而不是悄悄合并成一个
    const ns = raw
    if (!NS_RE.test(ns)) {
      throw new Error(
        `插件存储名「${raw}」不合法：只允许小写字母开头、a-z0-9_、最长 32（不要带空格或冒号）`,
      )
    }
    const prefix = `feature:${ns}:`

    const keyOf = key => {
      const k = String(key ?? '')
      if (!KEY_RE.test(k)) throw new Error('插件存储的键不能为空、不超过 128 字符、且不能包含 %')
      return `${prefix}${k}`
    }

    const store = () => {
      const s = this.store
      if (!s?.kvGet) throw new Error('存储未就绪（插件可能加载得过早）')
      return s
    }

    return {
      get(key, fallback = null) {
        const rawValue = store().kvGet(keyOf(key))
        if (rawValue == null) return fallback
        try {
          return JSON.parse(rawValue)
        } catch {
          // 存进去的一定是 JSON，解不出来说明被手工改过；返回原串比丢弃更有用
          return rawValue
        }
      },

      set(key, value) {
        store().kvSet(keyOf(key), JSON.stringify(value ?? null))
        return value ?? null
      },

      del(key) {
        store().kvDel(keyOf(key))
      },

      /**
       * 列出本命名空间的所有键。
       *
       * `kvList` 内部是 `LIKE '前缀%'`，而 `_` 在 LIKE 里是单字符通配符 ——
       * 插件名带下划线（`todo_list`）时会匹配到别人的键。
       * 所以这里先粗取 `feature:` 全部，再用**精确前缀**在 JS 里过滤一次。
       */
      list() {
        const rows = store().kvList?.('feature:') ?? []
        return rows
          .filter(r => String(r.key).startsWith(prefix))
          .map(r => {
            const k = String(r.key).slice(prefix.length)
            let v
            try {
              v = JSON.parse(r.value)
            } catch {
              v = r.value
            }
            return { key: k, value: v }
          })
      },

      /** 清空本命名空间（插件卸载/重置时用）。只删自己的前缀，不碰别人 */
      clear() {
        const s = store()
        const rows = s.kvList?.('feature:') ?? []
        let n = 0
        for (const r of rows) {
          if (!String(r.key).startsWith(prefix)) continue
          s.kvDel(String(r.key))
          n += 1
        }
        return n
      },

      /** 控制台/调试用 */
      get namespace() {
        return ns
      },
    }
  }

  /**
   * 给插件一个自己的目录。
   *
   * **这不是"授予文件权限"** —— 插件是进程内代码，`import 'node:fs'` 本来就能读写全盘。
   * 这里给的是**约定**：
   *   - 路径跟着 `DSH_HOME` 走，不会散落在 `process.cwd()`（用户的机器人目录）里
   *   - 卸载时知道该清哪儿，不会留一地文件
   *   - 备份 `DSH_HOME` 时会一起带上
   *
   * 不给配额：硬限额很容易误伤（一个语音就 3MB，配额设 1MB 直接废了），
   * 真要控就在控制台看占用、由人决定。
   *
   * @param {string} feature 插件自己的名字（同 KV 规则）
   * @param {string} [sub] 可选的子目录
   * @returns {string} 绝对路径（目录已创建）
   */
  dir(feature, sub = '') {
    const ns = String(feature ?? '').trim()
    if (!NS_RE.test(ns)) {
      throw new Error(`插件目录名「${ns}」不合法：只允许小写字母开头、a-z0-9_、最长 32`)
    }
    const s = String(sub ?? '').trim()
    // `..` 能跳出目录，`.` 只是无意义（等价于不传），两个都拒
    if (s && (!SUB_RE.test(s) || s.includes('..') || s === '.')) {
      throw new Error(`子目录名「${s}」不合法：不允许 / 和 ..`)
    }

    const base = join(this.homeDir(), 'qdash-plugins', ns)
    const target = s ? join(base, s) : base
    // 正则已经挡了，这里再确认一次没跳出去（多一道不吃亏）
    if (target !== base && !target.startsWith(base)) {
      throw new Error('子目录不能跳出插件目录')
    }

    try {
      mkdirSync(target, { recursive: true })
    } catch (err) {
      this.log('warn', `qdash-neo: 创建插件目录失败 ${target} name=${err?.name} msg=${err?.message}`)
    }
    return target
  }

  /**
   * `DSH_HOME` 或 `~/.dsh`。
   *
   * 和语音库用同一条规则：换家之后数据跟着走，不会出现"语音库在新家、插件目录在旧家"。
   */
  homeDir() {
    const home = String(process.env.DSH_HOME ?? '').trim()
    return home || join(homedir(), '.dsh')
  }
}
