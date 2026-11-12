import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const req = createRequire(join(ROOT, '03_源代码', 'frontend', 'package.json'))
let puppeteer = req('puppeteer-core')
if (puppeteer?.default) puppeteer = puppeteer.default

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p))

const target = process.argv[2] || join(ROOT, '03_源代码', 'frontend', 'screen_dist', 'index.html')
const outDir = join(ROOT, '.shots')
const mode = process.argv[3] || 'all'

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--allow-file-access-from-files', '--use-gl=angle', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
})
const page = await browser.newPage()
const [vw, vh] = (process.env.VIEW || '1600x900').split('x').map(Number)
await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 1 })

const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto(pathToFileURL(target).href, { waitUntil: 'load', timeout: 60000 })
await new Promise((r) => setTimeout(r, 4500))
await page.screenshot({ path: join(outDir, 's1_login.png') })

if (mode !== 'login') {
  await page.click('#enter')
  await new Promise((r) => setTimeout(r, 6500))
  await page.screenshot({ path: join(outDir, 's2_screen.png') })

  const info = await page.evaluate(() => ({
    fps: document.querySelector('#fps')?.textContent,
    tris: document.querySelector('#tris')?.textContent,
  }))
  console.log('HUD', JSON.stringify(info))

  for (const [mod, name] of [['well', 's3_well'], ['combo', 's4_combo'], ['review', 's5_review'], ['report', 's8_report'], ['model', 's6_model']]) {
    await page.click(`.dk[data-mod="${mod}"]`)
    await new Promise((r) => setTimeout(r, 1400))
    await page.screenshot({ path: join(outDir, `${name}.png`) })
  }

  await page.evaluate(() => document.querySelector('#dr-close').click())
  await new Promise((r) => setTimeout(r, 1200))
  await page.screenshot({ path: join(outDir, 's7_clean.png') })
}

console.log(logs.filter((l) => /error|warn|pageerror/i.test(l)).slice(0, 20).join('\n') || 'no errors')
await browser.close()
