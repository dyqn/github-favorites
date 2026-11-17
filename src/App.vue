<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchRepo, parseRepoInput, probeQuota, quotaResetText } from './api/github'
import { favorites } from './store/favorites'
import { formatNumber } from './utils/format'
import RepoCard from './components/RepoCard.vue'
import SettingsModal from './components/SettingsModal.vue'
import CategoryManager from './components/CategoryManager.vue'
import { initSync, onSyncToast, sync } from './store/sync'
import { initBackup } from './store/backup'
import { fetchDefaultFavorites } from './api/defaults'
import { sortCategories, applyCatOrderDisplay } from './store/catOrder'

const input = ref('')
const adding = ref(false)
const query = ref('')
const lang = ref('')
const cat = ref('')
const sort = ref('added')
const showSettings = ref(false)
const showCatManager = ref(false)
const dark = ref(false)

const toastMsg = ref('')
const toastErr = ref(false)
let toastTimer = null
function toast(msg, isErr = false) {
  toastMsg.value = msg
  toastErr.value = isErr
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastMsg.value = ''), 3200)
}

const items = favorites.items

const languages = computed(() => {
  const set = new Set(items.value.map((i) => i.language).filter(Boolean))
  return [...set].sort()
})

function goHome() {
  query.value = ''
  lang.value = ''
  cat.value = ''
  sort.value = 'added'
  input.value = ''
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

const categories = computed(() => {
  const set = new Set(items.value.map((i) => i.category).filter(Boolean))
  return sortCategories([...set])
})

const filtered = computed(() => {
  let list = items.value
  const kw = query.value.trim().toLowerCase()
  if (kw) {
    list = list.filter((i) =>
      [i.fullName, i.description, ...(i.topics || [])]
        .filter(Boolean)
        .some((s) => s.toLowerCase().includes(kw))
    )
  }
  if (lang.value) list = list.filter((i) => i.language === lang.value)
  if (cat.value === '__none__') list = list.filter((i) => !i.category)
  else if (cat.value) list = list.filter((i) => i.category === cat.value)
  const sorted = [...list]
  if (sort.value === 'stars') sorted.sort((a, b) => b.stargazers - a.stargazers)
  else if (sort.value === 'forks') sorted.sort((a, b) => b.forks - a.forks)
  else if (sort.value === 'name') sorted.sort((a, b) => a.fullName.localeCompare(b.fullName))
  else sorted.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''))
  return sorted
})

// ---------- 虚拟滚动：只渲染视口内的行（含上下缓冲），万级列表也不卡 ----------
const OVERSCAN = 4 // 上下各多渲染几行，防止快速滚动露白
const gridWrap = ref(null)
const winTop = ref(0) // 已滚动进入列表区的距离
const viewportH = ref(typeof window !== 'undefined' ? window.innerHeight : 800)
const cols = ref(1)
const gap = ref(24)
const rowH = ref(265) // 卡片实测高度兜底值，mount 后会被真实测量覆盖
const anchorRow = ref(null) // flashCard 定位时强制把该行渲染进窗口

const stride = computed(() => rowH.value + gap.value)
const totalRows = computed(() => Math.ceil(filtered.value.length / cols.value))
const totalH = computed(() =>
  totalRows.value ? totalRows.value * rowH.value + (totalRows.value - 1) * gap.value : 0
)
const winRowCount = computed(() => Math.ceil(viewportH.value / stride.value) + OVERSCAN * 2)
const startRow = computed(() => {
  const maxStart = Math.max(0, totalRows.value - winRowCount.value)
  if (anchorRow.value != null) {
    return Math.min(Math.max(0, anchorRow.value - Math.floor(winRowCount.value / 2)), maxStart)
  }
  return Math.min(Math.max(0, Math.floor(winTop.value / stride.value) - OVERSCAN), maxStart)
})
const windowItems = computed(() =>
  filtered.value.slice(startRow.value * cols.value, Math.min(totalRows.value, startRow.value + winRowCount.value) * cols.value)
)
const gridStyle = computed(() => ({
  // 用 top 而非 transform 定位：transform 祖先会导致下拉弹层等控件定位异常
  top: `${startRow.value * stride.value}px`,
  gridTemplateColumns: `repeat(${cols.value}, minmax(0, 1fr))`,
  gap: `${gap.value}px`,
}))

function measure() {
  viewportH.value = window.innerHeight
  const wrap = gridWrap.value
  if (!wrap) return
  if (window.matchMedia('(max-width: 640px)').matches) {
    cols.value = 1
    gap.value = 16
  } else {
    gap.value = 24
    cols.value = Math.max(1, Math.floor((wrap.clientWidth + gap.value) / (300 + gap.value)))
  }
  const card = wrap.querySelector('.card')
  if (card) rowH.value = card.offsetHeight
  winTop.value = Math.max(0, -wrap.getBoundingClientRect().top)
}

// 筛选/排序变化后列表高度会变，重新测量布局
watch([query, lang, cat, sort], async () => {
  anchorRow.value = null
  await nextTick()
  measure()
})

// 数据异步到位（默认收藏/同步拉取）后网格才出现，需要补一次测量
watch(filtered, async () => {
  await nextTick()
  measure()
})

let scrollTimer = null
const showTop = ref(false)
function onScroll() {
  if (scrollTimer) return
  // 用 setTimeout 而非 rAF：后台标签页 rAF 不执行
  scrollTimer = setTimeout(() => {
    scrollTimer = null
    showTop.value = window.scrollY > 400
    const wrap = gridWrap.value
    if (!wrap) return
    viewportH.value = window.innerHeight
    winTop.value = Math.max(0, -wrap.getBoundingClientRect().top)
  }, 50)
}
function goTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// 快照超过这么多天才算"过期"、才值得再花一次 GitHub 请求
const STALE_DAYS = 30
const STALE_MS = STALE_DAYS * 24 * 3600 * 1000
// 点一次「刷新数据」最多刷这么多条，连点分批轮完，不会一次把 60 次/小时打光
const REFRESH_BATCH = 10
const refreshingAll = ref(null)

// 未开启云端同步＝整站只读：所有会改动收藏的操作统一在这里拦下（按钮仍可见，只给提示）
function requireSync(what) {
  if (sync.enabled) return true
  toast(`未开启云端同步，无法${what}。请先在「设置与数据 → 云端同步」里开启`, true)
  return false
}

async function refreshRepos(list, label) {
  if (!list.length) return
  if (!navigator.onLine) return
  let done = 0
  let ok = 0
  const renamed = []
  refreshingAll.value = { done, total: list.length }
  const queue = [...list]
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift()
      try {
        const repo = await fetchRepo(item.fullName)
        // 作者改名/转移仓库时 GitHub 会返回新名字，数据其实是同一份；
        // 不给旧名字这条盖章的话，它每次打开都被判定过期、反复提示刷新
        if (repo.fullName.toLowerCase() !== item.fullName.toLowerCase()) {
          const old = items.value.find((i) => i.fullName.toLowerCase() === item.fullName.toLowerCase())
          if (old) old.refreshedAt = repo.refreshedAt
          renamed.push(`${item.fullName} → ${repo.fullName}`)
        }
        favorites.update(item.fullName, repo)
        ok++
      } catch { /* keep the old snapshot on failure */ }
      refreshingAll.value = { done: ++done, total: list.length }
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker))
  refreshingAll.value = null
  if (renamed.length) {
    toast(`检测到项目改名/转移：${renamed.join('；')}。列表里会是两张重复卡片，删掉旧名字那张即可`, true)
  } else if (ok) {
    toast(`${label}：已更新 ${ok}/${list.length} 个项目数据`)
  }
}

function staleList() {
  const now = Date.now()
  return items.value.filter(
    (i) => !i.refreshedAt || now - new Date(i.refreshedAt).getTime() > STALE_MS
  )
}

// 数据最旧的排前面，避免排在列表后面的条目永远轮不到更新
function byOldest(a, b) {
  return (a.refreshedAt ? new Date(a.refreshedAt).getTime() : 0) - (b.refreshedAt ? new Date(b.refreshedAt).getTime() : 0)
}

async function loadDefaults() {
  if (favorites.isUserOwned() || sync.enabled) return
  const res = await fetchDefaultFavorites()
  if (res && res.items.length && !favorites.isUserOwned() && !sync.enabled) {
    favorites.useDefault(res.items)
    // 访客也按维护者的云端顺序显示分类（仅内存，不写 localStorage）
    applyCatOrderDisplay(res.catOrder)
  }
}

// 刷新数据：过期的先刷、最旧的先刷，每次最多 REFRESH_BATCH 条，连点就把过期项一批批刷完
async function refreshDataNow() {
  if (!requireSync('刷新项目数据')) return
  if (!items.value.length) return
  const q = await probeQuota()
  if (q.remaining !== null && q.remaining <= 0) {
    toast(`GitHub 请求次数已达本小时上限，${quotaResetText() || '请稍后再试'}`, true)
    return
  }
  const budget = q.remaining === null ? REFRESH_BATCH : Math.min(q.remaining, REFRESH_BATCH)
  const list = staleList().sort(byOldest).slice(0, budget)
  if (!list.length) {
    toast(`这些收藏都在 ${STALE_DAYS} 天有效期内，暂时不需要刷新`)
    return
  }
  refreshRepos(list, '刷新数据')
}

async function addRepo() {
  if (adding.value) return
  if (!requireSync('收藏项目')) return
  const fullName = parseRepoInput(input.value)
  if (!fullName) {
    toast('请输入正确的 GitHub 项目地址，如 https://github.com/dyqn/pixlite', true)
    return
  }
  adding.value = true
  try {
    const repo = await fetchRepo(fullName)
    const isNew = favorites.add(repo)
    input.value = ''
    toast(isNew ? `已收藏 ${repo.fullName} ★${formatNumber(repo.stargazers)}` : `已更新 ${repo.fullName} 的数据`)
    if (!isNew) flashCard(repo.fullName)
  } catch (e) {
    toast(e.message, true)
  } finally {
    adding.value = false
  }
}

// 重复收藏时定位到已有卡片：若被当前筛选隐藏则先清空筛选，再滚动 + 闪光提示
async function flashCard(fullName) {
  const key = fullName.toLowerCase()
  if (!filtered.value.some((r) => r.fullName.toLowerCase() === key)) {
    query.value = ''
    lang.value = ''
    cat.value = ''
  }
  await nextTick()
  const idx = filtered.value.findIndex((r) => r.fullName.toLowerCase() === key)
  if (idx < 0) return
  measure()
  const row = Math.floor(idx / cols.value)
  anchorRow.value = row // 强制目标行进入渲染窗口，哪怕它在几万行之外
  await nextTick()
  const wrap = gridWrap.value
  if (wrap) {
    const y = wrap.getBoundingClientRect().top + window.scrollY + row * stride.value - window.innerHeight / 2
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' })
  }
  const el = [...document.querySelectorAll('.card')].find(
    (c) => c.dataset.fullName && c.dataset.fullName.toLowerCase() === key
  )
  if (el) {
    el.classList.remove('flash')
    void el.offsetWidth
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 2400)
  }
  // 平滑滚动落位后再解除锚定，届时自然窗口已包含目标行
  setTimeout(() => { anchorRow.value = null }, 1200)
}

function toggleDark() {
  dark.value = !dark.value
  document.documentElement.classList.toggle('dark', dark.value)
  localStorage.setItem('ghf:dark', dark.value ? '1' : '0')
}

onMounted(() => {
  if (localStorage.getItem('ghf:dark') === '1') {
    dark.value = true
    document.documentElement.classList.add('dark')
  }
  // 支持搜索引擎/站内搜索通过 ?q= 传入关键词（与结构化数据 SearchAction 对应）
  const q = new URLSearchParams(window.location.search).get('q')
  if (q) query.value = q.slice(0, 200)
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', measure)
  measure()
  onSyncToast(toast)
  initSync()
    .then(loadDefaults)
    .then(initBackup)
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', measure)
  clearTimeout(scrollTimer)
})
</script>

<template>
  <header class="header">
    <div class="header-inner">
      <div class="brand" title="回到首页" @click="goHome">
        <img src="/favicon.svg" alt="logo" width="32" height="32" />
        <div>
          <h1>GitHub 收藏</h1>
          <p class="tagline">/favorites.open-source</p>
        </div>
      </div>
      <div class="header-right">
        <button class="icon-btn" :disabled="!!refreshingAll" :title="refreshingAll ? `刷新中 ${refreshingAll.done}/${refreshingAll.total}` : '刷新数据（更新 Star / Fork，只刷超过 30 天的，每次最多 10 条）'" @click="refreshDataNow">
          <svg viewBox="0 0 24 24" :class="{ spinning: !!refreshingAll }" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6"/></svg>
        </button>
        <button class="icon-btn" :title="dark ? '切换浅色' : '切换深色'" @click="toggleDark">
          <svg v-if="dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
        </button>
        <button class="icon-btn" title="设置" @click="showSettings = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z"/></svg>
        </button>
      </div>
    </div>
  </header>

  <main class="main">
    <section class="hero">
      <h2>收藏有趣的开源项目</h2>
      <p class="lead">粘贴一个 GitHub 地址，自动解析项目介绍与 Star / Fork 数据。数据本地保存，可开启云端同步跨设备使用。</p>
      <div class="add-box">
        <input
          v-model="input"
          class="add-input"
          type="text"
          placeholder="https://github.com/dyqn/pixlite 或 dyqn/pixlite"
          @keyup.enter="addRepo"
        />
        <button class="btn primary" :disabled="adding" @click="addRepo">
          {{ adding ? '解析中…' : '收藏项目 →' }}
        </button>
      </div>
      <p class="hero-hint">auto-parsed description · stars · forks · cross-device sync</p>
    </section>

    <section class="toolbar">
      <input v-model="query" class="search" type="search" placeholder="搜索名称、简介或标签…" />
      <select v-model="lang" class="select">
        <option value="">全部语言</option>
        <option v-for="l in languages" :key="l" :value="l">{{ l }}</option>
      </select>
      <select v-model="sort" class="select">
        <option value="added">按收藏时间</option>
        <option value="stars">按 Star 数</option>
        <option value="forks">按 Fork 数</option>
        <option value="name">按名称</option>
      </select>
    </section>

    <nav class="chips">
      <button class="chip" :class="{ active: cat === '' }" @click="cat = ''">全部</button>
      <button
        v-for="c in categories"
        :key="c"
        class="chip"
        :class="{ active: cat === c }"
        @click="cat = cat === c ? '' : c"
      >{{ c }}</button>
      <button
        v-if="items.some((i) => !i.category)"
        class="chip"
        :class="{ active: cat === '__none__' }"
        @click="cat = cat === '__none__' ? '' : '__none__'"
      >未分类</button>
      <!-- 仅开启云端同步后才提供批量管理入口 -->
      <button v-if="sync.enabled" class="chip manage" @click="showCatManager = true">管理分类</button>
    </nav>

    <section v-if="filtered.length" ref="gridWrap" class="grid-wrap" :style="{ height: totalH + 'px' }">
      <div class="grid" :style="gridStyle">
        <RepoCard v-for="r in windowItems" :key="r.fullName" :repo="r" :data-full-name="r.fullName" @toast="toast" />
      </div>
    </section>
    <section v-else class="empty">
      <p>{{ items.length ? '没有匹配的项目，换个关键词试试' : '还没有收藏，粘贴一个 GitHub 项目地址开始吧' }}</p>
    </section>

    <SettingsModal v-if="showSettings" @close="showSettings = false" @toast="toast" />
    <CategoryManager v-if="showCatManager" @close="showCatManager = false" @toast="toast" />
  </main>

  <footer class="footer">
    <nav class="foot-links">
      <a href="https://github.com/dyqn/github-favorites" target="_blank" rel="noopener">GitHub</a>
      <span class="sep">·</span>
      <a href="https://logo.kusheji.com" target="_blank" rel="noopener">矢量logo下载</a>
      <span class="sep">·</span>
      <a href="https://yj.dyqn.com" target="_blank" rel="noopener">壁纸样机生成器</a>
      <span class="sep">·</span>
      <a href="https://qt.dyqn.com" target="_blank" rel="noopener">轻图 Pixlite</a>
      <span class="sep">·</span>
      <a href="https://pintu.dyqn.com" target="_blank" rel="noopener">多元拼图</a>
    </nav>
    <div class="foot-note">数据来自 GitHub API · 收藏保存在你的浏览器本地，你可以设置同步密码后开启云端同步。</div>
    <div class="foot-stat">本网站已收录 {{ items.length }} 个开源项目</div>
  </footer>

  <Transition name="fade">
    <button v-if="showTop" class="back-top icon-btn" title="返回顶部" @click="goTop">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
    </button>
  </Transition>

  <Transition name="fade">
    <div v-if="toastMsg" class="toast" :class="{ error: toastErr }">{{ toastMsg }}</div>
  </Transition>
</template>
