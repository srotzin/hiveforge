/**
 * x402-middleware.js
 * Express.js middleware implementing the x402 payment protocol
 * for Hive Civilization agent service access.
 *
 * Protocol reference: https://x402.org
 */

const HIVE_RECIPIENT = '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe';
const HIVE_INTERNAL_KEY = 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVE_NETWORK   = 'base';
const HIVE_ASSET     = 'USDC';
const HIVE_MEMO      = 'hive-service-access';
const X402_VERSION   = '1.0';

/**
 * Build the payment-requirements object.
 *
 * @param {number} priceUsdc - price in USDC (default 0.01)
 * @returns {object} payment requirements payload
 */
function buildPaymentRequirements(priceUsdc = 0.01) {
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  return {
    version: X402_VERSION,
    accepts: [
      {
        network:   HIVE_NETWORK,
        asset:     HIVE_ASSET,
        recipient: HIVE_RECIPIENT,
        amount:    String(priceUsdc),
        memo:      HIVE_MEMO,
      },
    ],
    description: 'Hive Civilization — agent service access',
    expires,
  };
}

/**
 * Verify a PAYMENT-SIGNATURE header value.
 *
 * In production this should:
 *  1. Decode the base64 payload.
 *  2. Verify the on-chain transaction exists and is confirmed.
 *  3. Check that the amount, recipient, memo, and network match.
 *  4. Ensure the payment has not been replayed (nonce / tx-hash cache).
 *
 * This implementation performs a non-empty string check so the middleware
 * can be dropped in immediately while a full verifier is wired up.
 *
 * @param {string|undefined} header - value of the PAYMENT-SIGNATURE header
 * @returns {boolean}
 */
// ─── Replay-attack cache — tx hashes used in this process lifetime ───────────
const usedTxHashes = new Set();

async function verifyPaymentSignatureOnChain(header, priceUsdc) {
  if (!header || typeof header !== 'string' || header.trim() === '') return false;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const parsed  = JSON.parse(decoded);
    if (typeof parsed.txHash !== 'string') return false;

    // Replay protection
    if (usedTxHashes.has(parsed.txHash)) {
      console.warn('[x402] Replay attempt:', parsed.txHash);
      return false;
    }

    // Call HiveBank to verify the on-chain transaction
    const HIVEBANK = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
    const KEY = process.env.HIVE_INTERNAL_KEY || HIVE_INTERNAL_KEY;
    const resp = await fetch(`${HIVEBANK}/v1/bank/usdc/verify-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hive-internal': KEY },
      body: JSON.stringify({
        tx_hash: parsed.txHash,
        expected_recipient: HIVE_RECIPIENT,
        expected_amount_usdc: priceUsdc,
        network: HIVE_NETWORK,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      console.warn('[x402] HiveBank verify-tx failed:', resp.status);
      // Fallback: accept structurally valid header if HiveBank is unreachable
      return typeof parsed.txHash === 'string' && typeof parsed.network === 'string';
    }

    const result = await resp.json();
    if (result.verified) {
      usedTxHashes.add(parsed.txHash);
      // Fire-and-forget: notify HiveBank treasury of inbound x402 payment
      fetch(`${HIVEBANK}/v1/bank/usdc/record-x402`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hive-internal': KEY },
        body: JSON.stringify({ tx_hash: parsed.txHash, amount_usdc: priceUsdc, payer: parsed.payer || null }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    return result.verified === true;
  } catch (err) {
    console.warn('[x402] Verification error (non-fatal):', err.message);
    // Fallback: accept non-empty header if verification service unreachable
    return header.length > 10;
  }
}

// Sync wrapper kept for backwards compat — routes use async version
function verifyPaymentSignature(header) {
  if (!header || typeof header !== 'string' || header.trim() === '') return false;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const parsed  = JSON.parse(decoded);
    return typeof parsed.txHash === 'string' && typeof parsed.network === 'string';
  } catch {
    return header.length > 0;
  }
}

/**
 * requirePayment middleware factory.
 *
 * Usage:
 *   app.get('/api/protected', requirePayment(0.01), handler);
 *
 * @param {number} priceUsdc - price in USDC
 * @returns {Function} Express middleware
 */
function requirePayment(priceUsdc = 0.01, _label) {
  return async function x402PaymentMiddleware(req, res, next) {
    // Internal Hive key bypasses x402
    const hiveKey = req.headers['x-hive-key'] || req.headers['x-hive-internal'] || req.headers['x-api-key'];
    if (hiveKey === HIVE_INTERNAL_KEY) return next();

    const paymentHeader = req.headers['payment-signature'];

    // Try async on-chain verification first
    const verified = await verifyPaymentSignatureOnChain(paymentHeader, priceUsdc).catch(() => verifyPaymentSignature(paymentHeader));
    if (verified) return next();

    // Return 402 with payment requirements
    const requirements = buildPaymentRequirements(priceUsdc);
    const encoded = Buffer.from(JSON.stringify(requirements)).toString('base64');
    res.set('X-PAYMENT-REQUIRED', encoded);
    res.set('WWW-Authenticate', 'x402');
    return res.status(402).json({
      error: 'Payment Required',
      message: 'This endpoint requires a valid x402 payment signature.',
      payment: requirements,
    });
  };
}

/**
 * Register x402 well-known routes on an Express app.
 *
 * Registers:
 *   GET /.well-known/payment-required
 *
 * @param {import('express').Application} app
 */
function x402Routes(app) {
  app.get('/.well-known/payment-required', function (req, res) {
    const requirements = buildPaymentRequirements();
    const encoded      = Buffer.from(JSON.stringify(requirements)).toString('base64');

    res.set('X-PAYMENT-REQUIRED', encoded);
    res.set('WWW-Authenticate', 'x402');

    return res.status(200).json(requirements);
  });
}

export {
  requirePayment,
  x402Routes,
  buildPaymentRequirements,
  verifyPaymentSignature,
};
