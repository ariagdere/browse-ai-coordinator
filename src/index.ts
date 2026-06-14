import express from 'express'

const app = express()
app.use(express.json())

const ROBOT_1_ID = process.env.ROBOT_1_ID!
const ROBOT_2_ID = process.env.ROBOT_2_ID!
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL!
const PORT = process.env.PORT || 3000

const sessions = new Map<string, { taskId: string; data: any; at: number }>()

app.post('/webhook', async (req, res) => {
  const { robotId, taskId, status, capturedDataItems } = req.body

  if (status !== 'successful') {
    return res.json({ ok: false, reason: 'not successful' })
  }

  // 30 dk geçmiş kayıtları temizle
  const now = Date.now()
  for (const [id, s] of sessions.entries()) {
    if (now - s.at > 30 * 60 * 1000) sessions.delete(id)
  }

  sessions.set(robotId, { taskId, data: capturedDataItems, at: now })

  if (!sessions.has(ROBOT_1_ID) || !sessions.has(ROBOT_2_ID)) {
    return res.json({ ok: true, waiting: true })
  }

  const payload = {
    robot1: sessions.get(ROBOT_1_ID),
    robot2: sessions.get(ROBOT_2_ID),
  }

  sessions.delete(ROBOT_1_ID)
  sessions.delete(ROBOT_2_ID)

  await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  return res.json({ ok: true, triggered: true })
})

app.get('/health', (_, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`Coordinator running on ${PORT}`))
