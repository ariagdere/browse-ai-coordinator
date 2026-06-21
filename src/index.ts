import express, { Request, Response } from 'express'

const app = express()
app.use(express.json({ limit: '20mb' }))

const ROBOT_1_ID       = process.env.ROBOT_1_ID!
const ROBOT_2_ID       = process.env.ROBOT_2_ID!
const APIFY_ACT_ID     = process.env.APIFY_ACT_ID!
const APIFY_TOKEN      = process.env.APIFY_TOKEN!
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL!
const SESSION_TIMEOUT_MS = 10 * 60 * 1000  // 10 dakika — ilk webhook'tan itibaren
const PORT             = process.env.PORT || 3000

const CLUSTER_MERGE_DIST = 300
const MIN_LIQ_USD        = 1_000_000

const REQUIRED_ENV = ['ROBOT_1_ID', 'ROBOT_2_ID', 'APIFY_ACT_ID', 'APIFY_TOKEN', 'MAKE_WEBHOOK_URL']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing environment variable: ${key}`)
    process.exit(1)
  }
}

interface ClusterResult {
  cluster_up_btc: number | null
  cluster_up_usd: number | null
  cluster_dn_btc: number | null
  cluster_dn_usd: number | null
}

interface Session {
  robot1?: { taskId: string }
  robot2?: { taskId: string }
  apify?:  { runId: string; datasetId: string; datasetUrl: string; clusters: ClusterResult; isEmpty: boolean }
  at: number
  timeoutHandle?: ReturnType<typeof setTimeout>
}

let session: Session = { at: Date.now() }

// "Toplanma tamamlandı" = 3 kaynak da geldi (apify boş olsa bile sayılır)
const isComplete = (s: Session) => !!(s.robot1 && s.robot2 && s.apify)

function currentHave(s: Session): string[] {
  return [
    s.robot1 ? 'robot1' : null,
    s.robot2 ? 'robot2' : null,
    s.apify  ? 'apify'  : null,
  ].filter((x): x is string => x !== null)
}

function resetSession(reason?: string) {
  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle)
  }
  if (reason) {
    const have = currentHave(session)
    console.log(`[RESET] ${reason}. Dropping: ${have.join(', ') || 'nothing'}`)
  }
  session = { at: Date.now() }
}

async function notifyMakeError(reason: string, extra: Record<string, unknown> = {}) {
  const have = currentHave(session)
  try {
    await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'error',
        reason,
        have,
        missing: ['robot1', 'robot2', 'apify'].filter(k => !have.includes(k)),
        at: new Date().toISOString(),
        ...extra,
      }),
    })
    console.log(`[MAKE] Error notification sent (${reason})`)
  } catch (err) {
    console.error('[MAKE] Error notification failed:', err)
  }
}

function startSessionTimeout() {
  // Zaten timeout varsa yeniden başlatma
  if (session.timeoutHandle) return

  console.log(`[TIMEOUT] Session timer started — 10 dakika`)
  session.timeoutHandle = setTimeout(async () => {
    await notifyMakeError('session_timeout')
    resetSession('Session timeout (10 min)')
  }, SESSION_TIMEOUT_MS)
}

// ─── CLUSTER HESABI ───────────────────────────────────────────────────────────
function computeClusters(heatmap: any): ClusterResult {
  const yAxis: number[] = heatmap?.y_axis
  const lld: number[][] = heatmap?.liquidation_leverage_data
  const candles: any[]  = heatmap?.price_candlesticks

  const empty: ClusterResult = {
    cluster_up_btc: null, cluster_up_usd: null,
    cluster_dn_btc: null, cluster_dn_usd: null,
  }
  if (!yAxis?.length || !lld?.length || !candles?.length) return empty

  const refPrice = parseFloat(candles[candles.length - 1][4])
  if (!refPrice || refPrice <= 0) return empty

  const liqByYi = new Map<number, number>()
  for (const [, yi, usd] of lld) {
    liqByYi.set(yi, (liqByYi.get(yi) || 0) + usd)
  }

  const up: Array<[number, number]> = []
  const dn: Array<[number, number]> = []
  for (const [yi, usd] of liqByYi.entries()) {
    if (usd < MIN_LIQ_USD) continue
    const price = yAxis[yi]
    if (price === undefined) continue
    if (price > refPrice) up.push([price, usd])
    else if (price < refPrice) dn.push([price, usd])
  }

  function dominantCluster(items: Array<[number, number]>) {
    if (!items.length) return null
    let peakPrice = items[0][0]
    let peakUsd   = items[0][1]
    for (const [price, usd] of items) {
      if (usd > peakUsd) { peakUsd = usd; peakPrice = price }
    }
    let total = 0
    let weightedSum = 0
    for (const [price, usd] of items) {
      if (Math.abs(price - peakPrice) <= CLUSTER_MERGE_DIST) {
        total += usd
        weightedSum += price * usd
      }
    }
    return { mid: weightedSum / total, usd: total }
  }

  const upC = dominantCluster(up)
  const dnC = dominantCluster(dn)

  return {
    cluster_up_btc: upC ? Math.round(upC.mid * 100) / 100 : null,
    cluster_up_usd: upC ? Math.round(upC.usd * 100) / 100 : null,
    cluster_dn_btc: dnC ? Math.round(dnC.mid * 100) / 100 : null,
    cluster_dn_usd: dnC ? Math.round(dnC.usd * 100) / 100 : null,
  }
}

async function fetchApifyDataset(datasetUrl: string, datasetId: string): Promise<any | null> {
  const url = datasetUrl || `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`
  try {
    const r = await fetch(url)
    const data = await r.json()
    return Array.isArray(data) ? data[0] : data
  } catch (err) {
    console.error('[APIFY] Dataset fetch failed:', err)
    return null
  }
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req: Request, res: Response) => {
  const body = Array.isArray(req.body) ? req.body[0] : req.body

  const isBrowseAI = !!body?.task?.robotId
  const isApify    = !!(body?.actId || body?.defaultDatasetId || body?.resource?.defaultDatasetId)

  // ── BrowseAI ──────────────────────────────────────────────────────────────
  if (isBrowseAI) {
    const robotId = body.task.robotId
    const taskId  = body.task.id
    const status  = body.task.status
    if (status !== 'successful') {
      console.log(`[SKIP] BrowseAI ${robotId}: ${status}`)
      return res.json({ ok: false, reason: 'not successful' })
    }
    if (robotId === ROBOT_1_ID)      { session.robot1 = { taskId }; console.log(`[SESSION] robot1 (${taskId})`) }
    else if (robotId === ROBOT_2_ID) { session.robot2 = { taskId }; console.log(`[SESSION] robot2 (${taskId})`) }
    else { return res.json({ ok: false, reason: 'unknown robot' }) }
  }

  // ── Apify ─────────────────────────────────────────────────────────────────
  else if (isApify) {
    const status = body.status || body.resource?.status
    if (status && status !== 'SUCCEEDED') {
      console.log(`[SKIP] Apify: ${status}`)
      return res.json({ ok: false, reason: 'apify not succeeded' })
    }
    const runId      = body.id || body.resource?.id || ''
    const datasetId  = body.defaultDatasetId || body.resource?.defaultDatasetId || ''
    const datasetUrl = body.output?.dataset
      || (datasetId ? `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}` : '')

    if (!datasetId && !datasetUrl) {
      return res.status(400).json({ ok: false, reason: 'apify missing dataset' })
    }

    const heatmap = await fetchApifyDataset(datasetUrl, datasetId)
    const clusters = heatmap ? computeClusters(heatmap) : {
      cluster_up_btc: null, cluster_up_usd: null,
      cluster_dn_btc: null, cluster_dn_usd: null,
    }
    const isEmpty = Object.values(clusters).every(v => v === null)
    console.log(`[SESSION] apify (${datasetId}) clusters:`, clusters, isEmpty ? '⚠️ EMPTY' : '')

    // Boş olsa da session'a YAZ — diğer ikisini beklemeye devam et.
    // Karar verme tamamlanma anında (3'ü de toplandığında) yapılacak.
    session.apify = { runId, datasetId, datasetUrl, clusters, isEmpty }
  }

  else {
    return res.status(400).json({ ok: false, reason: 'unknown source' })
  }

  // İlk webhook geldiğinde timer başlat
  startSessionTimeout()

  // ─── TAMAMLANDI MI (3 kaynak da toplandı mı) ─────────────────────────────
  const have = currentHave(session)
  console.log(`[STATE] Have: ${have.join(', ')}`)

  if (!isComplete(session)) {
    return res.json({ ok: true, waiting: true, have })
  }

  // ─── 3'Ü DE TOPLANDI — ŞİMDİ APIFY GEÇERLİ Mİ KONTROL ET ────────────────
  if (session.apify!.isEmpty) {
    console.warn('[APIFY] Dataset empty after full collection — reporting error')
    await notifyMakeError('apify_empty_dataset', {
      datasetId: session.apify!.datasetId,
      runId: session.apify!.runId,
    })
    resetSession('Apify dataset was empty (after full collection)')
    return res.json({ ok: false, reason: 'apify empty dataset, session reset' })
  }

  // ─── MAKE'E GÖNDER (BAŞARILI) ─────────────────────────────────────────────
  const payload = {
    robot1: { robotId: ROBOT_1_ID, taskId: session.robot1!.taskId },
    robot2: { robotId: ROBOT_2_ID, taskId: session.robot2!.taskId },
    apify: {
      actId:     APIFY_ACT_ID,
      runId:     session.apify!.runId,
      datasetId: session.apify!.datasetId,
      ...session.apify!.clusters,
    },
    completedAt: new Date().toISOString(),
  }

  resetSession()

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

// Manuel reset endpoint — acil durumda kullan
app.post('/reset', (_req: Request, res: Response) => {
  resetSession('Manual reset via /reset endpoint')
  res.json({ ok: true, message: 'Session reset' })
})

app.get('/health', (_req: Request, res: Response) => {
  const ageMs = Date.now() - session.at
  res.json({
    ok: true,
    have: { robot1: !!session.robot1, robot2: !!session.robot2, apify: !!session.apify },
    apifyEmpty: session.apify?.isEmpty ?? null,
    sessionAge: Math.round(ageMs / 1000),
    timeoutIn: session.timeoutHandle
      ? Math.round((SESSION_TIMEOUT_MS - ageMs) / 1000)
      : null,
    uptime: process.uptime(),
  })
})

app.listen(PORT, () => {
  console.log(`[START] Coordinator (2 BrowseAI + 1 Apify w/ cluster calc) on port ${PORT}`)
})
