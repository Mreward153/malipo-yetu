import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

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
    return res.json(completion);
  } catch (err) {
    console.error('[complete] Error:', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(join(dir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Malipo Yetu running on http://localhost:${PORT}`);
  console.log(`   Pi exchange rate: 1 Pi = TZS ${PI_EXCHANGE_RATE}`);
});
