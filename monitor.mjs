// Monitor Lumen — revisa los sitios de sites.json y avisa al celular si alguno se cae.
// Uso: node monitor.mjs [--test]   (--test manda un mensaje de prueba por todos los canales)
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const DATA_DIR = process.env.DATA_DIR || 'data';
const STATUS_FILE = `${DATA_DIR}/status.json`;
const HISTORY_FILE = `${DATA_DIR}/history.json`;
const HISTORY_MAX = 2016; // 7 días de chequeos cada 5 minutos

const config = JSON.parse(await readFile('sites.json', 'utf8'));
const S = {
  timeoutMs: 15000,
  retryDelayMs: 20000,
  realertMinutes: 60,
  slowMs: 8000,
  dailySummaryHour: 9,
  timezone: 'America/Argentina/Buenos_Aires',
  ...(config.settings || {}),
};
const sites = (config.sites || []).filter((s) => s && s.url && s.enabled !== false);

const readJson = async (f, fallback) => {
  try { return JSON.parse(await readFile(f, 'utf8')); } catch { return fallback; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const localTime = (d = new Date()) =>
  d.toLocaleString('es-AR', { timeZone: S.timezone, dateStyle: 'short', timeStyle: 'short' });

// ---------- Avisos ----------
const channels = [];
if (process.env.WHATSAPP_PHONE && process.env.WHATSAPP_APIKEY) {
  channels.push(['WhatsApp', async (text) => {
    const u = new URL('https://api.callmebot.com/whatsapp.php');
    u.searchParams.set('phone', process.env.WHATSAPP_PHONE);
    u.searchParams.set('text', text);
    u.searchParams.set('apikey', process.env.WHATSAPP_APIKEY);
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }]);
}
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  channels.push(['Telegram', async (text) => {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }]);
}
if (process.env.NTFY_TOPIC) {
  channels.push(['ntfy', async (text, urgent) => {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC)}`, {
      method: 'POST',
      headers: { Title: 'Monitor Lumen', Priority: urgent ? 'urgent' : 'default', Tags: urgent ? 'rotating_light' : 'white_check_mark' },
      body: text.replace(/\*/g, ''),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }]);
}

async function notify(text, urgent = true) {
  if (!channels.length) {
    console.warn('⚠️  No hay ningún canal de aviso configurado (faltan los secrets). Mensaje:\n' + text);
    return;
  }
  for (const [name, send] of channels) {
    try { await send(text, urgent); console.log(`Aviso enviado por ${name}`); }
    catch (e) { console.error(`No se pudo avisar por ${name}: ${e.message}`); }
  }
}

if (process.argv.includes('--test')) {
  await notify(`✅ *Monitor Lumen*: mensaje de prueba.\nSi te llegó esto, los avisos funcionan. (${localTime()})`, false);
  process.exit(0);
}

// ---------- Chequeo ----------
async function checkOnce(site) {
  const t0 = Date.now();
  try {
    const res = await fetch(site.url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MonitorLumen/1.0)', accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(S.timeoutMs),
    });
    const body = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { up: false, code: res.status, ms, error: `Responde con error ${res.status}` };
    if (site.keyword && !body.toLowerCase().includes(String(site.keyword).toLowerCase())) {
      return { up: false, code: res.status, ms, error: `Carga, pero no aparece el texto "${site.keyword}"` };
    }
    return { up: true, code: res.status, ms, error: null };
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e.name === 'TimeoutError' ? `No respondió en ${S.timeoutMs / 1000} s`
      : (e.cause?.code ? `Error de conexión (${e.cause.code})` : `Error: ${e.message}`);
    return { up: false, code: null, ms, error: msg };
  }
}

async function check(site) {
  let r = await checkOnce(site);
  if (!r.up) { // reintento para evitar falsas alarmas por un corte de un segundo
    await sleep(S.retryDelayMs);
    r = await checkOnce(site);
  }
  return r;
}

await mkdir(DATA_DIR, { recursive: true });
const status = await readJson(STATUS_FILE, { sites: {} });
const history = await readJson(HISTORY_FILE, {});
const results = await Promise.all(sites.map(async (s) => [s, await check(s)]));
const now = nowIso();
const newSites = {};

for (const [site, r] of results) {
  const prev = status.sites?.[site.url];
  const label = site.name || site.url;
  const entry = {
    name: label,
    url: site.url,
    up: r.up,
    code: r.code,
    ms: r.ms,
    error: r.error,
    slow: r.up && r.ms > S.slowMs,
    lastCheck: now,
    since: prev && prev.up === r.up ? prev.since : now,
    lastAlert: prev?.lastAlert || null,
  };

  if (!r.up) {
    const wasUp = !prev || prev.up;
    const minsSinceAlert = entry.lastAlert ? (Date.now() - Date.parse(entry.lastAlert)) / 60000 : Infinity;
    if (wasUp || minsSinceAlert >= S.realertMinutes) {
      const caidaHace = wasUp ? '' : `\nSigue caída desde ${localTime(new Date(entry.since))}.`;
      await notify(`🔴 *SITIO CAÍDO*: ${label}\n${site.url}\nMotivo: ${r.error}${caidaHace}\n(${localTime()})`, true);
      entry.lastAlert = now;
    }
  } else if (prev && !prev.up) {
    const mins = Math.round((Date.now() - Date.parse(prev.since)) / 60000);
    await notify(`🟢 *VOLVIÓ*: ${label} funciona de nuevo.\nEstuvo caída unos ${mins} min.\n(${localTime()})`, false);
    entry.lastAlert = null;
  }

  newSites[site.url] = entry;
  const h = history[site.url] || [];
  h.push([Date.parse(now), r.up ? 1 : 0, r.ms]);
  history[site.url] = h.slice(-HISTORY_MAX);
  console.log(`${r.up ? '🟢' : '🔴'} ${label} — ${r.up ? `${r.code} en ${r.ms} ms` : r.error}`);
}

// Quitar del historial los sitios que ya no están en la lista
for (const url of Object.keys(history)) if (!newSites[url]) delete history[url];

// Resumen diario para saber que el monitor sigue vivo
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: S.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date()).map((p) => [p.type, p.value]));
const today = `${parts.year}-${parts.month}-${parts.day}`;
let lastSummaryDate = status.lastSummaryDate || null;
if (S.dailySummaryHour !== null && Number(parts.hour) >= S.dailySummaryHour && lastSummaryDate !== today) {
  const list = Object.values(newSites);
  const down = list.filter((s) => !s.up);
  const lines = list.map((s) => `${s.up ? '🟢' : '🔴'} ${s.name}`).join('\n');
  await notify(
    `📋 *Monitor Lumen — resumen diario*\n${down.length ? `${down.length} sitio(s) con problemas` : `Los ${list.length} sitios funcionan bien`}.\n${lines}`,
    down.length > 0,
  );
  lastSummaryDate = today;
}

// Una vez por día: ver si CallMeBot volvió a aceptar registros de WhatsApp (hasta avisar una vez)
let callmebot = status.callmebot || { checkedDate: null, notified: false };
if (!callmebot.notified && !process.env.WHATSAPP_APIKEY && callmebot.checkedDate !== today) {
  try {
    const r = await fetch('https://www.callmebot.com/blog/free-api-whatsapp-messages/', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MonitorLumen/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    const html = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    const realPage = r.ok && /I allow callmebot to send me messages/i.test(html);
    if (realPage && !/currently full/i.test(html)) {
      const num = html.match(/\+34[\s\d]{9,14}\d/)?.[0]?.replace(/\s+/g, ' ').trim();
      await notify(
        `📲 *CallMeBot volvió a aceptar registros de WhatsApp*${num ? `\nNúmero del bot: ${num}` : ''}\n` +
        'Agendalo y mandale por WhatsApp: I allow callmebot to send me messages\n' +
        'Después pasale la API key que te responde a Claude para activar los avisos por WhatsApp.\n' +
        'https://www.callmebot.com/blog/free-api-whatsapp-messages/', false);
      callmebot.notified = true;
      console.log('CallMeBot: hay cupo, aviso enviado');
    } else {
      console.log(`CallMeBot: ${realPage ? 'sigue lleno' : 'no se pudo leer la página (HTTP ' + r.status + ')'}`);
    }
    if (realPage) callmebot.checkedDate = today;
  } catch (e) {
    console.log(`CallMeBot: no se pudo revisar (${e.message})`);
  }
}

await writeFile(STATUS_FILE, JSON.stringify({ updatedAt: now, lastSummaryDate, callmebot, sites: newSites }, null, 2));
await writeFile(HISTORY_FILE, JSON.stringify(history));
