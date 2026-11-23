// Webhook de Telegram: responde consultas sobre las webs del Monitor Lumen.
// Solo contesta al chat de TELEGRAM_CHAT_ID; ignora a cualquier otro.
import { loadData, replyEstado, replyCaidos, replyWeb, replyCaidas, findSites, AYUDA, PANEL } from '../lib/monitor.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER = String(process.env.TELEGRAM_CHAT_ID || '');
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

async function send(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) console.error('sendMessage falló', r.status, await r.text());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Bot del Monitor Lumen activo');
  if (!SECRET || req.headers['x-telegram-bot-api-secret-token'] !== SECRET) return res.status(401).send('no');

  const msg = req.body?.message || req.body?.edited_message;
  const chatId = msg?.chat?.id;
  const text = (msg?.text || '').trim();
  if (!chatId || !text) return res.status(200).send('ok');

  if (String(chatId) !== OWNER) {
    // Bot privado: a otros solo les dice eso
    await send(chatId, 'Este bot es privado.');
    return res.status(200).send('ok');
  }

  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '');
  const arg = rest.join(' ');

  try {
    if (cmd === '/start' || cmd === '/ayuda' || cmd === '/help') return await done(res, send(chatId, AYUDA));
    if (cmd === '/panel') return await done(res, send(chatId, `📊 Panel: ${PANEL}`));

    const data = await loadData();
    let reply;
    if (cmd === '/estado') reply = replyEstado(data);
    else if (cmd === '/caidos') reply = replyCaidos(data);
    else if (cmd === '/caidas' || cmd === '/historial') reply = replyCaidas(data);
    else if (cmd === '/web') reply = replyWeb(data, arg);
    else if (!text.startsWith('/') && findSites(data.status, text).length) reply = replyWeb(data, text);
    else reply = `No entendí "${text.slice(0, 40)}".\n\n${AYUDA}`;
    await send(chatId, reply);
  } catch (e) {
    console.error(e);
    await send(chatId, `⚠️ No pude leer los datos del monitor: ${e.message}`);
  }
  return res.status(200).send('ok');
}

async function done(res, p) { await p; return res.status(200).send('ok'); }
