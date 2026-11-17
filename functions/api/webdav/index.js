/**
 * EdgeOne Pages 边缘函数：/api/webdav（把收藏备份到用户自己的云盘，坚果云 / InfiniCloud 等）
 *
 * 浏览器不能直接请求坚果云 / InfiniCloud 的 WebDAV：对方不发 CORS 头，
 * PROPFIND/PUT 也过不了预检，所以由本函数在同域名下转发一次。
 *
 * 只接受 POST，请求体：{ operation: 'check' | 'read' | 'write', config: { url, username, password }, payload? }
 *   check  PROPFIND Depth:0 测连接
 *   read   取目录里日期最新的一份 github-favorites_YYYYMMDD.json（没有则回退旧版固定文件名）
 *   write  MKCOL 建目录（忽略已存在）+ PUT 今天的备份，再把超过 5 份的旧备份删掉
 *
 * 备份文件名带北京时间日期，同一天多次备份覆盖当天那份；删除只针对本函数自己的命名规则，
 * 不接受调用方传入的任何文件名。
 *
 * 云盘账号密码只在这次请求里出现，不写进代码、也不落在服务器上；
 * 因为没有登录态，本函数唯一的自我保护是对目标地址做严格限制（见 assertSafeUrl）。
 */

const LEGACY_FILE = 'github-favorites.json'
const DATED_FILE = /^github-favorites_(\d{8})\.json$/
const MAX_BACKUPS = 5
const MAX_BYTES = 900 * 1024
const UA = 'GitHubFavorites/1.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', ...CORS },
  })
}

// 只允许公网 https 的 WebDAV 服务，挡掉内网/元数据地址，避免本函数被当成任意地址的跳板
function assertSafeUrl(raw) {
  let u
  try {
    u = new URL(String(raw || '').trim())
  } catch {
    throw new Error('服务器地址格式不正确，请填写完整链接，例如 https://dav.jianguoyun.com/dav/')
  }
  if (u.protocol !== 'https:') throw new Error('只允许 https 地址')
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) throw new Error('服务器地址缺少域名')
  if (/^(localhost|.*\.localhost|.*\.(internal|local|home|lan|intranet))$/.test(host)) throw new Error('禁止访问内网地址')

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host) ? host.split('.').map(Number) : null
  if (v4) {
    const [a, b] = v4
    const bad =
      v4.some((n) => Number.isNaN(n) || n > 255) ||
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    if (bad) throw new Error('禁止访问内网或保留地址')
  }
  if (host.includes(':')) {
    if (/^::?$/.test(host) || /^(::1|fe80|fc|fd)/.test(host)) throw new Error('禁止访问本机或内网地址')
  }
  if (!/^[a-z0-9.\-:_\[\]]+$/.test(host)) throw new Error('服务器地址含有非法字符')
  return u
}

// 坚果云根目录 /dav/ 不允许直接写文件（404 ObjectNotFound），自动落到子目录
function resolveStorageDir(u) {
  let base = u.origin + u.pathname
  if (!base.endsWith('/')) base += '/'
  if (/jianguoyun\.com$/i.test(u.hostname) && (u.pathname === '/dav/' || u.pathname === '/dav')) {
    return base + 'github-favorites/'
  }
  return base
}

function connectionHint(u) {
  const host = u.hostname.toLowerCase()
  if (/jianguoyun\.com/.test(host)) {
    return '坚果云要用「安全选项」里生成的应用密码（不是登录密码），地址一般填 https://dav.jianguoyun.com/dav/'
  }
  if (/infini-cloud\.net|teracloud\.jp/.test(host)) {
    return 'InfiniCloud 服务器在日本，需要先在网页端开启「外部应用连接」并使用应用密码；大陆网络偶发不通，可重试一次'
  }
  return ''
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e)))
    const err = new Error(aborted ? `连接超时（${Math.round(timeoutMs / 1000)} 秒未响应）` : `无法连接到 WebDAV 服务器：${String((e && e.message) || e)}`)
    err.isTimeout = aborted
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function authHeaders(auth) {
  return { Authorization: auth, 'User-Agent': UA }
}

// 北京时间日期串 YYYYMMDD，用于备份文件名
function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

// 列目录（PROPFIND Depth:1）取文件名；失败返回 null，调用方按"列不到"处理
async function listFiles(base, auth) {
  const res = await fetchWithTimeout(base, {
    method: 'PROPFIND',
    headers: { ...authHeaders(auth), Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0" encoding="UTF-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
  }, 15000)
  if (!(res.ok || res.status === 207)) return null
  const xml = await res.text()
  const hrefs = [...xml.matchAll(/<(?:[A-Za-z][\w-]*:)?href>([^<]+)<\/(?:[A-Za-z][\w-]*:)?href>/gi)].map((m) => m[1])
  const names = hrefs.map((h) => {
    let p = h
    try { p = decodeURIComponent(p) } catch { /* 保留原样 */ }
    return p.split('/').filter(Boolean).pop() || ''
  })
  return [...new Set(names)]
}

// 按日期从新到旧排序，旧版固定文件名当最旧
function sortedBackups(names) {
  const dated = names
    .filter((n) => DATED_FILE.test(n))
    .map((n) => ({ name: n, date: (n.match(DATED_FILE) || [])[1] }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((x) => x.name)
  return names.includes(LEGACY_FILE) ? [...dated, LEGACY_FILE] : dated
}

// 只删本函数自己命名出来的文件，且只在该目录内
async function rotate(base, auth) {
  try {
    const names = await listFiles(base, auth)
    if (!names) return
    const all = sortedBackups(names)
    const stale = all.slice(MAX_BACKUPS)
    if (!stale.length) return
    await Promise.all(stale.map((name) =>
      fetchWithTimeout(base + name, { method: 'DELETE', headers: authHeaders(auth) }, 15000).catch(() => {})
    ))
  } catch { /* 轮转失败不影响备份本身 */ }
}

async function handleCheck(base, auth, hint) {
  let res
  try {
    res = await fetchWithTimeout(base, { method: 'PROPFIND', headers: { ...authHeaders(auth), Depth: '0', 'Content-Type': 'application/xml' }, body: '<?xml version="1.0" encoding="UTF-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>' }, 20000)
  } catch (e) {
    return json({ success: false, error: e.message, detail: hint ? `建议：${hint}` : '' }, e.isTimeout ? 504 : 502)
  }
  if (res.status === 401 || res.status === 403) {
    return json({ success: false, error: '用户名或应用密码不正确（401/403）', detail: `建议：${hint}` }, 401)
  }
  if (!(res.ok || res.status === 207)) {
    const text = await res.text().catch(() => '')
    return json({ success: false, error: `WebDAV 返回 ${res.status}`, detail: (hint ? `建议：${hint}` : text.slice(0, 300)) }, 502)
  }
  return json({ success: true, status: res.status })
}

async function handleRead(base, auth, hint) {
  // 先列目录找日期最新的一份；列不到就回退旧版固定文件名
  let target = LEGACY_FILE
  try {
    const names = await listFiles(base, auth)
    if (names) {
      const all = sortedBackups(names)
      if (!all.length) return json({ success: true, empty: true })
      target = all[0]
    }
  } catch { /* 回退旧文件名 */ }

  let res
  try {
    res = await fetchWithTimeout(base + target, { method: 'GET', headers: authHeaders(auth) }, 25000)
  } catch (e) {
    return json({ success: false, error: e.message, detail: hint ? `建议：${hint}` : '' }, e.isTimeout ? 504 : 502)
  }
  if (res.status === 404 || res.status === 409) return json({ success: true, empty: true })
  if (res.status === 401 || res.status === 403) {
    return json({ success: false, error: '用户名或应用密码不正确（401/403）', detail: `建议：${hint}` }, 401)
  }
  if (!res.ok) return json({ success: false, error: `读取云端收藏失败（HTTP ${res.status}）` }, 502)
  const text = await res.text()
  if (!text.trim()) return json({ success: true, empty: true })
  try {
    return json({ success: true, data: JSON.parse(text), file: target })
  } catch {
    return json({ success: false, error: '云盘里的备份文件不是合法 JSON，请先手动检查该文件' }, 502)
  }
}

async function handleWrite(base, auth, payload, hint) {
  let doc
  try {
    doc = typeof payload === 'string' ? JSON.parse(payload) : payload
  } catch {
    return json({ success: false, error: '待写入的数据不是合法 JSON' }, 400)
  }
  if (!doc || !Array.isArray(doc.items) || !doc.items.every((i) => i && i.fullName && i.htmlUrl)) {
    return json({ success: false, error: '数据格式不正确：items 必须是含 fullName/htmlUrl 的数组' }, 400)
  }
  if (new TextEncoder().encode(JSON.stringify(doc)).length > MAX_BYTES) {
    return json({ success: false, error: `数据超过 ${Math.floor(MAX_BYTES / 1024)}KB，请先删掉部分收藏或定期导出备份` }, 413)
  }

  // 目录不存在时先建一次；已存在会返回 405，忽略即可
  try {
    await fetchWithTimeout(base, { method: 'MKCOL', headers: authHeaders(auth) }, 15000)
  } catch { /* 建目录失败不影响下面 PUT 的报错判断 */ }

  const filename = `github-favorites_${todayStr()}.json`
  let res
  try {
    res = await fetchWithTimeout(base + filename, {
      method: 'PUT',
      headers: { ...authHeaders(auth), 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ ...doc, version: 2, updatedAt: new Date().toISOString() }),
    }, 30000)
  } catch (e) {
    return json({ success: false, error: e.message, detail: hint ? `建议：${hint}` : '' }, e.isTimeout ? 504 : 502)
  }
  if (res.status === 401 || res.status === 403) {
    return json({ success: false, error: '用户名或应用密码不正确，无法写入（401/403）', detail: `建议：${hint}` }, 401)
  }
  if (!(res.ok || res.status === 207)) {
    return json({ success: false, error: `写入失败：WebDAV 返回 ${res.status}`, detail: `建议：${hint}` }, 502)
  }
  // 备份成功后才轮转，失败也不影响这次备份
  await rotate(base, auth)
  return json({ success: true, file: filename, path: base + filename, count: doc.items.length })
}

/** @param {import('@edgeone/types').CloudFunctionContext} context */
export async function onRequest(context) {
  const request = context.request
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (request.method !== 'POST') return json({ error: '只支持 POST' }, 405)

  let body
  try {
    body = await request.json()
  } catch {
    return json({ success: false, error: '请求体不是合法 JSON' }, 400)
  }

  const { operation, config, payload } = body || {}
  if (!config || !config.url || !config.username || !config.password) {
    return json({ success: false, error: '配置不完整：请填写服务器地址、用户名和应用密码' }, 400)
  }
  if (!['check', 'read', 'write'].includes(operation)) {
    return json({ success: false, error: '不支持的操作 ' + operation }, 400)
  }

  let u
  try {
    u = assertSafeUrl(config.url)
  } catch (e) {
    return json({ success: false, error: e.message }, 403)
  }

  const auth = 'Basic ' + btoa(`${config.username}:${config.password}`)
  const hint = connectionHint(u)

  // check 探测的是用户填的根目录（能连通即可）；读写落在解析出的存放目录
  const base = resolveStorageDir(u)

  if (operation === 'check') return handleCheck(u.href, auth, hint)
  if (operation === 'read') return handleRead(base, auth, hint)
  return handleWrite(base, auth, payload, hint)
}
