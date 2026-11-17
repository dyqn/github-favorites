/**
 * EdgeOne Pages 边缘函数：/api/sync（云端收藏读写，数据存 KV）
 *
 *   GET  /api/sync   读取收藏文档（原样返回 JSON；访客默认列表也读这里）
 *   PUT  /api/sync   写入收藏文档，请求头 x-sync-password 必须等于环境变量 SYNC_PASSWORD
 *
 * 控制台需要配置两项：
 *   1. 开通/绑定 KV 命名空间，绑定变量名用 favorites_kv；
 *      若绑定成了别的名字，再加一个环境变量 KV_BINDING = 你的变量名。
 *   2. 环境变量 SYNC_PASSWORD = 你自己定的同步密码（写入数据的唯一凭证）。
 */

const DEFAULT_KV_BINDING = 'favorites_kv'
const DATA_KEY = 'github-favorites.json'
const MAX_BYTES = 900 * 1024

function readEnv(env, name) {
  if (env && env[name]) return env[name]
  const g = typeof globalThis !== 'undefined' ? globalThis : {}
  if (g[name]) return g[name]
  // 本地 dev（edgeone pages dev）常把环境变量放在 process.env 上
  try {
    if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name]
  } catch { /* 边缘运行时没有 process */ }
  return ''
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-sync-password',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      ...CORS,
    },
  })
}

function getKv(env) {
  const name = readEnv(env, 'KV_BINDING') || DEFAULT_KV_BINDING
  let bound = (env && env[name]) || null
  if (!bound) {
    try { bound = globalThis[name] || null } catch { /* ignore */ }
  }
  if (!bound || typeof bound.get !== 'function' || typeof bound.put !== 'function') {
    throw new Error(`KV 命名空间未绑定到变量 ${name}：请在 EdgeOne Pages 控制台开通 KV 并绑定（或设置环境变量 KV_BINDING）`)
  }
  return bound
}

function isValidItem(i) {
  return i && typeof i.fullName === 'string' && typeof i.htmlUrl === 'string'
}

async function handleGet(env) {
  let raw
  try {
    raw = getKv(env).get(DATA_KEY)
    if (raw && typeof raw.then === 'function') raw = await raw
  } catch (e) {
    return json({ error: 'KV 读取失败：' + (e && e.message ? e.message : e) }, 502)
  }
  if (raw == null || raw === '') return json({ error: 'no-data' }, 404)
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return new Response(text, {
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      ...CORS,
    },
  })
}

async function handlePut(request, env) {
  const expected = readEnv(env, 'SYNC_PASSWORD')
  if (!expected) return json({ error: '服务端未配置环境变量 SYNC_PASSWORD' }, 500)

  const given = request.headers.get('x-sync-password') || ''
  if (given !== expected) return json({ error: '同步密码不正确' }, 401)

  let text = ''
  try {
    text = await request.text()
  } catch {
    return json({ error: '读取请求体失败' }, 400)
  }
  if (!text) return json({ error: '请求体为空' }, 400)
  if (new TextEncoder().encode(text).length > MAX_BYTES) {
    return json({ error: `数据超过 ${Math.floor(MAX_BYTES / 1024)}KB 上限` }, 413)
  }

  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return json({ error: '数据不是合法 JSON' }, 400)
  }
  if (!doc || !Array.isArray(doc.items) || !doc.items.every(isValidItem)) {
    return json({ error: '数据格式不正确：items 必须是含 fullName/htmlUrl 的数组' }, 400)
  }
  if (doc.deleted && !Array.isArray(doc.deleted)) return json({ error: 'deleted 必须是数组' }, 400)
  if (doc.catOrder && !Array.isArray(doc.catOrder)) return json({ error: 'catOrder 必须是数组' }, 400)

  const updatedAt = new Date().toISOString()
  const stored = JSON.stringify({ ...doc, version: 2, updatedAt })
  try {
    await getKv(env).put(DATA_KEY, stored)
  } catch (e) {
    return json({ error: 'KV 写入失败：' + (e && e.message ? e.message : e) }, 502)
  }
  return json({
    ok: true,
    count: doc.items.length,
    bytes: new TextEncoder().encode(stored).length,
    updatedAt,
  })
}

/** @param {import('@edgeone/types').CloudFunctionContext} context */
export async function onRequest(context) {
  const request = context.request
  const env = context.env
  const method = (request.method || 'GET').toUpperCase()

  try {
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }
    if (method === 'GET' || method === 'HEAD') return await handleGet(env)
    if (method === 'PUT' || method === 'POST') return await handlePut(request, env)
    return json({ error: '不支持的请求方法 ' + method }, 405)
  } catch (e) {
    return json({ error: (e && e.message) || String(e) }, 500)
  }
}
