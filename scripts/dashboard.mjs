import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const host = process.env.LOCAL_CODER_DASHBOARD_HOST ?? '127.0.0.1';
const port = Number(process.env.LOCAL_CODER_DASHBOARD_PORT ?? '7447');
const claudeConfigPath = process.env.LOCAL_CODER_CLAUDE_CONFIG_PATH ?? path.join(os.homedir(), '.claude.json');
const telemetryPath = process.env.LOCAL_CODER_TELEMETRY_PATH ?? path.join(os.homedir(), '.local-coder-mcp', 'telemetry.jsonl');

async function loadConnection() {
  const config = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8'));
  const env = config?.mcpServers?.['local-coder']?.env ?? {};
  const workerUrl = env.LOCAL_CODER_REMOTE_WORKER_URL;
  const token = env.LOCAL_CODER_REMOTE_WORKER_TOKEN;
  if (!workerUrl || !token) {
    throw new Error('local-coder is not configured in strict remote-worker mode in ~/.claude.json.');
  }
  return { workerUrl: String(workerUrl).replace(/\/$/, ''), token: String(token) };
}

async function recentTelemetry(limit = 20) {
  try {
    const raw = await fs.readFile(telemetryPath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-500)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      })
      .filter((event) => ['engineering', 'execution', 'orchestration'].includes(event.kind))
      .slice(-limit)
      .reverse();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function statusPayload() {
  const { workerUrl, token } = await loadConnection();
  const response = await fetch(`${workerUrl}/v1/status`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? `Worker returned HTTP ${response.status}`);
  return {
    ...body,
    controlPlane: {
      hostname: os.hostname(),
      platform: process.platform,
      dashboardPid: process.pid,
      workerUrl
    },
    recentTelemetry: await recentTelemetry()
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

const page = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Local Coder Control Plane</title>
<style>
:root{color-scheme:dark;--bg:#080b10;--panel:#101620;--panel2:#151d29;--line:#243044;--text:#edf4ff;--muted:#8fa0b7;--good:#4ade80;--warn:#fbbf24;--bad:#fb7185;--accent:#7dd3fc;--purple:#c4b5fd}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#122031 0,transparent 28%),var(--bg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI";color:var(--text)}
main{max-width:1440px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:22px}.eyebrow{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.15em;text-transform:uppercase}.title{font-size:30px;font-weight:800;margin:4px 0}.sub{color:var(--muted)}.pill{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--line);padding:8px 12px;border-radius:999px;background:#0d131c}.dot{width:9px;height:9px;border-radius:50%;background:var(--muted)}.dot.good{background:var(--good);box-shadow:0 0 14px #4ade8077}.dot.bad{background:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}.card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:16px;padding:17px;min-width:0}.span3{grid-column:span 3}.span4{grid-column:span 4}.span5{grid-column:span 5}.span7{grid-column:span 7}.span8{grid-column:span 8}.span12{grid-column:span 12}.label{color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.metric{font-size:25px;font-weight:800;margin-top:6px}.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.row{display:flex;align-items:center;justify-content:space-between;gap:14px}.bar{height:8px;border-radius:99px;background:#202b3d;overflow:hidden;margin-top:10px}.fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--purple));border-radius:99px}.jobs{display:grid;gap:10px;margin-top:12px}.job{padding:13px;border-radius:12px;border:1px solid var(--line);background:#0b1119}.jobtop{display:flex;justify-content:space-between;gap:12px}.kind{font-weight:800;text-transform:uppercase;letter-spacing:.08em}.running{color:var(--good)}.queued{color:var(--warn)}.empty{padding:24px 12px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:12px;margin-top:12px}.timeline{display:grid;gap:8px;margin-top:12px}.event{display:grid;grid-template-columns:150px 100px 1fr;gap:12px;padding:9px 0;border-bottom:1px solid #1e2939}.event:last-child{border-bottom:0}.status-success{color:var(--good)}.status-error,.status-escalated{color:var(--bad)}.status-needs-claude{color:var(--warn)}.error{border-color:#5b2430;background:#1b1014;color:#fecdd3;padding:14px;border-radius:12px;margin-bottom:15px;display:none}
@media(max-width:900px){main{padding:18px}.span3,.span4,.span5,.span7,.span8{grid-column:span 12}.event{grid-template-columns:1fr}.top{flex-direction:column}}
</style>
</head>
<body><main>
<div class="top"><div><div class="eyebrow">Local Coder</div><div class="title">AI Execution Control Plane</div><div class="sub">Mac control plane → Meshnet → Windows execution worker → Ollama / Qwen</div></div><div class="pill"><span id="dot" class="dot"></span><span id="headline">Connecting…</span></div></div>
<div id="error" class="error"></div>
<div class="grid">
<section class="card span3"><div class="label">Worker</div><div id="worker" class="metric">—</div><div id="workerSub" class="muted">—</div></section>
<section class="card span3"><div class="label">Model</div><div id="model" class="metric">—</div><div id="ollama" class="muted">—</div></section>
<section class="card span3"><div class="label">Active jobs</div><div id="activeCount" class="metric">—</div><div id="queueCount" class="muted">—</div></section>
<section class="card span3"><div class="label">Worker uptime</div><div id="uptime" class="metric">—</div><div id="version" class="muted">—</div></section>
<section class="card span7"><div class="row"><div><div class="label">Execution</div><div style="font-size:19px;font-weight:800;margin-top:4px">Current jobs</div></div><div class="muted mono" id="collected">—</div></div><div id="jobs" class="jobs"></div></section>
<section class="card span5"><div class="label">Windows machine</div><div class="row" style="margin-top:12px"><div><div class="muted">CPU</div><div id="cpu" class="metric">—</div></div><div class="muted" id="cpuModel"></div></div><div class="bar"><div id="cpuBar" class="fill" style="width:0%"></div></div><div class="row" style="margin-top:18px"><div><div class="muted">RAM</div><div id="ram" class="metric">—</div></div><div id="ramDetail" class="muted"></div></div><div class="bar"><div id="ramBar" class="fill" style="width:0%"></div></div><div style="margin-top:18px"><div class="muted">GPU</div><div id="gpu" style="font-size:18px;font-weight:800;margin-top:4px">—</div><div id="gpuDetail" class="muted"></div></div></section>
<section class="card span12"><div class="row"><div><div class="label">Recent activity</div><div style="font-size:19px;font-weight:800;margin-top:4px">Local engineering telemetry</div></div><div class="muted">Completed calls from the Mac control plane</div></div><div id="events" class="timeline"></div></section>
</div></main>
<script>
const $=id=>document.getElementById(id);const bytes=n=>{if(!Number.isFinite(n))return'—';const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i<2?0:1)+' '+u[i]};const duration=s=>{s=Math.max(0,Math.floor(s||0));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h?`${h}h ${m}m`:`${m}m ${x}s`};const ago=t=>{const s=Math.max(0,Math.floor((Date.now()-new Date(t).getTime())/1000));return s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ago`:`${Math.floor(s/3600)}h ago`};
function jobHtml(j,state){return `<div class="job"><div class="jobtop"><div><span class="kind ${state}">${j.kind}</span><div class="muted mono" style="margin-top:5px">scope ${j.isolationKey}</div></div><div style="text-align:right"><strong>${state==='running'?duration(j.runningMs/1000):duration(j.waitingMs/1000)}</strong><div class="muted">${state}</div></div></div></div>`}
function render(d){$('error').style.display='none';$('dot').className='dot good';$('headline').textContent='Worker online';$('worker').textContent=d.hostname||'—';$('workerSub').textContent=(d.platform||'—')+' · '+(d.controlPlane?.workerUrl||'');$('model').textContent=d.model||'—';$('ollama').textContent=d.ollama?.ok?'Ollama healthy · '+(d.ollama.numCtx||'—')+' ctx':'Ollama unavailable';const s=d.scheduler||{};$('activeCount').textContent=s.activeJobs??0;$('queueCount').textContent=(s.queuedJobs??0)+' queued';$('uptime').textContent=duration(d.machine?.uptimeSeconds);$('version').textContent='worker '+(d.workerVersion||'—');$('collected').textContent=d.collectedAt?new Date(d.collectedAt).toLocaleTimeString():'—';const jobs=[...(s.active||[]).map(j=>jobHtml(j,'running')),...(s.queued||[]).map(j=>jobHtml(j,'queued'))];$('jobs').innerHTML=jobs.join('')||'<div class="empty">Idle — no active or queued work.</div>';const cpu=d.machine?.cpu||{};const cp=cpu.usagePercent;$('cpu').textContent=cp==null?'sampling…':cp.toFixed(1)+'%';$('cpuBar').style.width=(cp||0)+'%';$('cpuModel').textContent=(cpu.logicalCores||'—')+' logical cores';const m=d.machine?.memory||{};$('ram').textContent=(m.usedPercent??0).toFixed(1)+'%';$('ramBar').style.width=(m.usedPercent||0)+'%';$('ramDetail').textContent=bytes(m.usedBytes)+' / '+bytes(m.totalBytes);const g=d.machine?.gpu;if(g){$('gpu').textContent=g.name;$('gpuDetail').textContent=`${g.utilizationPercent}% util · ${g.memoryUsedMiB}/${g.memoryTotalMiB} MiB VRAM · ${g.temperatureC}°C`}else{$('gpu').textContent='Not detected';$('gpuDetail').textContent='nvidia-smi unavailable'}const events=d.recentTelemetry||[];$('events').innerHTML=events.map(e=>`<div class="event"><div class="muted">${ago(e.timestamp)}</div><div class="kind">${e.kind}</div><div><span class="status-${e.status||''}">${e.status||'—'}</span> · ${e.model||'—'} · ${(e.promptTokens||0)+(e.completionTokens||0)} tokens${e.changedFiles!=null?' · '+e.changedFiles+' files':''}</div></div>`).join('')||'<div class="empty">No completed local engineering telemetry yet.</div>'}
async function tick(){try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Status request failed');render(d)}catch(e){$('dot').className='dot bad';$('headline').textContent='Worker unavailable';$('error').textContent=String(e.message||e);$('error').style.display='block'}}tick();setInterval(tick,1000);
</script></body></html>`;

const server = http.createServer((request, response) => {
  void (async () => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(page);
      return;
    }
    if (request.method === 'GET' && request.url === '/api/status') {
      try {
        sendJson(response, 200, await statusPayload());
      } catch (error) {
        sendJson(response, 503, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  })();
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`Local Coder dashboard: ${url}`);
  console.log('The dashboard binds to Mac loopback only; the worker bearer token is never sent to the browser.');
  if (process.platform === 'darwin' && !process.argv.includes('--no-open')) {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
});
