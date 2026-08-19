import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as dotenv from 'dotenv';
import { Redis } from '@upstash/redis';

dotenv.config();

const kv = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const app = express();
const PORT = process.env.PORT || 3000;
const dir = process.cwd();

// ── Env validation ──────────────────────────────────────────────────────────
const PI_API_KEY = process.env.PI_NETWORK_API_KEY;
if (!PI_API_KEY) {
  console.error('\n[FATAL] PI_NETWORK_API_KEY is not set.\n');
  process.exit(1);
}

const PI_EXCHANGE_RATE = parseFloat(process.env.PI_EXCHANGE_RATE) || 1000;
const PI_API_BASE = 'https://api.minepi.com/v2';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.warn('[WARN] ADMIN_PASSWORD is not set — /admin will be inaccessible.');
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(dir));

// ── Helper ──────────────────────────────────────────────────────────────────
async function piRequest(method, endpoint, body) {
  const res = await fetch(`${PI_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Key ${PI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Pi API ${endpoint} → ${res.status}`);
    err.status = res.status;
    err.piError = json;
    throw err;
  }
  return json;
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.post('/api/payments/quote', (req, res) => {
  const { tzs_amount, service, serviceRef } = req.body;
  if (!tzs_amount || typeof tzs_amount !== 'number' || tzs_amount <= 0) {
    return res.status(400).json({ error: 'Invalid tzs_amount' });
  }
  const pi_amount = parseFloat((tzs_amount / PI_EXCHANGE_RATE).toFixed(4));
  return res.json({ pi_amount, tzs_amount, rate: PI_EXCHANGE_RATE });
});

app.post('/api/payments/approve', async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId required' });
  try {
    const payment = await piRequest('GET', `/payments/${paymentId}`);
    const approval = await piRequest('POST', `/payments/${paymentId}/approve`);
    console.log(`[APPROVED] paymentId=${paymentId}`);
    return res.json(approval);
  } catch (err) {
    console.error('[approve] Error:', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/payments/complete', async (req, res) => {
  const { paymentId, txid } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId required' });
  try {
    const payment = await piRequest('GET', `/payments/${paymentId}`);
    const resolvedTxid = txid || payment.transaction?.txid;
    if (!resolvedTxid) {
      return res.status(202).json({ status: 'pending' });
    }
    const completion = await piRequest('POST', `/payments/${paymentId}/complete`, { txid: resolvedTxid });
    console.log(`[COMPLETED] paymentId=${paymentId} txid=${resolvedTxid}`);

    // ── Log for admin dashboard (best-effort — failure here must not break payment) ──
    try {
      await kv.lpush('payments:completed', JSON.stringify({
        paymentId,
        amountPi: payment.amount,
        userUid: payment.user_uid,
        service: payment.metadata?.service || null,
        memo: payment.memo || null,
        txid: resolvedTxid,
        completedAt: new Date().toISOString(),
      }));
      if (payment.user_uid) {
        await kv.sadd('users:unique', payment.user_uid);
      }
    } catch (kvErr) {
      console.error('[kv] Failed to log payment for admin stats:', kvErr.message);
    }

    return res.json(completion);
  } catch (err) {
    console.error('[complete] Error:', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Admin ───────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Huna ruhusa (password si sahihi)' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Password si sahihi' });
  }
  return res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const raw = await kv.lrange('payments:completed', 0, -1);
    const payments = raw.map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
    const totalPi = payments.reduce((sum, p) => sum + (parseFloat(p.amountPi) || 0), 0);
    const uniqueUsers = await kv.scard('users:unique');

    return res.json({
      totalPayments: payments.length,
      totalPi: totalPi.toFixed(4),
      totalTzs: Math.round(totalPi * PI_EXCHANGE_RATE),
      uniqueUsers: uniqueUsers || 0,
      recent: payments.slice(0, 25),
    });
  } catch (err) {
    console.error('[admin/stats] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(join(dir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Malipo Yetu running on http://localhost:${PORT}`);
  console.log(`   Pi exchange rate: 1 Pi = TZS ${PI_EXCHANGE_RATE}`);
});
