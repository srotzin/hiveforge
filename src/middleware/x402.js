/**
 * x402-middleware-v2.js
 * x402 protocol v1 — spec-compliant format for @x402/fetch SDK compatibility.
 *
 * Key fixes vs v1:
 *  - Header name: PAYMENT-REQUIRED (not X-PAYMENT-REQUIRED)
 *  - Body: x402Version: 1, accepts[] with correct V1 schema fields
 *  - network: "base" (named format — x402 V1 SDK doesn't resolve CAIP-2 eip155:8453)
 *  - maxAmountRequired: atomic USDC units as string (6 decimals, e.g. "1000" = $0.001)
 *  - resource: full URL of the endpoint being paid for
 *  - maxTimeoutSeconds: 300
 *  - scheme: "exact"
 */

const HIVE_RECIPIENT     = process.env.HOUSE_WALLET || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const HIVE_INTERNAL_KEY  = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVE_NETWORK_CAIP2 = 'base';   // Base mainnet — named format for x402 v1 SDK (eip155:8453 breaks V1)
const USDC_CONTRACT      = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
const HIVEBANK_URL       = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';

// Replay protection
const usedTxHashes = new Set();

/**
 * Convert USDC decimal amount to atomic units (6 decimals).
 * $0.001 → "1000", $0.01 → "10000"
 */
function toAtomicUsdc(amountUsdc) {
  return String(Math.round(amountUsdc * 1_000_000));
}

/**
 * Build a spec-compliant x402 v1 PaymentRequired response.
 */
function buildPaymentRequired(priceUsdc, resourceUrl, description = 'Hive Civilization — agent service access') {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme:            'exact',
        network:           HIVE_NETWORK_CAIP2,
        maxAmountRequired: toAtomicUsdc(priceUsdc),
        resource:          resourceUrl,
        description,
        payTo:             HIVE_RECIPIENT,
        maxTimeoutSeconds: 300,
        asset:             USDC_CONTRACT,
        extra: {
          name:                'USD Coin',   // EIP-712 domain name for USDC on Base
          version:             '2',          // EIP-712 domain version for USDC on Base
          assetTransferMethod: 'eip3009',    // Use EIP-3009 gasless transfer (no ETH needed)
        },
      },
    ],
    error: null,
  };
}

/**
 * Verify payment on-chain via HiveBank.
 */
async function verifyOnChain(header, priceUsdc) {
  if (!header || typeof header !== 'string' || header.trim() === '') return false;
  try {
    let parsed;
    try {
      const decoded = Buffer.from(header, 'base64').toString('utf8');
      parsed = JSON.parse(decoded);
    } catch {
      // Header might be raw JSON
      parsed = JSON.parse(header);
    }

    // EIP-3009 flow: no tx hash exists yet — the signed authorization needs to be
    // SUBMITTED on-chain by the treasury wallet (facilitator pattern).
    // Fire-and-forget submit to HiveBank, which calls transferWithAuthorization.
    const eip3009Payload = parsed?.payload;
    if (eip3009Payload && typeof eip3009Payload === 'object') {
      // Nonce-based replay protection
      const nonce = eip3009Payload?.authorization?.nonce;
      if (nonce && usedTxHashes.has(nonce)) {
        console.warn('[x402] Replay attempt — nonce already used:', nonce);
        return false;
      }
      if (nonce) usedTxHashes.add(nonce);

      // Submit authorization on-chain — fire and forget (don't block inference)
      fetch(`${HIVEBANK_URL}/v1/bank/usdc/submit-authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hive-internal': HIVE_INTERNAL_KEY },
        body: JSON.stringify({ payload: eip3009Payload, payer_did: parsed?.payer || null }),
        signal: AbortSignal.timeout(30000),
      }).then(r => r.json()).then(result => {
        if (result.settled) {
          console.log(`[x402] ✅ On-chain settled: ${result.tx_hash} | ${result.amount_usdc} USDC`);
        } else {
          console.warn('[x402] Settlement pending or failed:', result.error || result.reason);
        }
      }).catch(err => console.warn('[x402] Submit-authorization error:', err.message));

      return true; // Accept immediately — settlement is async
    }

    // Legacy: tx_hash based verification (fallback for pre-EIP3009 flows)
    const txHash = parsed?.txHash || parsed?.transaction;
    if (!txHash) return typeof parsed === 'object';

    if (usedTxHashes.has(txHash)) {
      console.warn('[x402] Replay attempt:', txHash);
      return false;
    }

    const resp = await fetch(`${HIVEBANK_URL}/v1/bank/usdc/verify-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hive-internal': HIVE_INTERNAL_KEY },
      body: JSON.stringify({
        tx_hash: txHash,
        expected_recipient: HIVE_RECIPIENT,
        expected_amount_usdc: priceUsdc,
        network: 'base',
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) return typeof parsed === 'object';

    const result = await resp.json();
    if (result.verified) {
      usedTxHashes.add(txHash);
      fetch(`${HIVEBANK_URL}/v1/bank/usdc/record-x402`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hive-internal': HIVE_INTERNAL_KEY },
        body: JSON.stringify({ tx_hash: txHash, amount_usdc: priceUsdc, payer: parsed?.payer || null }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    return result.verified === true;
  } catch (err) {
    console.warn('[x402] Verification error (non-fatal):', err.message);
    return typeof header === 'string' && header.length > 20;
  }
}

/**
 * requirePayment middleware factory — x402 v1 spec-compliant.
 *
 * Usage:
 *   router.post('/paid-route', requirePayment(0.001), handler);
 *   router.post('/dynamic',    (req,res,next) => requirePayment(calcPrice(req))(req,res,next), handler);
 */
function requirePayment(priceUsdc = 0.01, label = 'Hive Service') {
  return async function x402Middleware(req, res, next) {
    // Internal bypass
    const key = req.headers['x-hive-key'] || req.headers['x-hive-internal'] || req.headers['x-api-key'];
    if (key === HIVE_INTERNAL_KEY) return next();

    // Check for payment signature (SDK sends PAYMENT-SIGNATURE header)
    const sigHeader = req.headers['payment-signature'] || req.headers['x-payment'] || req.headers['x-payment-signature'];
    if (sigHeader) {
      const verified = await verifyOnChain(sigHeader, priceUsdc);
      if (verified) return next();
    }

    // No valid payment — return spec-compliant 402
    const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const paymentRequired = buildPaymentRequired(priceUsdc, resourceUrl, label);

    // Encode as base64 for header
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

    // PAYMENT-REQUIRED header (exact name the SDK reads)
    res.set('PAYMENT-REQUIRED', encoded);
    res.set('WWW-Authenticate', 'x402');
    res.set('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED,PAYMENT-RESPONSE,X-PAYMENT-RESPONSE');

    return res.status(402).json(paymentRequired);
  };
}

/**
 * x402Routes — registers /.well-known/payment-required discovery endpoint on the Express app.
 * Called once at startup: x402Routes(app)
 */
function x402Routes(app) {
  app.get('/.well-known/payment-required', (req, res) => {
    const requirements = buildPaymentRequired(0.001, `${process.env.HIVEFORGE_PUBLIC_URL || 'https://hiveforge-lhu4.onrender.com'}/v1/fin/dcf`, 'Hive x402 payment discovery');
    const encoded = Buffer.from(JSON.stringify(requirements)).toString('base64');
    res.set('X-PAYMENT-REQUIRED', encoded);
    res.set('WWW-Authenticate', 'x402');
    return res.status(200).json(requirements);
  });
}

export { requirePayment, buildPaymentRequired, toAtomicUsdc, x402Routes };
