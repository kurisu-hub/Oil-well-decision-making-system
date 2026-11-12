// 构建包装脚本（Windows 兜底）
// 现象：工程位于「受控文件夹访问」保护目录（如 Desktop）时，位于该目录内的
// esbuild.exe 会被拒绝读取任何文件，报 "Cannot read file ... winapi error #5"。
// 对策：把 esbuild.exe 复制到系统临时目录再指定 ESBUILD_BINARY_PATH。
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const env = { ...process.env }

if (process.platform === 'win32') {
  const src = resolve('node_modules/@esbuild/win32-x64/esbuild.exe')
  if (existsSync(src)) {
    // 用带 pid 的唯一文件名：旧副本若被上一次的 esbuild 服务进程占用（EBUSY）也不影响本次
    const dst = join(tmpdir(), `esbuild-host-${process.pid}.exe`)
    try {
      copyFileSync(src, dst)
      env.ESBUILD_BINARY_PATH = dst
      console.log('[build] esbuild 已改用临时目录副本（规避受控文件夹访问限制）')
    } catch (e) {
      console.warn('[build] 复制 esbuild 失败，按原路径尝试：', e.message)
    }
  }
}

const viteBin = resolve('node_modules/vite/bin/vite.js')
const r = spawnSync(process.execPath, [viteBin, 'build'], { stdio: 'inherit', env })
process.exit(r.status ?? 1)
