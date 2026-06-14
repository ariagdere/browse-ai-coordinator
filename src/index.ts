import express, { Request, Response } from 'express'

const app = express()
app.use(express.json())

// — Tüm secretlar Railway environment variables'dan gelir —
const ROBOT_1_ID      = process.env.ROBOT_1_ID!
const ROBOT_2_ID      = process.env.ROBOT_2_ID!
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL!
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET!   // Browse AI header'ında gönderilecek
const SESSION_TTL_MS  = 60 * 60 * 1000               // 1 saat — scheduler sıklığına göre ayarla
const PORT            = process.env.PORT || 3000

// Startup kontrolü — eksik env varsa hemen crash et, sessizce hata vermesin
const REQUIRED_ENV = ['ROBOT_1_ID', 'ROBOT_2_ID', 'MAKE_WEBHOOK_URL', 'WEBHOOK_SECRET']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing environment variable: ${key}`)
    process.exit(1)
  }
}

interface Session {
  taskId: string
  data: unknown
  at: number
}

const sessions = new Map<string, Session>()

// Eski oturumları temizle
function cleanStaleSessions(): void {
  const now = Date.now()
  for (const [id, session] of sessions.entries()) {
    if (now - session.at > SESSION_TTL_MS) {
      console.log(`[CLEANUP] Stale session removed: ${id}`)
      sessions.delete(id)
    }
  }
}

// Browse AI'dan gelen webhook
app.post('/webhook', async (req: Request, res: Response) => {
  // Secret kontrolü
  const incomingSecret = req.headers['x-webhook-secret']
  if (incomingSecret !== WEBHOOK_SECRET) {
    console.warn('[AUTH] Invalid webhook secret')
    return res.status(401).json({ ok: false, reason: 'unauthorized' })
  }

  const { robotId, taskId, status, capturedDataItems } = req.body

  if (!robotId || !taskId) {
    return res.status(400).json({ ok: false, reason: 'missing robotId or taskId' })
  }

  if (status !== 'successful') {
    console.log(`[SKIP] Robot ${robotId} status: ${status}`)
    return res.json({ ok: false, reason: 'not successful' })
  }

  cleanStaleSessions()

  // Bu robotu kaydet
  sessions.set(robotId, { taskId, data: capturedDataItems, at: Date.now() })
  console.log(`[SESSION] Robot ${robotId} done. Sessions: ${[...sessions.keys()].join(', ')}`)

  // Her ikisi de tamamlandı mı?
  if (!sessions.has(ROBOT_1_ID) || !sessions.has(ROBOT_2_ID)) {
    return res.json({ ok: true, waiting: true })
  }

  // İkisi de tamam — Make'e gönder
  const payload = {
    robot1: { robotId: ROBOT_1_ID, taskId: sessions.get(ROBOT_1_ID)!.taskId },
    robot2: { robotId: ROBOT_2_ID, taskId: sessions.get(ROBOT_2_ID)!.taskId },
    completedAt: new Date().toISOString(),
  }

  // Önce temizle — Make isteği başarısız olsa bile tekrar tetiklenmesin
  sessions.delete(ROBOT_1_ID)
  sessions.delete(ROBOT_2_ID)

  try {
    const makeRes = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    console.log(`[MAKE] Triggered. Status: ${makeRes.status}`)
    return res.json({ ok: true, triggered: true })
  } catch (err) {
    console.error('[MAKE] Failed to trigger:', err)
    return res.status(500).json({ ok: false, reason: 'make trigger failed' })
  }
})

// Health check — Railway uptime kontrolü için
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    sessions: [...sessions.keys()],
    uptime: process.uptime(),
  })
})

app.listen(PORT, () => {
  console.log(`[START] Browse AI Coordinator running on port ${PORT}`)
})
