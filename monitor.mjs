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
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    // CallMeBot responde 200 aunque rechace el mensaje: hay que leer el texto
    const answer = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!r.ok || !/queued|sent/i.test(answer) || /invalid|error|not (yet )?activ|blocked|paused/i.test(answer)) {
      throw new Error(`HTTP ${r.status}: ${answer.slice(0, 200)}`);
    }
    console.log('CallMeBot: mensaje aceptado y en cola');
  }]);
}
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  channels.push(['Telegram', async (text) => {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text.replace(/\*/g, ''), disable_web_page_preview: true }),
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
// Traduce un error de red a: qué pasa (en criollo), posible solución y código técnico
const isVercel = (url) => /\.vercel\.app$/i.test(new URL(url).hostname);
function diagnoseNetwork(e, url) {
  const code = e.cause?.code || e.code || '';
  const msg = String(e.cause?.message || e.message || '');
  const host = new URL(url).hostname;
  const dominio = isVercel(url)
    ? 'El proyecto de Vercel pudo haber sido borrado o renombrado: revisá en Vercel que exista y que tenga ese dominio.'
    : `Revisá en NIC.ar que el dominio ${host} no esté vencido y que siga delegado a ns1/ns2.vercel-dns.com; después revisá el dominio en Vercel.`;
  if (e.name === 'TimeoutError' || /timeout/i.test(code)) return {
    cause: `No respondió en ${S.timeoutMs / 1000} segundos`,
    fix: 'El servidor está caído o muy lento. Si es Vercel, revisá vercel-status.com y el último deploy; si la página es muy pesada, optimizar imágenes y videos.',
    tech: code || 'Timeout',
  };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return {
    cause: 'El dominio no existe o no apunta a ningún servidor (falla de DNS)',
    fix: dominio, tech: `${code} (DNS) para ${host}`,
  };
  if (/CERT|SSL|TLS|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY/i.test(code + msg)) return {
    cause: /EXPIRED/i.test(code + msg) ? 'El certificado de seguridad (HTTPS) está vencido'
      : 'El certificado de seguridad (HTTPS) es inválido o no corresponde a este dominio',
    fix: 'En Vercel → proyecto → Settings → Domains, revisá que el dominio figure como "Valid Configuration"; si no, verificá los DNS y volvé a agregar el dominio para que regenere el certificado.',
    tech: code || msg,
  };
  if (/redirect count|redirect/i.test(msg)) return {
    cause: 'La página entra en un bucle de redirecciones (redirige a sí misma sin parar)',
    fix: 'Revisar las redirecciones de dominio en Vercel (con y sin www) y los redirects de vercel.json.',
    tech: msg,
  };
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') return {
    cause: 'El servidor rechazó o cortó la conexión',
    fix: 'El dominio apunta a un servidor que no atiende. Revisá los DNS del dominio (tienen que apuntar a Vercel) y el estado del proyecto.',
    tech: code,
  };
  return { cause: 'Error de conexión', fix: 'Revisar el dominio y el último deploy en Vercel.', tech: code || msg };
}

// Explica un error HTTP; usa el encabezado x-vercel-error cuando viene
function diagnoseHttp(res, url) {
  const st = res.status;
  const ve = res.headers.get('x-vercel-error') || '';
  const V = {
    DEPLOYMENT_NOT_FOUND: ['El deploy de Vercel no existe (fue borrado o el dominio quedó apuntando a uno viejo)', 'Volver a publicar el proyecto (vercel deploy --prod o un push a main) y revisar que el dominio esté asignado al deploy de producción.'],
    NOT_FOUND: ['Vercel no encuentra la página (404)', 'Revisar que el archivo exista en el deploy (index.html en la raíz correcta) y la carpeta raíz configurada en Vercel.'],
    DEPLOYMENT_DISABLED: ['El deploy está deshabilitado en Vercel', 'Revisar en Vercel si el proyecto fue pausado o si hay un problema con la cuenta o el plan.'],
    DEPLOYMENT_PAUSED: ['El proyecto está pausado en Vercel', 'Reanudar el proyecto desde el panel de Vercel.'],
    DEPLOYMENT_BLOCKED: ['Vercel bloqueó el deploy', 'Revisar avisos en el panel de Vercel (cuenta, plan o contenido).'],
    DNS_HOSTNAME_NOT_FOUND: ['El dominio no está configurado en Vercel', 'Agregar el dominio en Vercel → Settings → Domains.'],
    FUNCTION_INVOCATION_FAILED: ['Falla el código del servidor (función de Vercel)', 'Revisar los logs de la función en Vercel.'],
    FUNCTION_INVOCATION_TIMEOUT: ['La función del servidor tarda demasiado', 'Revisar los logs de la función en Vercel.'],
  }[ve];
  if (V) return { cause: V[0], fix: V[1], tech: `HTTP ${st} · x-vercel-error: ${ve}` };
  const tech = `HTTP ${st}${ve ? ` · x-vercel-error: ${ve}` : ''}`;
  if (st === 401 || st === 403) return {
    cause: `La página pide permiso o está bloqueada (error ${st})`,
    fix: isVercel(url) ? 'Seguramente quedó activada la "Deployment Protection" de Vercel: desactivala en Settings → Deployment Protection para producción.' : 'Revisar si hay protección por contraseña o un firewall bloqueando visitas.',
    tech,
  };
  if (st === 404) return { cause: 'La página no existe (error 404)', fix: 'Revisar que el link sea correcto y que el último deploy tenga el index.html en la raíz.', tech };
  if (st === 402) return { cause: 'Problema de pago o de plan en el hosting (error 402)', fix: 'Revisar la facturación y los límites del plan en Vercel.', tech };
  if (st === 429) return { cause: 'El servidor está limitando las visitas (error 429)', fix: 'Puede ser un límite de uso o protección anti-bots; revisar el firewall y el uso en Vercel.', tech };
  if (st >= 500) return { cause: `Error interno del servidor (error ${st})`, fix: 'Suele ser una falla de Vercel o del código del servidor. Revisar vercel-status.com y los logs del último deploy.', tech };
  return { cause: `Responde con error ${st}`, fix: 'Revisar el último deploy en Vercel.', tech };
}

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
    const title = (body.match(/<title[^>]*>([^<]*)/i)?.[1] || '').trim().slice(0, 120);
    const info = {
      finalUrl: res.url !== site.url ? res.url : undefined,
      server: res.headers.get('server') || undefined,
      vercelId: res.headers.get('x-vercel-id') || undefined,
      title: title || undefined,
      bytes: body.length,
    };
    if (!res.ok) {
      const d = diagnoseHttp(res, site.url);
      return { up: false, code: res.status, ms, error: d.cause, diag: { ...d, ...info } };
    }
    if (site.keyword && !body.toLowerCase().includes(String(site.keyword).toLowerCase())) {
      const blank = body.replace(/<[^>]+>/g, '').trim().length < 200;
      const d = {
        cause: blank ? 'La página carga pero está vacía o en blanco'
          : `La página carga, pero no aparece el texto de control "${site.keyword}" (puede ser otra página o contenido roto)`,
        fix: 'Revisar el último deploy: puede haberse publicado una versión rota, otro proyecto en este dominio o una página de error del hosting.',
        tech: `HTTP ${res.status} · falta "${site.keyword}"`,
      };
      return { up: false, code: res.status, ms, error: d.cause, diag: { ...d, ...info } };
    }
    return { up: true, code: res.status, ms, error: null, diag: null };
  } catch (e) {
    const ms = Date.now() - t0;
    const d = diagnoseNetwork(e, site.url);
    return { up: false, code: null, ms, error: d.cause, diag: d };
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
const INCIDENTS_MAX = 50; // historial de caídas con su motivo
const incidents = Array.isArray(status.incidents) ? status.incidents : [];
const openIncident = (url) => incidents.find((i) => i.url === url && !i.end);

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
    diag: r.diag || null,
    slow: r.up && r.ms > S.slowMs,
    lastCheck: now,
    since: prev && prev.up === r.up ? prev.since : now,
    lastAlert: prev?.lastAlert || null,
  };

  if (!r.up) {
    const wasUp = !prev || prev.up;
    const d = r.diag || { cause: r.error };
    // Registrar (o actualizar) la caída en el historial
    let inc = openIncident(site.url);
    if (!inc) {
      inc = { name: label, url: site.url, start: now, end: null };
      incidents.push(inc);
    }
    Object.assign(inc, { name: label, cause: d.cause, fix: d.fix, tech: d.tech, lastSeen: now });

    const minsSinceAlert = entry.lastAlert ? (Date.now() - Date.parse(entry.lastAlert)) / 60000 : Infinity;
    if (wasUp || minsSinceAlert >= S.realertMinutes) {
      const caidaHace = wasUp ? '' : `\nSigue caída desde ${localTime(new Date(entry.since))}.`;
      await notify(
        `🔴 *SITIO CAÍDO*: ${label}\n${site.url}\n` +
        `Qué pasa: ${d.cause}\n` +
        (d.fix ? `Posible solución: ${d.fix}\n` : '') +
        (d.tech ? `Detalle técnico: ${d.tech}\n` : '') +
        `${caidaHace ? caidaHace.trim() + '\n' : ''}(${localTime()})`, true);
      entry.lastAlert = now;
    }
  } else if (prev && !prev.up) {
    const mins = Math.round((Date.now() - Date.parse(prev.since)) / 60000);
    const inc = openIncident(site.url);
    if (inc) { inc.end = now; inc.minutes = mins; }
    await notify(`🟢 *VOLVIÓ*: ${label} funciona de nuevo.\nEstuvo caída unos ${mins} min${inc?.cause ? ` (${inc.cause})` : ''}.\n(${localTime()})`, false);
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
// Cerrar caídas abiertas de sitios que se sacaron de la lista
for (const i of incidents) if (!i.end && !newSites[i.url]) i.end = now;

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

// Cada 15 min: ver si CallMeBot tiene cupo para WhatsApp. Avisa (urgente) cada vez que pasa de lleno a abierto.
// Se apaga solo cuando ya están cargados los secrets de WhatsApp.
const CMB_EVERY_MIN = 15;
let callmebot = status.callmebot || {};
const cmbDue = !callmebot.lastCheck || (Date.now() - Date.parse(callmebot.lastCheck)) / 60000 >= CMB_EVERY_MIN - 1;
if (!process.env.WHATSAPP_APIKEY && cmbDue) {
  try {
    const r = await fetch('https://www.callmebot.com/blog/free-api-whatsapp-messages/', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MonitorLumen/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    const html = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    const realPage = r.ok && /I allow callmebot to send me messages/i.test(html);
    // El número del bot completo (no el de ejemplo +34 123 123 123)
    const num = (html.match(/\+34[\s\d]{9,14}\d/g) || [])
      .map((n) => n.replace(/\s+/g, ' ').trim())
      .find((n) => n.replace(/\D/g, '') !== '34123123123');
    const open = realPage && !/currently full/i.test(html) && !!num;
    if (realPage) {
      if (open && !callmebot.open) {
        await notify(
          `📲 *CallMeBot tiene cupo para WhatsApp AHORA*\nNúmero del bot: ${num}\n` +
          'Agendalo y mandale YA por WhatsApp: I allow callmebot to send me messages\n' +
          'Los cupos duran poco. Si te responde con la API key, avisale a Claude.', true);
        console.log('CallMeBot: hay cupo, aviso enviado');
      } else if (!open && callmebot.open) {
        console.log('CallMeBot: se volvió a llenar');
      } else {
        console.log(`CallMeBot: ${open ? 'sigue con cupo' : 'sigue lleno'}`);
      }
      callmebot = { ...callmebot, open, lastCheck: now, ...(open ? { lastOpen: now, number: num } : {}) };
    } else {
      console.log(`CallMeBot: no se pudo leer la página (HTTP ${r.status})`);
    }
  } catch (e) {
    console.log(`CallMeBot: no se pudo revisar (${e.message})`);
  }
}

await writeFile(STATUS_FILE, JSON.stringify({ updatedAt: now, lastSummaryDate, callmebot, sites: newSites, incidents: incidents.slice(-INCIDENTS_MAX) }, null, 2));
await writeFile(HISTORY_FILE, JSON.stringify(history));
