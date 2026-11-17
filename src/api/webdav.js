// WebDAV 云盘备份（坚果云 / InfiniCloud 等）
// 这是「备份到云盘」而不是「云盘同步」：收藏的日常同步走本站云端（/api/sync），
// 云盘里存的是按日期命名的存档，最多留最近 5 份。
// 凭据只存在本机 localStorage，请求时交给同域的 /api/webdav 代理转发一次；
// 服务器上不落地、代码里也不写死。

const CONFIG_KEY = 'ghf:webdav'
const PREF_KEY = 'ghf:webdavBackup'
const LAST_KEY = 'ghf:webdavLastBackupAt'

export function getWebDavConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return { url: '', username: '', password: '' }
    const c = JSON.parse(raw) || {}
    return { url: c.url || '', username: c.username || '', password: c.password || '' }
  } catch {
    return { url: '', username: '', password: '' }
  }
}

export function setWebDavConfig(config) {
  const c = {
    url: (config.url || '').trim(),
    username: (config.username || '').trim(),
    password: config.password || '',
  }
  if (c.url || c.username || c.password) localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
  else localStorage.removeItem(CONFIG_KEY)
}

export function isWebDavConfigured(config = getWebDavConfig()) {
  return !!(config.url && config.username && config.password)
}

// 每天自动备份的开关（手动「立即备份」不需要它）
export function getAutoBackup() {
  try {
    return !!(JSON.parse(localStorage.getItem(PREF_KEY) || '{}').autoBackup)
  } catch {
    return false
  }
}

export function setAutoBackup(on) {
  const pref = { autoBackup: !!on }
  localStorage.setItem(PREF_KEY, JSON.stringify(pref))
}

// 上次成功备份的时间（ISO 串），用来判断"今天是否已经自动备份过"
export function getLastBackupAt() {
  return localStorage.getItem(LAST_KEY) || ''
}

export function setLastBackupAt(iso) {
  if (iso) localStorage.setItem(LAST_KEY, iso)
  else localStorage.removeItem(LAST_KEY)
}

const callProxy = async (operation, config, payload) => {
  let res
  try {
    res = await fetch('/api/webdav', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, config, payload }),
    })
  } catch {
    throw new Error('代理请求失败，请检查网络后重试')
  }
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('云盘备份接口尚未部署（/api/webdav 没有返回 JSON）')
  }
  return data
}

// 代理把失败原因放在 error + detail（detail 里是针对坚果云/InfiniCloud 的建议），一并显示出来
const proxyError = (r, fallback) => {
  const msg = r.error || fallback
  return new Error(r.detail ? `${msg}　${r.detail}` : msg)
}

export async function testWebDavConnection(config) {
  const r = await callProxy('check', config)
  if (r.success) return { success: true }
  return { success: false, error: r.error || '连接失败', detail: r.detail || '' }
}

// 返回云盘里最新一份备份 { data, file }；一份都没有时返回 null
export async function readLatestBackup(config) {
  const r = await callProxy('read', config)
  if (r.empty) return null
  if (!r.success) throw proxyError(r, '读取云盘备份失败')
  return { data: r.data, file: r.file || '' }
}

// 写一份今天的备份（文件名带日期，超出 5 份由接口删最旧的）
export async function writeBackup(config, doc) {
  const r = await callProxy('write', config, doc)
  if (!r.success) throw proxyError(r, '备份到云盘失败')
  return r
}
