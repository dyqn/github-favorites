// 云盘备份：把当前收藏写进用户自己的 WebDAV 云盘（按日期留最近 5 份），
// 以及从云盘最新一份备份「合并」回本地。日常跨设备同步仍走本站云端（/api/sync）。
import { favorites } from './favorites'
import { getCatOrderState } from './catOrder'
import { mergeData, mergeCatOrders } from './merge'
import { applyMerged, notify, push, sync } from './sync'
import { parseFavoritesDoc } from '../api/syncStore'
import {
  getWebDavConfig,
  isWebDavConfigured,
  writeBackup,
  readLatestBackup,
  getAutoBackup,
  getLastBackupAt,
  setLastBackupAt,
} from '../api/webdav'

// 按北京时间的日期串，用来判断"今天备过没有"
const beijingDay = (iso = new Date().toISOString()) => {
  const t = iso ? new Date(iso).getTime() : Date.now()
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function currentDoc() {
  const co = getCatOrderState()
  return { items: favorites.items.value, deleted: favorites.getDeleted(), catOrder: co.order, catOrderAt: co.at }
}

function requireConfig() {
  const config = getWebDavConfig()
  if (!isWebDavConfigured(config)) throw new Error('请先填写并保存云盘服务器地址、用户名和应用密码')
  return config
}

export async function backupNow() {
  // 没手动收藏过的人看到的是本站默认列表，别让他把别人的清单当成"自己的备份"存走
  if (!favorites.isUserOwned()) throw new Error('你还没有添加过收藏，无法备份；先在页面上收藏项目或导入自己的文件')
  const config = requireConfig()
  if (!favorites.items.value.length) throw new Error('当前没有可备份的收藏')
  const r = await writeBackup(config, currentDoc())
  setLastBackupAt(new Date().toISOString())
  return `已备份 ${r.count} 条收藏到云盘（${r.file || 'github-favorites.json'}）`
}

export async function restoreFromCloud() {
  const config = requireConfig()
  const found = await readLatestBackup(config)
  if (!found) throw new Error('云盘里还没有备份文件，请先点「立即备份」')
  const remote = parseFavoritesDoc(found.data)
  const merged = mergeData(favorites.items.value, favorites.getDeleted(), remote.items, remote.deleted)
  const local = getCatOrderState()
  const co = mergeCatOrders(local.order, local.at, remote.catOrder, remote.catOrderAt)
  applyMerged(merged.items, merged.deleted, co.order, co.at)
  let msg = `已从云盘备份合并（${found.file}），当前 ${merged.items.length} 条`
  // 合并结果不会自动触发推送（applyMerged 是静默的），这里补一次，让本站云端也跟上
  if (sync.enabled) {
    try {
      await push({ mergeFirst: true })
      msg += ' · 已推送到本站云端'
    } catch (e) {
      msg += ` · 推送本站云端失败：${e.message}`
    }
  }
  return msg
}

// 每天自动备份一次（开关在设置里；没填凭据或本机还没收藏过就不动）
export async function initBackup() {
  if (!getAutoBackup()) return
  // 云盘备份整块界面只在开启云端同步后可见，后台也按同一口径：关了同步就不再往云盘写
  if (!sync.enabled) return
  if (!favorites.isUserOwned()) return
  const config = getWebDavConfig()
  if (!isWebDavConfigured(config)) return
  const last = getLastBackupAt()
  if (last && beijingDay(last) === beijingDay()) return
  try {
    notify(await backupNow())
  } catch (e) {
    notify('云盘自动备份失败：' + e.message, true)
  }
}
