import { SYNC_API_URL } from '../config'
import { parseFavoritesDoc } from './syncStore'

const LOCAL_FALLBACK_URL = '/defaults.json'
const FETCH_TIMEOUT = 8000

async function fetchList(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
  try {
    // no-store + 时间戳：绕过浏览器/CDN 缓存，打开页面即取最新内容
    const bust = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now()
    const res = await fetch(bust, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return null
    const data = JSON.parse(await res.text())
    // 兼容旧版纯数组与新版 { version, items, deleted, catOrder } 格式
    const doc = parseFavoritesDoc(data)
    return { items: doc.items, catOrder: doc.catOrder }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// 三级降级：本站接口 /api/sync（KV，最新）→ defaults.json（纯静态快照）→ null（页面用内置示例）
// 只有部署在支持边缘函数的宿主（EdgeOne Pages）上第一级才有数据；
// 部署到 Vercel / Cloudflare Pages 时第一级取不到，会自动降级到 defaults.json，站点照常显示。
export async function fetchDefaultFavorites() {
  // 两级地址都是同域相对路径：直接双击 html（file://）打开时没有同源接口，只能退到内置示例数据
  if (!/^https?:$/.test(location.protocol)) return null
  const fromApi = await fetchList(SYNC_API_URL)
  if (fromApi && fromApi.items.length) return fromApi
  return fetchList(LOCAL_FALLBACK_URL)
}
