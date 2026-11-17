import { SYNC_API_URL } from '../config'

const PASSWORD_KEY = 'ghf:syncPassword'

export function getSyncPassword() {
  return localStorage.getItem(PASSWORD_KEY) || ''
}

export function setSyncPassword(pw) {
  const v = (pw || '').trim()
  if (v) localStorage.setItem(PASSWORD_KEY, v)
  else localStorage.removeItem(PASSWORD_KEY)
}

export function emptyDoc() {
  return { items: [], deleted: [], catOrder: [], catOrderAt: '' }
}

// 兼容旧版纯数组与 v2 对象 { version, items, deleted, catOrder, catOrderAt }
export function parseFavoritesDoc(data) {
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null)
  if (!arr) throw new Error('云端数据格式不正确')
  const obj = data && !Array.isArray(data) ? data : {}
  return {
    items: arr.filter((i) => i && i.fullName && i.htmlUrl),
    deleted: Array.isArray(obj.deleted) ? obj.deleted.filter((d) => d && d.fullName && d.deletedAt) : [],
    catOrder: Array.isArray(obj.catOrder) ? obj.catOrder : [],
    catOrderAt: typeof obj.catOrderAt === 'string' ? obj.catOrderAt : '',
  }
}

function isJson(res) {
  return (res.headers.get('content-type') || '').includes('json')
}

const NOT_DEPLOYED = '云端同步接口尚未部署（/api/sync 返回的不是 JSON，请先部署带边缘函数的版本）'

// /api/sync 是同域相对路径，直接双击 html（file://）打开时无法请求
const LOCAL_FILE = !/^https?:$/.test(location.protocol)

// 读取云端收藏；云端还没有数据时返回空文档，服务不可用则抛错
export async function readRemote() {
  if (LOCAL_FILE) throw new Error('请通过网站地址访问后使用云端同步')
  let res
  try {
    res = await fetch(`${SYNC_API_URL}?t=${Date.now()}`, { cache: 'no-store' })
  } catch {
    throw new Error('网络请求失败，请检查网络后重试')
  }
  if (res.status === 404) return emptyDoc()
  if (!res.ok) {
    let msg = ''
    try { msg = (await res.json()).error } catch { /* ignore */ }
    throw new Error(`读取云端数据失败${msg ? '：' + msg : `（HTTP ${res.status}）`}`)
  }
  if (!isJson(res)) throw new Error(NOT_DEPLOYED)
  const data = await res.json()
  // 控制台没绑定 KV / 环境变量缺失时，接口会直接回一个 { error } 对象
  if (data && data.error && !Array.isArray(data.items)) {
    throw new Error('云端存储未就绪：' + data.error)
  }
  return parseFavoritesDoc(data)
}

// 整份写回云端；密码错误/未配置都会在这里暴露成中文提示
export async function saveRemote(doc) {
  const password = getSyncPassword()
  if (!password) throw new Error('请先填写并保存「同步密码」')
  if (LOCAL_FILE) throw new Error('请通过网站地址访问后使用云端同步')

  let res
  try {
    res = await fetch(SYNC_API_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-sync-password': password },
      body: JSON.stringify({ version: 2, ...doc }),
    })
  } catch {
    throw new Error('网络请求失败，请检查网络后重试')
  }
  if (!res.ok) {
    let msg = ''
    try { msg = (await res.json()).error } catch { /* ignore */ }
    if (res.status === 401) throw new Error('同步密码不正确，请在设置里重新填写')
    if (!isJson(res)) throw new Error(NOT_DEPLOYED)
    throw new Error(`保存到云端失败${msg ? '：' + msg : `（HTTP ${res.status}）`}`)
  }
  return res.json().catch(() => ({ ok: true }))
}
