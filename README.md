# Monitor Lumen

Revisa cada 5 minutos, las 24 horas, que las páginas de Lumen estén funcionando. Si alguna se cae, avisa al celular.

- **Panel:** `https://<usuario>.github.io/monitor-lumen/`
- **Sitios a revisar:** `sites.json`
- **Corre en:** GitHub Actions (`.github/workflows/monitor.yml`), gratis.

## Qué cuenta como "caído"

Se revisa dos veces seguidas (con 20 s de diferencia) para evitar falsas alarmas. Avisa si:

- la página no responde en 15 s o el dominio no existe / falla el certificado,
- responde con error (404, 500, etc.),
- carga pero no aparece el texto de `keyword` (opcional; sirve para detectar páginas en blanco o "Deployment not found").

Avisos: uno cuando se cae, uno cada hora mientras siga caída, uno cuando vuelve, y un resumen diario a las 9 h para saber que el monitor sigue vivo.

## Agregar o quitar sitios

Editar `sites.json` (desde el botón del panel o desde GitHub):

```json
{ "name": "Candela Chandía", "url": "https://candelachandia.com.ar/", "keyword": "Candela" }
```

`"enabled": false` pausa un sitio sin borrarlo. Al guardar, el monitor corre solo.

## Canales de aviso (secrets del repositorio)

Se cargan en Settings → Secrets and variables → Actions, o con `gh secret set NOMBRE`. Se usan todos los que estén cargados.

| Canal | Secrets |
|---|---|
| WhatsApp (CallMeBot) | `WHATSAPP_PHONE` (ej. `+5491112345678`), `WHATSAPP_APIKEY` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| ntfy (app de notificaciones) | `NTFY_TOPIC` |

**WhatsApp:** agendar el número de CallMeBot que figura en callmebot.com/blog/free-api-whatsapp-messages, mandarle por WhatsApp `I allow callmebot to send me messages` y guardar la API key que responde.

**ntfy:** instalar la app ntfy (Android/iPhone), suscribirse a un tema con nombre difícil de adivinar y cargar ese nombre en `NTFY_TOPIC`.

Probar: Actions → Monitor de sitios → Run workflow → tildar "Mandar un mensaje de prueba".

## Notas

- GitHub puede demorar algunos minutos los chequeos programados en horas pico.
- El estado se guarda en la rama `data` (no tocarla a mano).
