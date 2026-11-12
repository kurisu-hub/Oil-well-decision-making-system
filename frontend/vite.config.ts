import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 离线单文件构建：
// - JSON 用 import 引入（禁止 fetch，file:// 下会被 CORS 拦）
// - cssCodeSplit=false + assetsInlineLimit 拉满：CSS/JS/资源全部内联进 index.html
// - 断网双击 dist/index.html 即可运行
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  // 监控页用内联样本，避免旧设备模型及其本地数据被复制到监控产物。
  publicDir: false,
  // .glb 不在 Vite 默认资产类型里：不声明会被 rollup 当 JS 解析（直接 import 报
  // Unexpected character '\0'）。声明后 ?url import 走 asset 管线，配合下方
  // assetsInlineLimit 内联成 data URI（D-004 A 案：单文件 file:// 双击可跑）
  assetsInclude: ['**/*.glb'],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 4000,
    reportCompressedSize: false,
    // 单文件产物里没有动态 chunk，preload 辅助函数是死代码且内含 fetch()，
    // 关掉它可让产物彻底不含联网 API（P9-5 判据）。
    modulePreload: false,
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
    },
  },
})
