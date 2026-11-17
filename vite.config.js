import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 本地开发时把 /api/sync、/api/webdav 代理到真实接口所在的地方：
//   默认指向线上站点；想连本地跑的边缘函数，用 SYNC_PROXY=http://127.0.0.1:5200 npm run dev
const syncProxyTarget = process.env.SYNC_PROXY || 'https://github.dyqn.com'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 5199,
    proxy: {
      '/api/sync': { target: syncProxyTarget, changeOrigin: true },
      '/api/webdav': { target: syncProxyTarget, changeOrigin: true },
    },
  },
})
