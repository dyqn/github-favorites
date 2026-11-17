import { reactive } from 'vue'
import { readRemote, saveRemote, getSyncPassword } from '../api/syncStore'
import { favorites, onPersist } from './favorites'
import { mergeData, mergeCatOrders } from './merge'
import { getCatOrderState, setCatOrder, onCatOrderChange } from './catOrder'

const ENABLED_KEY = 'ghf:syncEnabled'

// 只有真正操作过数据（localStorage 里有自己的收藏）的用户才算开启了同步；
// 新访客即使误留了开关记录也不会去读写云端，避免默认态被写脏。
function readEnabled() {
  return localStorage.getItem(ENABLED_KEY) === '1' && favorites.isUserOwned()
}

export const sync = reactive({
  enabled: readEnabled(),
  autoSync: localStorage.getItem('ghf:autoSync') === '1',
  busy: false,
  lastSyncAt: '',
})

const toastHandlers = []
export function onSyncToast(fn) {
  toastHandlers.push(fn)
}
function toast(msg, isErr = false) {
  toastHandlers.forEach((fn) => fn(msg, isErr))
}

// 给别的 store（云盘备份）复用同一条提示通道
export function notify(msg, isErr = false) {
  toast(msg, isErr)
}

export function setAutoSync(v) {
  sync.autoSync = v
  localStorage.setItem('ghf:autoSync', v ? '1' : '0')
}

async function withLock(fn) {
  if (sync.busy) throw new Error('同步进行中，请稍候')
  sync.busy = true
  try {
    return await fn()
  } finally {
    sync.busy = false
  }
}

let suppressAuto = false

export async function push({ mergeFirst = false } = {}) {
  return withLock(async () => {
    if (!sync.enabled) throw new Error('尚未开启云端同步')
    let items = favorites.items.value
    let deleted = favorites.getDeleted()
    let co = getCatOrderState()
    if (mergeFirst) {
      try {
        const remote = await readRemote()
        const merged = mergeData(items, deleted, remote.items, remote.deleted)
        items = merged.items
        deleted = merged.deleted
        co = mergeCatOrders(co.order, co.at, remote.catOrder, remote.catOrderAt)
        replaceQuietly(items, deleted)
        setCatOrder(co.order, co.at)
      } catch { /* 云端读不到时退回整体覆盖 */ }
    }
    await saveRemote({ items, deleted, catOrder: co.order, catOrderAt: co.at })
    sync.lastSyncAt = new Date().toLocaleTimeString()
  })
}

let pushTimer = null
function schedulePush() {
  if (suppressAuto || !sync.autoSync || !sync.enabled) return
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    push({ mergeFirst: true })
      .then(() => toast('已自动同步到云端'))
      .catch((e) => toast('自动同步失败：' + e.message, true))
  }, 2000)
}

function replaceQuietly(list, deleted) {
  suppressAuto = true
  try {
    favorites.replaceAll(list)
    if (deleted) favorites.setDeleted(deleted)
  } finally {
    suppressAuto = false
  }
}

// 把合并结果写回本地而不触发自动推送（拉取、恢复共用这一条路）
export function applyMerged(items, deleted, order, orderAt) {
  replaceQuietly(items, deleted)
  setCatOrder(order, orderAt)
}

export async function pull() {
  return withLock(async () => {
    if (!sync.enabled) throw new Error('尚未开启云端同步')
    const remote = await readRemote()
    const merged = mergeData(favorites.items.value, favorites.getDeleted(), remote.items, remote.deleted)
    const local = getCatOrderState()
    const co = mergeCatOrders(local.order, local.at, remote.catOrder, remote.catOrderAt)
    applyMerged(merged.items, merged.deleted, co.order, co.at)
    sync.lastSyncAt = new Date().toLocaleTimeString()
  })
}

// 换设备时填同一个同步密码即可接上同一份云端收藏：读云端 → 合并 → 写回
export async function enableCloudSync() {
  return withLock(async () => {
    if (!getSyncPassword()) throw new Error('请先在「同步密码」处填写并保存密码')
    const remote = await readRemote()
    const hadData = remote.items.length > 0
    const merged = mergeData(favorites.items.value, favorites.getDeleted(), remote.items, remote.deleted)
    const local = getCatOrderState()
    const co = mergeCatOrders(local.order, local.at, remote.catOrder, remote.catOrderAt)
    const doc = { items: merged.items, deleted: merged.deleted, catOrder: co.order, catOrderAt: co.at }
    // 先写成功再置为已开启：密码错误时不应让界面显示「已开启云端同步」
    await saveRemote(doc)
    applyMerged(merged.items, merged.deleted, co.order, co.at)
    sync.enabled = true
    localStorage.setItem(ENABLED_KEY, '1')
    setAutoSync(true)
    toast(hadData ? '已关联云端收藏并完成合并' : '云端还没有数据，已把本地收藏上传为初始数据')
    sync.lastSyncAt = new Date().toLocaleTimeString()
  })
}

export function disableCloudSync() {
  sync.enabled = false
  setAutoSync(false)
  localStorage.removeItem(ENABLED_KEY)
  toast('已关闭云端同步（云端数据仍保留）')
}

export async function initSync() {
  onPersist(schedulePush)
  onCatOrderChange(schedulePush)
  if (sync.autoSync && sync.enabled && getSyncPassword()) {
    try {
      await pull()
      toast('已从云端同步最新收藏')
    } catch (e) {
      toast('云端自动拉取失败：' + e.message, true)
    }
  }
}
