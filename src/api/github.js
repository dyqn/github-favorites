const API = 'https://api.github.com'

// 匿名配额（每小时 60 次）从响应头里读，不额外花请求
const quota = { remaining: null, limit: null, resetAt: null }

function noteQuota(res) {
  const remaining = res.headers.get('x-ratelimit-remaining')
  const limit = res.headers.get('x-ratelimit-limit')
  const reset = res.headers.get('x-ratelimit-reset')
  if (remaining !== null) quota.remaining = Number(remaining)
  if (limit !== null) quota.limit = Number(limit)
  if (reset !== null) quota.resetAt = Number(reset) * 1000
}

// /rate_limit 本身不占核心配额，用来在批量刷新前先探一下还剩几次
export async function probeQuota() {
  try {
    const res = await fetch(`${API}/rate_limit`, { headers: { Accept: 'application/vnd.github+json' } })
    const j = await res.json()
    const core = j.resources && j.resources.core
    if (core) {
      quota.remaining = core.remaining
      quota.limit = core.limit
      quota.resetAt = core.reset * 1000
    }
  } catch { /* 探不到就按「未知」处理，交给正常请求去撞 */ }
  return { ...quota }
}

export function quotaResetText() {
  if (!quota.resetAt) return ''
  return `约 ${new Date(quota.resetAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 恢复`
}

function resetHint() {
  const text = quotaResetText()
  return text ? `，${text}` : ''
}

// Accept "owner/repo", "github.com/owner/repo", or a full URL with extras
export function parseRepoInput(input) {
  let s = (input || '').trim().replace(/\.git$/, '')
  if (!s) return null
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '')
  s = s.replace(/^git@github\.com:/i, '')
  s = s.split(/[?#]/)[0].replace(/\/+$/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const [owner, name] = parts
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null
  return `${owner}/${name}`
}

export async function fetchRepo(fullName) {
  let res
  try {
    res = await fetch(`${API}/repos/${fullName}`, { headers: { Accept: 'application/vnd.github+json' } })
  } catch {
    throw new Error('网络请求失败，请检查网络后重试')
  }
  noteQuota(res)
  if (res.status === 404) throw new Error(`未找到项目 ${fullName}，请检查地址是否正确`)
  if (res.status === 403 || res.status === 429) {
    throw new Error(`GitHub API 访问次数已用完（匿名每小时 60 次），请稍后再试${resetHint()}`)
  }
  if (!res.ok) throw new Error(`获取项目信息失败（HTTP ${res.status}）`)
  const j = await res.json()
  return {
    fullName: j.full_name,
    owner: j.owner.login,
    name: j.name,
    avatar: j.owner.avatar_url,
    description: j.description,
    stargazers: j.stargazers_count,
    forks: j.forks_count,
    language: j.language,
    topics: (j.topics || []).slice(0, 6),
    homepage: j.homepage || null,
    pushedAt: j.pushed_at,
    htmlUrl: j.html_url,
    refreshedAt: new Date().toISOString(),
  }
}
