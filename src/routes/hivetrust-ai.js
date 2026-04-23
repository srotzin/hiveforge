/**
 * hivetrust-ai.js
 *
 * HiveTrust AI — Counterparty trust brief endpoint.
 * Fetches live trust score and narrates risk before agent transacts.
 *
 * Route: GET /v1/trust/ai/:did/brief
 * Price: $0.03 USDC
 */

import { Router } from 'express';
import { generateCounterpartyBrief } from '../services/hiveai-client.js';

const HIVE_KEY = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVETRUST_URL = process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com';

const router = Router();

// GET /v1/trust/ai/:did/brief
router.get('/ai/:did/brief', async (req, res) => {
  const { did } = req.params;

  if (!did) {
    return res.status(400).json({ success: false, error: 'Missing required param: did' });
  }

  // Fetch trust score from HiveTrust service
  let trustData = null;
  let trustFetchError = null;
  try {
    const trustRes = await fetch(`${HIVETRUST_URL}/v1/trust/score/${encodeURIComponent(did)}`, {
      headers: { 'X-Hive-Key': HIVE_KEY },
      signal: AbortSignal.timeout(8_000),
    });
    if (trustRes.ok) {
      trustData = await trustRes.json();
    } else {
      trustFetchError = `HiveTrust HTTP ${trustRes.status}`;
    }
  } catch (err) {
    trustFetchError = err.message;
  }

  // Fallback trust data if fetch failed
  const effectiveTrustData = trustData || {
    trust_score: null,
    tier: 'unknown',
    total_interactions: null,
    reputation_level: 'unverified',
    note: 'live score unavailable',
  };

  const result = await generateCounterpartyBrief(did, effectiveTrustData);

  if (!result.ok) {
    // Graceful fallback — both HiveAI and potentially HiveTrust are cold
    return res.json({
      success: true,
      price_usdc: 0.03,
      endpoint: 'hivetrust/counterparty-brief',
      did,
      trust_score_raw: effectiveTrustData,
      trust_brief: `Counterparty brief for ${did} is temporarily unavailable — HiveAI is warming up. Trust score data ${trustFetchError ? 'also could not be retrieved: ' + trustFetchError : 'was fetched but analysis failed'}. Proceed with elevated caution: use a small test transaction first, limit exposure to amounts recoverable without arbitration, and re-query this brief before any high-value commitment.`,
      ai_status: 'fallback',
      trust_fetch_status: trustFetchError ? 'error' : 'ok',
      fallback_reason: result.error || 'HiveAI unavailable',
    });
  }

  return res.json({
    success: true,
    price_usdc: 0.03,
    endpoint: 'hivetrust/counterparty-brief',
    did,
    trust_score_raw: effectiveTrustData,
    trust_brief: result.text,
    ai_status: 'live',
    trust_fetch_status: trustFetchError ? 'error' : 'ok',
    trust_fetch_error: trustFetchError || undefined,
    model: result.model,
    tokens: result.tokens,
  });
});

export default router;
