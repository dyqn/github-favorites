# GitHub 收藏（GitHub Favorites）

一个开源项目收藏网站：

- **添加收藏**：粘贴 GitHub 项目地址（`owner/repo` 或完整 URL），自动调用 GitHub API 解析项目介绍、Star、Fork、语言、标签、最近更新时间
- **查看/跳转**：点击卡片标题直达项目主页，有官网的项目显示「官网 ↗」
- **刷新数据**：每张卡片可一键重新拉取最新 Star/Fork 数据
- **搜索与筛选**：按名称/简介/标签搜索，按语言筛选，按收藏时间、Star、Fork、名称排序
- **分类管理**：每个项目可打自定义分类标签（卡片上直接输入，带常用分类联想），顶部按分类筛选（含"未分类"），分类顺序随云端同步
- **本地持久化**：收藏保存在浏览器 localStorage，内置 12 个示例项目开箱可见；支持导出/导入 JSON 备份
- **跨设备云同步**：收藏同步到本网站自己的云端存储（EdgeOne Pages 边缘函数 + KV，数据键 `github-favorites.json`）。任何设备填同一个「同步密码」点「开启云端同步」即自动关联，新增、修改、取消收藏都会自动同步（删除采用墓碑记录，90 天后自动清理），也支持手动拉取合并 / 推送覆盖
- **暗色模式**、移动端自适应

## 技术栈

Vue 3 + Vite，纯静态站点，无后端。

## 本地开发

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 产物输出到 dist/
```

## 部署

构建命令统一为 `npm run build`，输出目录 `dist`。任选其一：

### 1. 腾讯云 EdgeOne Pages

1. 将本目录推送到 GitHub 仓库
2. 登录 [EdgeOne Pages 控制台](https://edgeone.ai/zh/products/pages) → 新建项目 → 关联该仓库
3. Framework 选 **Vite**（自动识别构建命令 `npm run build`、输出目录 `dist`），保存后自动构建部署
4. 也可在控制台用「直接上传」方式上传本地 `dist/` 目录

> 云端同步（`/api/sync` 边缘函数 + KV）只有 EdgeOne Pages 支持，需要额外做两项控制台设置，见下面「云端同步与默认公共收藏」。

### 2. Vercel

```bash
npx vercel        # 首次：关联项目，Framework 选 Vite，其余默认
npx vercel --prod # 部署到生产
```

或在 [vercel.com](https://vercel.com) 导入 GitHub 仓库，Vercel 会自动识别 Vite（Build Command `npm run build`，Output `dist`）。

### 3. Cloudflare Pages

```bash
npx wrangler pages deploy dist --project-name github-favorites
```

或在 Cloudflare Dashboard → Workers & Pages → 导入 GitHub 仓库，
Build command `npm run build`，Build output directory `dist`。

## 更新示例数据

内置收藏来自 `src/data/seed.json`（首次打开、localStorage 为空且未配置默认收藏时展示）。想刷新：

```bash
node scripts/fetch-seed.mjs   # 修改脚本里的仓库列表后重新生成 seed.json
```

## 云端同步与默认公共收藏（EdgeOne Pages）

数据存在你自己站点的 KV 里，访客默认列表和跨设备同步读的是同一个接口 `/api/sync`，不再依赖 GitHub。

### 一、EdgeOne Pages 控制台设置（一次性，共两项）

1. **绑定 KV 存储**：控制台 → 你的 Pages 项目 → 设置里的 **KV 存储 / 服务绑定** → 创建一个命名空间（名字随意，例如 `github-favorites`）并绑定到本项目，**绑定变量名必须填 `favorites_kv`**；保存后重新部署一次才生效。
2. **新增环境变量**：同一设置页 → **环境变量 / Environment Variables** → 添加 `SYNC_PASSWORD`，值为你自己定的同步密码（建议 12 位以上，混合大小写字母、数字和符号）。这是**写入云端数据的唯一凭证**，忘了只能回控制台改。

可选：如果你把 KV 绑定成了别的变量名，再加一个环境变量 `KV_BINDING` = 那个名字即可，**不用改代码**。

### 二、自检（部署完成后浏览器直接访问）

打开 `https://你的域名/api/sync`，按返回内容判断：

| 返回内容 | 含义 / 处理 |
| --- | --- |
| `{"error":"no-data"}` | 一切就绪，只是云端还没有数据 |
| 一段 `<!doctype html> …` | 边缘函数没部署上：确认 `functions/` 目录已提交推送、并触发过一次构建 |
| `{"error":"KV 命名空间未绑定到变量 favorites_kv…"}` | 绑定名不一致：把控制台绑定名改成 `favorites_kv`，或设置 `KV_BINDING` |
| 写入时报 `{"error":"服务端未配置环境变量 SYNC_PASSWORD"}` | 环境变量没填（只影响写入，读取和访客浏览不受影响） |

### 三、在网站里开启同步

1. 点右上角齿轮「设置」→ 打开「设置与数据」；
2. 在 **同步密码（开启云端同步必填）** 一栏输入控制台设置的 `SYNC_PASSWORD` → 点旁边的「保存」；
3. 点 **「开启云端同步」**：云端还是空的会提示「云端还没有数据，已把本地收藏上传为初始数据」，云端已有数据则提示「已关联云端收藏并完成合并」；
4. 之后每次收藏、改分类、取消收藏都会自动写回云端，访客看到的默认列表随之更新；同时「管理分类」入口和卡片上的分类编辑也会解锁（未开启同步时分类是只读的）；
5. 换设备/换浏览器：重复第 1～2 步（填同一个密码）再点「开启云端同步」，会自动与云端合并。删除采用墓碑记录（保留 90 天），已删的项目不会被别的设备旧数据复活。

按钮语义：**拉取合并** = 主动与云端合并一次；**推送到云端** = 用本地整体覆盖云端，用于把云端重置成本地状态；**关闭同步** = 只断开本设备，云端数据仍保留。

新访客数据三级降级（任何一层失败自动走下一层，页面永远不会开天窗）：

1. **本站 `/api/sync`**（KV 里的最新数据，秒级更新）；
2. **本站 `/defaults.json`**（纯静态兜底，由 `.github/workflows/sync-defaults.yml` 每天从 `/api/sync` 抓一份提交进仓库并触发重新部署，最多滞后 1 天，无需任何密钥）；
3. **内置 `seed.json` 示例数据**（随代码打包，完全离线可用）。

### 四、限制与注意

- 云端收藏文档是**公开可读**的（访客默认列表要用），只有写入需要密码；请只在网站自己的 HTTPS 页面里输入它，密码只存在本机浏览器 localStorage。
- KV 单个 value 上限 1MB，函数按 900KB 拦截，收藏特别多时请定期「导出收藏 JSON」备份。
- KV 采用最终一致性（最长约 60 秒）：在 A 设备刚改完立刻在 B 设备开启同步，可能读到几秒前的数据，必要时再点一次「拉取合并」。
- 云端同步与 `/api/sync` 只在 **EdgeOne Pages** 生效。部署到 Vercel / Cloudflare Pages 时第 1 级不存在，会自动降级到 `/defaults.json`，站点照常显示，只是没有云端同步。
- 解析项目走 GitHub 匿名 API（每小时 60 次），超限会提示稍后再试；网站不再需要任何 GitHub Token。

### 五、可选：把收藏备份到自己的 WebDAV 云盘（坚果云 / InfiniCloud 等）

云端同步固定走本站 KV；WebDAV 是**额外的备份渠道**，两者互不影响，不需要二选一。入口在「设置 → 云盘备份（WebDAV，可选）」：

- **立即备份**：手动把当前收藏写到云盘，文件名按北京日期命名（`github-favorites_20261014.json`）；同一天再点会覆盖当天那份。每次写入后端自动清理，**只保留最近 5 份**。
- **每天自动备份一次**：开关存在本机（`ghf:webdavBackup`）。开启后每次打开网站都会检查，当天还没备份过就自动补一份，已经备份过则跳过；只有这台浏览器里确实存过你自己的收藏时才触发，纯新访客看到的示例列表不会被误写进云盘。
- **从云盘恢复**：读取云盘里最新一份，和**本地收藏做合并**（不清空、不覆盖本地），合并规则和云端同步一致——按 `catAt` 取较新、删除墓碑 90 天内生效。若已开启云端同步，恢复完成后还会把合并结果推回本站云端。

其余注意点：

- 无需控制台配置：`functions/api/webdav/index.js` 已随代码部署。浏览器不能直接访问云盘（对方不发 CORS 头，PROPFIND/PUT 也过不了预检），所以由这个同域接口转发一次。
- 云盘地址、用户名、应用密码只存在**本机浏览器 localStorage**（键 `ghf:webdav`），每次请求临时带上，服务器上不留痕；坚果云要用「安全选项」里生成的**应用密码**，地址 `https://dav.jianguoyun.com/dav/`，备份会自动放进 `dav/github-favorites/` 子目录（根目录 `/dav/` 不允许写文件）。
- 备份文件只有你自己能读，**访客默认列表仍然只来自本站 KV**（`/api/sync` → `/defaults.json` → `seed.json` 三级降级），做云盘备份不会改变访客看到的内容。
- 这个接口没有登录态，自我保护只有对目标地址的严格限制：只允许 https、拒绝内网/保留地址（`localhost`、`127.`、`10.`、`172.16-31.`、`192.168.`、`169.254.` 等），写入按 900KB 拦截；清理旧备份时只会删除该目录下形如 `github-favorites_YYYYMMDD.json` 的文件。

## 本地开发与云端接口

`npm run dev`（默认 5199 端口、`--host` 可局域网访问）会把 `/api/sync` 和 `/api/webdav` 代理到线上站点；本地想连自己的接口服务时用环境变量改目标，例如：

```bash
SYNC_PROXY=http://127.0.0.1:5200 npm run dev
```

也可以直接用 `edgeone pages dev` 跑真实函数（本地需按 `edgeone pages init/link` 关联项目的 KV 绑定与环境变量）。注意直接双击 `dist/index.html`（`file://`）打开时同源接口无法请求，页面会自动用内置示例数据。

## 目录结构

```
├── index.html
├── functions/api/sync/index.js  # 边缘函数：/api/sync（GET 读 / PUT 写，KV 存储 + 同步密码校验）
├── functions/api/webdav/index.js # 边缘函数：/api/webdav（WebDAV 云盘代理，只允许 https + 公网地址）
├── src/
│   ├── App.vue                  # 页面主体：添加、搜索、筛选、排序、虚拟滚动列表
│   ├── config.js                # 云端同步接口地址等同站配置
│   ├── api/github.js            # GitHub API 封装、地址解析
│   ├── api/syncStore.js         # 云端同步：同步方式（本站 KV / WebDAV）分发、读写、凭据存取
│   ├── api/webdav.js            # WebDAV 云盘：配置存取、测试连接、读写收藏
│   ├── api/defaults.js          # 拉取默认公共收藏（/api/sync → 本站 defaults.json 降级）
│   ├── store/favorites.js       # 收藏状态 + localStorage 持久化（含删除墓碑记录）
│   ├── store/catOrder.js        # 分类显示顺序（随云端同步，按修改时间戳新旧合并）
│   ├── store/merge.js           # 同步合并纯逻辑（收藏项 + 墓碑）
│   ├── store/sync.js            # 云端同步：开启/拉取合并/推送/自动同步
│   ├── components/
│   │   ├── RepoCard.vue         # 项目卡片（star/fork/刷新/删除）
│   │   ├── CategoryManager.vue  # 管理分类弹窗（排序/批量重命名/删除）
│   │   └── SettingsModal.vue    # 同步方式（本站云端 / WebDAV 云盘）、凭据设置、导出/导入
│   ├── data/seed.json           # 内置示例收藏
│   └── style.css                # 全局样式（含暗色模式）
├── public/
│   ├── favicon.svg
│   └── defaults.json            # 同域兜底默认收藏（Actions 每日自动同步）
├── .github/workflows/sync-defaults.yml  # 定时：/api/sync → public/defaults.json
└── scripts/fetch-seed.mjs       # 重新生成示例数据
```
