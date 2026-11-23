// Configuración inicial del bot (protegida con TELEGRAM_WEBHOOK_SECRET):
//   /api/setup?key=SECRET&step=chats    → muestra quién le escribió al bot (para saber tu chat id)
//   /api/setup?key=SECRET&step=webhook  → conecta Telegram con este servidor y carga el menú de comandos
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const tg = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return r.json();
};

export default async function handler(req, res) {
  if (!SECRET || req.query.key !== SECRET) return res.status(401).json({ error: 'no autorizado' });
  if (!TOKEN) return res.status(500).json({ error: 'falta TELEGRAM_BOT_TOKEN' });
  const me = await tg('getMe');
  if (!me.ok) return res.status(500).json({ error: 'el token no es válido', detalle: me.description });

  if (req.query.step === 'chats') {
    await tg('deleteWebhook'); // getUpdates no funciona con el webhook puesto
    const up = await tg('getUpdates');
    const chats = {};
    for (const u of up.result || []) {
      const c = (u.message || u.edited_message)?.chat;
      if (c) chats[c.id] = { id: c.id, nombre: [c.first_name, c.last_name].filter(Boolean).join(' '), usuario: c.username };
    }
    return res.json({ bot: me.result.username, chats: Object.values(chats) });
  }

  if (req.query.step === 'webhook') {
    const url = `https://${req.headers.host}/api/telegram`;
    const hook = await tg('setWebhook', { url, secret_token: SECRET, allowed_updates: ['message', 'edited_message'], drop_pending_updates: true });
    const cmds = await tg('setMyCommands', {
      commands: [
        { command: 'estado', description: 'Todas las webs de un vistazo' },
        { command: 'caidos', description: 'Solo las webs caídas, con el motivo' },
        { command: 'web', description: 'Detalle de una web (ej: /web candela)' },
        { command: 'caidas', description: 'Historial de caídas' },
        { command: 'panel', description: 'Link al panel' },
        { command: 'ayuda', description: 'Qué puedo hacer' },
      ],
    });
    return res.json({ bot: me.result.username, webhook: hook.ok ? url : hook.description, comandos: cmds.ok });
  }
  return res.json({ bot: me.result.username, pasos: ['step=chats', 'step=webhook'] });
}
