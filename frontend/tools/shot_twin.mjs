import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const req = createRequire(join(ROOT, 'package.json'))
let puppeteer = req('puppeteer-core')
if (puppeteer.default) puppeteer = puppeteer.default

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p))

const target = process.argv[2] || join(ROOT, 'twin_dist', 'index.html')
const out = process.argv[3] || join(ROOT, '..', '..', '.shots', 'twin.png')
const W = Number(process.argv[4] || 1600)
const H = Number(process.argv[5] || 900)
const wait = Number(process.argv[6] || 12000)

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--allow-file-access-from-files', '--enable-unsafe-swiftshader', '--use-gl=angle', '--disable-gpu-sandbox', '--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
page.on('console', (m) => console.log('[' + m.type() + ']', m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message, '\n', e.stack))
const [tpath, tquery] = target.split('?')
const url = pathToFileURL(tpath).href + (tquery ? '?' + tquery : '')
await page.goto(url, { waitUntil: 'load', timeout: 120000 })
await new Promise((r) => setTimeout(r, wait))
const stats = await page.evaluate(() => window.__stats || null)
const cam = await page.evaluate(() => window.__world ? { p: window.__world.camera.position.toArray().map(v=>+v.toFixed(1)), t: window.__world.controls.target.toArray().map(v=>+v.toFixed(1)), d: +window.__world.camera.position.distanceTo(window.__world.controls.target).toFixed(1) } : null)
console.log('cam', cam)
console.log('stats', stats)
await page.screenshot({ path: out })
console.log('saved', out)
await browser.close()
