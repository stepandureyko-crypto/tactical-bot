# Tactical Map Discord access bot

Роль-синхронизация L1/L2/L3 в Firebase и команда `/code <запрос>` для входа в BratVa UI.

## Переменные окружения

| Переменная | Значение |
|---|---|
| `DISCORD_TOKEN` | токен бота |
| `GUILD_ID` | `1508179748616933537` |
| `ROLE_L1` / `ROLE_L2` / `ROLE_L3` | ID ролей доступа |
| `ROLE_COMMANDER` / `ROLE_CAPTAIN` | ID ролей CHIEF / LEADER |
| `ROLE_ADMIN` | (необязательно) ID админ-роли |
| `FIREBASE_DATABASE_URL` | Realtime Database URL |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | `/etc/secrets/serviceAccountKey.json` |
| `TACTICAL_API_URL` | `https://bratva-auth.stepand903.workers.dev` |
| `TACTICAL_BOT_SECRET` | общий секрет с backend |

## Запуск

```text
npm install
npm start
```
