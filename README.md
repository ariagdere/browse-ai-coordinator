# Browse AI Coordinator

Browse AI'dan gelen iki robot webhook'unu bekler, ikisi de tamamlanınca Make'e tek bir payload gönderir.

## Kurulum

```bash
npm install
cp .env.example .env
# .env içindeki değerleri doldur
```

## Geliştirme

```bash
npm run dev
```

## Production (Railway)

Railway environment variables'a şunları ekle:

| Key | Açıklama |
|-----|----------|
| `ROBOT_1_ID` | Browse AI Robot 1 ID |
| `ROBOT_2_ID` | Browse AI Robot 2 ID |
| `MAKE_WEBHOOK_URL` | Make senaryosunun webhook URL'i |
| `WEBHOOK_SECRET` | Browse AI webhook header'ında gönderilecek secret |

Railway `PORT`'u otomatik atar, `.env`'e ekleme.

## Browse AI Ayarı

Her iki robotta: **Settings → Notifications → Webhook**

- URL: `https://your-service.railway.app/webhook`
- Header ekle: `x-webhook-secret: <WEBHOOK_SECRET değerin>`

## Endpoints

- `POST /webhook` — Browse AI'dan gelen bildirimler
- `GET /health` — Servis durumu ve aktif session'lar
