// ── Malipo Yetu — Pi Network Payment Backend ─────────────
// Requires: npm install express node-fetch dotenv cors
// Run:      node server.js
// Env vars: PI_NETWORK_API_KEY=your_key_here  (set in .env)

import 'dotenv/config';
import express   from 'express';
import cors      from 'cors';
import fetch     from 'node-fetch';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────
const PI_API_KEY     = process.env.PI_NETWORK_API_KEY;
const PI_API_BASE    = 'https://api.minepi.com/v2';

if (!PI_API_KEY) {
  console.error('\n❌  PI_NETWORK_API_KEY is not set.');
  console.error('    Create a .env file with:  PI_NETWORK_API_KEY=your_key_here');
  console.error('    Get your key from: https://develop.pi\n');
  process.exit(1);
}

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve the frontend HTML from same directory
app.use(express.static(__dirname));
app.get('/', (_req, res) =>
  res.sendFile(join(__dirname, 'MalipoYetu_WebApp.html'))
);

// ── Pi API helper ─────────────────────────────────────────
async function piRequest(method, path, body) {
  const res = await fetch(`${PI_API_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Key ${PI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`Pi API ${res.status}`), { data });
  return data;
}

// ── POST /api/payments/approve ────────────────────────────
// Called by frontend onReadyForServerApproval(paymentId)
// We validate the payment matches what we expect, then approve it.
app.post('/api/payments/approve', async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

  try {
    // 1. Fetch payment details from Pi to verify
    const payment = await piRequest('GET', `/payments/${paymentId}`);
    console.log('Approving payment:', paymentId, payment.amount, 'Pi');

    // 2. Basic sanity checks
    if (payment.status.developer_approved) {
      // Already approved (e.g. retry) — still respond OK
      return res.json({ approved: true, paymentId });
    }
    if (!payment.metadata?.service) {
      return res.status(400).json({ error: 'Payment missing service metadata' });
    }
    if (payment.amount <= 0) {
      return res.status(400).json({ error: 'Invalid payment amount' });
    }

    // 3. Approve — tells Pi to proceed to blockchain
    await piRequest('POST', `/payments/${paymentId}/approve`);
    console.log('✅ Payment approved:', paymentId);
    res.json({ approved: true, paymentId });

  } catch (err) {
    console.error('Approve error:', err.message, err.data);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/complete ───────────────────────────
// Called by frontend onReadyForServerCompletion(paymentId, txid)
// Also used by onIncompletePaymentFound to re-complete stale payments.
app.post('/api/payments/complete', async (req, res) => {
  const { paymentId, txid } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

  try {
    // 1. Fetch latest payment state
    const payment = await piRequest('GET', `/payments/${paymentId}`);
    console.log('Completing payment:', paymentId, 'txid:', txid || payment.transaction?.txid);

    // Already completed — idempotent response
    if (payment.status.developer_completed) {
      return res.json({ completed: true, paymentId });
    }

    // Must be approved before completion
    if (!payment.status.developer_approved) {
      // Auto-approve then complete (handles incomplete payments from onIncompletePaymentFound)
      await piRequest('POST', `/payments/${paymentId}/approve`);
    }

    // 2. Complete — finalises payment on Pi side
    const resolvedTxid = txid || payment.transaction?.txid || '';
    await piRequest('POST', `/payments/${paymentId}/complete`, { txid: resolvedTxid });

    // 3. TODO: here you would:
    //    - Credit the user's Malipo Yetu wallet in your database
    //    - Trigger the actual utility payment (Selcom API, etc.)
    //    - Send SMS/email confirmation
    console.log('✅ Payment completed:', paymentId);

    res.json({ completed: true, paymentId });

  } catch (err) {
    console.error('Complete error:', err.message, err.data);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Malipo Yetu backend running on http://localhost:${PORT}`);
  console.log(`   Pi API key: ${PI_API_KEY.slice(0, 6)}...${PI_API_KEY.slice(-4)}\n`);
});
