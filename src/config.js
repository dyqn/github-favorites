// 网站自己的云端同步接口（由 EdgeOne Pages 边缘函数 functions/api/sync 提供，数据存 KV）
// 未部署边缘函数时读取会失败，页面自动降级到 /defaults.json 与内置示例数据。
export const SYNC_API_URL = '/api/sync'
