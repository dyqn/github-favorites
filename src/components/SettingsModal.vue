<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { getSyncPassword, setSyncPassword } from '../api/syncStore'
import { getWebDavConfig, setWebDavConfig, testWebDavConnection, getAutoBackup, setAutoBackup, getLastBackupAt } from '../api/webdav'
import { favorites } from '../store/favorites'
import { clearLocalCatOrder } from '../store/catOrder'
import { sync, enableCloudSync, pull, push, disableCloudSync, setAutoSync } from '../store/sync'
import { backupNow, restoreFromCloud } from '../store/backup'

const emit = defineEmits(['toast', 'close'])

function onKey(e) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
const syncPassword = ref(getSyncPassword())
const fileInput = ref(null)

const webdav = ref(getWebDavConfig())
const wdTesting = ref(false)
const wdResult = ref('')
const wdDetail = ref('')
const autoBackup = ref(getAutoBackup())
const lastBackupAt = ref(getLastBackupAt())
const busyBackup = ref(false)
const busyRestore = ref(false)

const lastBackupText = computed(() => (lastBackupAt.value ? new Date(lastBackupAt.value).toLocaleString() : ''))

async function run(fn, okMsg) {
  try {
    await fn()
    if (okMsg) emit('toast', okMsg)
  } catch (e) {
    emit('toast', e.message, true)
  }
}

// 先落盘密码再开启同步，enableCloudSync 才能读到
function saveSyncPassword() {
  setSyncPassword(syncPassword.value)
  emit('toast', syncPassword.value.trim() ? '同步密码已保存' : '同步密码已清除')
}

// 未开启同步时界面是只读的，本机旧快照没有别的出口，只能清掉后重新看云端列表
const armedClear = ref(false)
let clearTimer = null
function armClear() {
  armedClear.value = true
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => { armedClear.value = false }, 3000)
}
function disarmClear() {
  clearTimeout(clearTimer)
  armedClear.value = false
}
onBeforeUnmount(() => clearTimeout(clearTimer))

function clearLocalData() {
  if (!armedClear.value) return armClear()
  favorites.clearLocal()
  clearLocalCatOrder()
  location.reload()
}

function saveWebDav() {
  setWebDavConfig(webdav.value)
  wdResult.value = ''
  wdDetail.value = ''
  emit('toast', '云盘配置已保存')
}

function toggleAutoBackup(e) {
  autoBackup.value = e.target.checked
  setAutoBackup(e.target.checked)
  emit('toast', e.target.checked ? '已开启每天自动备份' : '已关闭每天自动备份')
}

async function doBackup() {
  busyBackup.value = true
  try {
    emit('toast', await backupNow())
    lastBackupAt.value = getLastBackupAt()
  } catch (e) {
    emit('toast', e.message, true)
  } finally {
    busyBackup.value = false
  }
}

async function doRestore() {
  busyRestore.value = true
  try {
    emit('toast', await restoreFromCloud())
  } catch (e) {
    emit('toast', e.message, true)
  } finally {
    busyRestore.value = false
  }
}

async function testWebDav() {
  wdTesting.value = true
  wdResult.value = ''
  wdDetail.value = ''
  try {
    const r = await testWebDavConnection(webdav.value)
    if (r.success) {
      wdResult.value = 'ok'
      setWebDavConfig(webdav.value)
    } else {
      wdResult.value = 'fail'
      wdDetail.value = [r.error, r.detail].filter(Boolean).join('\n')
    }
  } catch (e) {
    wdResult.value = 'fail'
    wdDetail.value = e.message
  } finally {
    wdTesting.value = false
  }
}

function exportFile() {
  const blob = new Blob([favorites.exportJSON()], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `github-favorites-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  emit('toast', '已导出收藏文件')
}

async function importFile(e) {
  const file = e.target.files?.[0]
  if (!file) return
  try {
    const n = favorites.importJSON(await file.text())
    emit('toast', `导入成功，共 ${n} 个项目`)
  } catch (err) {
    emit('toast', '导入失败：' + err.message, true)
  }
  e.target.value = ''
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>设置与数据</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>

      <section>
        <h4>云端同步</h4>
        <p class="hint">收藏保存在本网站自己的云端存储（EdgeOne KV）里。在任何设备填写相同的<b>同步密码</b>并点「开启云端同步」，即可接上同一份收藏。</p>
        <p class="hint">
          <template v-if="sync.enabled">
            已开启云端同步<span v-if="sync.lastSyncAt"> · 上次同步 {{ sync.lastSyncAt }}</span>
          </template>
          <template v-else>当前：未开启，数据仅保存在本浏览器</template>
        </p>
        <div class="row wrap">
          <button v-if="!sync.enabled" class="btn primary" :disabled="sync.busy" @click="run(enableCloudSync)">
            {{ sync.busy ? '同步中…' : '开启云端同步' }}
          </button>
          <template v-else>
            <button class="btn" :disabled="sync.busy" @click="run(pull, '已从云端拉取并合并')">拉取合并</button>
            <button class="btn" :disabled="sync.busy" @click="run(push, '已推送本地收藏到云端（覆盖云端）')">推送到云端</button>
            <button class="btn" @click="disableCloudSync()">关闭同步</button>
          </template>
        </div>
        <label v-if="sync.enabled" class="switch" style="margin-top:10px">
          <input type="checkbox" :checked="sync.autoSync" @change="setAutoSync($event.target.checked)" />
          变更后自动推送
        </label>
        <p class="hint">说明：自动同步会先读取云端、合并后再写回，多设备并发修改基本不会互相覆盖；新增、修改、取消收藏都会自动同步（删除记录保留 90 天，删除后仍可重新收藏，不会复活旧数据）。「拉取合并」主动与云端合并一次；手动「推送到云端」则整体覆盖，用于以本地数据重置云端。云端单条数据上限约 900KB，收藏过多时请定期导出备份。</p>
        <template v-if="!sync.enabled">
          <div class="row wrap" style="margin-top:10px">
            <button
              class="btn"
              :class="{ 'danger-armed': armedClear }"
              :title="armedClear ? '再次点击确认：只清这台浏览器里存的收藏，云端和其他设备都不受影响' : '清掉这台浏览器里存的旧收藏，刷新后改看云端列表'"
              @mouseleave="armedClear && disarmClear()"
              @click="clearLocalData"
            >{{ armedClear ? '确认清除' : '清除本机数据' }}</button>
          </div>
          <p class="hint" style="margin-top:6px">没开启云端同步时，每个浏览器各存各的：如果在别的浏览器改动过收藏，这里显示的可能是很久以前的本机快照。点「清除本机数据」只删掉<b>这台浏览器</b>存的收藏，页面刷新后会重新显示云端的最新列表；云端数据、其他设备都不会被改动。</p>
        </template>
      </section>

      <section>
        <h4>同步密码（开启云端同步必填）</h4>
        <p class="hint">这是写入云端数据的唯一凭证，请设置一个只有你自己知道的密码（建议 12 位以上，混合字母、数字和符号），网站后台不会记录，也不会展示给别人。忘记这个密码就无法再写入云端，需要到 EdgeOne 控制台重新设置环境变量 <code>SYNC_PASSWORD</code>。</p>
        <div class="row">
          <input v-model="syncPassword" type="password" placeholder="你的同步密码" autocomplete="off" />
          <button class="btn" @click="saveSyncPassword">保存</button>
        </div>
        <p v-if="!sync.enabled" class="hint" style="margin-top:12px">开启云端同步后才会显示下面的云盘备份、导入导出等设置。</p>
      </section>

      <section v-if="sync.enabled">
        <h4>云盘备份（WebDAV，可选）</h4>
        <p class="hint">把当前收藏存档到<b>你自己的云盘</b>（坚果云、InfiniCloud 等支持 WebDAV 的服务）。这只是存档，跨设备同步仍由上面的云端同步负责；备份文件按日期命名，最多保留最近 5 份。</p>
        <div class="row">
          <input v-model="webdav.url" placeholder="服务器地址，如 https://dav.jianguoyun.com/dav/" autocomplete="off" spellcheck="false" />
        </div>
        <div class="row wrap" style="margin-top:8px">
          <input v-model="webdav.username" placeholder="用户名（云盘账号）" autocomplete="off" spellcheck="false" />
          <input v-model="webdav.password" type="password" placeholder="应用密码" autocomplete="off" />
        </div>
        <div class="row wrap" style="margin-top:8px">
          <button class="btn" :disabled="wdTesting" @click="testWebDav">{{ wdTesting ? '连接中…' : '测试连接' }}</button>
          <button class="btn" @click="saveWebDav">保存配置</button>
          <span v-if="wdResult === 'ok'" class="hint" style="margin:0;color:var(--ink)">连接成功，配置已保存</span>
        </div>
        <p v-if="wdResult === 'fail'" class="hint" style="color:var(--error);white-space:pre-line">{{ wdDetail }}</p>
        <div class="row wrap" style="margin-top:8px">
          <button class="btn pill primary" :disabled="busyBackup" @click="doBackup">{{ busyBackup ? '备份中…' : '立即备份' }}</button>
          <button class="btn pill" :disabled="busyRestore" @click="doRestore">{{ busyRestore ? '读取中…' : '从云盘恢复' }}</button>
        </div>
        <label class="switch" style="margin-top:10px">
          <input type="checkbox" :checked="autoBackup" @change="toggleAutoBackup" />
          每天自动备份一次
        </label>
        <p class="hint" style="margin-top:6px">{{ lastBackupText ? `上次备份：${lastBackupText}` : '还没备份过。「从云盘恢复」是把云盘里最新一份和本地合并，不会清空本地收藏。' }}</p>
        <p class="hint">坚果云请在「安全选项」里生成<b>应用密码</b>（不是登录密码），地址填 <code>https://dav.jianguoyun.com/dav/</code>，备份会自动存放在 <code>dav/github-favorites/</code> 子目录；InfiniCloud 需先在网页端开启「外部应用连接」。云盘账号和应用密码只保存在这台浏览器里，每次备份时临时交给同域接口 <code>/api/webdav</code> 转发一次，服务器上不会记录。</p>
      </section>

      <section v-if="sync.enabled">
        <h4>导出与导入（本地文件）</h4>
        <div class="row wrap">
          <button class="btn" @click="exportFile">导出收藏 JSON</button>
          <button class="btn" @click="fileInput.click()">导入 JSON</button>
        </div>
        <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="importFile" />
      </section>

      <section v-if="sync.enabled">
        <h4>关于</h4>
        <p class="hint">收藏数据保存在浏览器 localStorage 中，清除浏览器数据会丢失，请定期导出备份，或者开启云端同步、再往下可以每天自动备份到自己的云盘。</p>
      </section>
    </div>
  </div>
</template>
