// Lectura de los datos del Monitor Lumen y armado de respuestas para Telegram (HTML)
const REPO = 'ChrisGonzalez230994/monitor-lumen';
const RAW = `https://raw.githubusercontent.com/${REPO}/data`;
export const PANEL = 'https://chrisgonzalez230994.github.io/monitor-lumen/';
const TZ = 'America/Argentina/Buenos_Aires';

export async function loadData() {
  const bust = `?t=${Date.now()}`;
  const get = async (f) => {
    const r = await fetch(`${RAW}/${f}${bust}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`No se pudo leer ${f} (HTTP ${r.status})`);
    return r.json();
  };
  const [status, history] = await Promise.all([get('status.json'), get('history.json').catch(() => ({}))]);
  return { status, history };
}

export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmt = (iso) => new Date(iso).toLocaleString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `hace ${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `hace ${Math.floor(h / 24)} días`;
}
const uptime = (h, ms) => {
  const pts = ms ? h.filter((x) => x[0] > Date.now() - ms) : h;
  if (!pts.length) return '—';
  const p = (pts.reduce((a, x) => a + x[1], 0) / pts.length) * 100;
  return (p === 100 ? '100' : p.toFixed(2)) + '%';
};
const dot = (s) => (!s.up ? '🔴' : s.slow ? '🟡' : '🟢');
const sites = (status) => Object.values(status.sites || {}).sort((a, b) => (a.up - b.up) || a.name.localeCompare(b.name));

function staleNote(status) {
  const min = (Date.now() - Date.parse(status.updatedAt)) / 60000;
  return min > 30 ? `\n\n⚠️ Ojo: el monitor no corre hace ${Math.round(min)} min. Revisá cron-job.org y la pestaña Actions.` : '';
}

export function findSites(status, query) {
  const words = norm(query).split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  return sites(status).filter((s) => {
    const hay = norm(`${s.name} ${s.url}`);
    return words.every((w) => hay.includes(w));
  });
}

export function replyEstado({ status }) {
  const list = sites(status);
  const down = list.filter((s) => !s.up);
  const head = down.length
    ? `🔴 <b>${down.length} web${down.length > 1 ? 's' : ''} con problemas</b>`
    : `✅ <b>Las ${list.length} webs funcionan bien</b>`;
  const lines = list.map((s) => `${dot(s)} ${esc(s.name)} — ${s.up ? `${s.ms} ms` : esc(s.diag?.cause || s.error)}`);
  return `${head}\n\n${lines.join('\n')}\n\n<i>Última revisión ${ago(status.updatedAt)}</i>${staleNote(status)}`;
}

export function replyCaidos({ status }) {
  const down = sites(status).filter((s) => !s.up);
  if (!down.length) return `✅ Ninguna web caída ahora mismo.\n<i>Última revisión ${ago(status.updatedAt)}</i>${staleNote(status)}`;
  return down.map((s) => siteDetail(s, null, status)).join('\n\n———\n\n');
}

function siteDetail(s, history, status) {
  const d = s.diag || {};
  const h = history?.[s.url] || [];
  const L = [`${dot(s)} <b>${esc(s.name)}</b>`, esc(s.url)];
  if (s.up) {
    L.push(`Funciona${s.slow ? ' pero <b>lenta</b>' : ''} · responde en ${s.ms} ms`, `Arriba ${ago(s.since)}`);
  } else {
    L.push(`<b>Caída ${ago(s.since)}</b> (desde ${fmt(s.since)})`, '', `<b>Qué pasa:</b> ${esc(d.cause || s.error)}`);
    if (d.fix) L.push(`<b>Posible solución:</b> ${esc(d.fix)}`);
    if (d.tech) L.push(`<b>Detalle:</b> <code>${esc(d.tech)}</code>`);
  }
  if (history) L.push('', `Disponibilidad: 24 h ${uptime(h, 864e5)} · 7 días ${uptime(h)}`);
  const last = (status.incidents || []).filter((i) => i.url === s.url).at(-1);
  if (last && s.up) L.push(`Última caída: ${fmt(last.start)}${last.minutes != null ? ` (${last.minutes} min)` : ''} — ${esc(last.cause)}`);
  else if (!last && history) L.push('Sin caídas registradas.');
  return L.join('\n');
}

export function replyWeb({ status, history }, query) {
  if (!query.trim()) return 'Decime qué web. Por ejemplo: <code>/web candela</code>';
  const found = findSites(status, query);
  if (!found.length) {
    return `No encontré ninguna web con "${esc(query)}".\n\nLas que monitoreo:\n${sites(status).map((s) => `• ${esc(s.name)}`).join('\n')}`;
  }
  if (found.length > 3) return `Encontré ${found.length}: ${found.map((s) => esc(s.name)).join(', ')}.\nSé más específico.`;
  return found.map((s) => siteDetail(s, history, status)).join('\n\n———\n\n') + staleNote(status);
}

export function replyCaidas({ status }) {
  const inc = (status.incidents || []).slice(-10).reverse();
  if (!inc.length) return '✅ No hay caídas registradas todavía.';
  return '<b>Últimas caídas</b>\n\n' + inc.map((i) =>
    `${i.end ? '🟢' : '🔴'} <b>${esc(i.name)}</b> — ${fmt(i.start)}${i.end ? ` · duró ${i.minutes ?? Math.round((Date.parse(i.end) - Date.parse(i.start)) / 60000)} min` : ' · <b>sigue caída</b>'}\n${esc(i.cause || '')}`,
  ).join('\n\n');
}

export const AYUDA = [
  '🤖 <b>Bot del Monitor Lumen</b>',
  '',
  '/estado — todas las webs, de un vistazo',
  '/caidos — solo las que están caídas, con el motivo',
  '/web <i>nombre</i> — detalle de una web (ej: <code>/web candela</code>)',
  '/caidas — historial de las últimas caídas',
  '/panel — link al panel',
  '',
  'También podés escribir directamente el nombre de una web, por ejemplo <i>stele</i> o <i>litz</i>.',
].join('\n');
