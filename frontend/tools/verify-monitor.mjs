import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const html = resolve('dist/index.html')
assert(existsSync(html), '请先执行 npm run build')
const browserPath = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find(path => path && existsSync(path))
assert(browserPath, '请通过 BROWSER_PATH 指定 Chromium 或 Edge')
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  const network = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url())) network.push(request.url())
  })
  await page.setOfflineMode(true)
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(pathToFileURL(html).href)
  await page.waitForSelector('.trend-chart canvas')
  assert.match(await page.title(), /油田作业监控/)

  const read = selector => page.$eval(selector, element => element.textContent.trim())
  const seek = minute => page.$eval('input[type=range]', (input, value) => {
    input.value = String(value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, minute)

  assert.match(await read('.process .chip'), /参数观察/)
  assert.match(await read('.event-list'), /流量信号短时波动.*未恢复/s)
  await seek(20)
  assert.match(await read('.event-list'), /流量信号短时波动.*已恢复/s)
  assert.match(await read('.alarm-summary .kpi-value'), /^0\s*条$/)
  await page.click('.steps li:nth-child(4) button')
  assert.equal(await read('.clock strong'), '09:22')
  assert.match(await read('.process .chip'), /稳定运行/)
  await seek(28)
  assert.match(await read('.kpi.selected .kpi-value'), /无采样/)
  assert.match(await read('.event-list'), /压力测点数据中断.*未恢复/s)
  await page.click('.events .segmented button:last-child')
  assert.equal(await page.$$('.event-list li').then(items => items.length), 2)
  await page.click('.trend .segmented button:nth-child(2)')
  assert.match(await read('.trend .section-heading p'), /FT-203/)
  await seek(38)
  await page.select('.transport select', '4')
  await page.click('.play')
  await page.waitForFunction(() => document.querySelector('.clock strong')?.textContent === '09:40')
  assert.match(await read('.play'), /重新播放/)
  await page.click('.neutral')
  assert.equal(await read('.clock strong'), '09:00')
  assert.match(await read('.empty'), /没有告警/)

  await page.setViewport({ width: 390, height: 844 })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '窄屏出现横向溢出')
  assert.deepEqual(errors, [])
  assert.deepEqual(network, [])
  console.log('PASS  离线加载、工序跳转、告警恢复、测点缺采、趋势切换、倍速结束、窄屏布局')
} finally {
  await browser.close()
}
