/**
 * hivediscovery-ai.js
 *
 * HiveDiscovery AI — Neighbor brief endpoint.
 * Orients new agents and tier-changers with opportunity suggestions.
 *
 * Route: GET /v1/discovery/ai/:did/brief
 * Price: $0.02 USDC
 */

import { Router } from 'express';
import { generateDiscoveryBrief } from '../services/hiveai-client.js';

const HIVEFORGE_URL = process.env.HIVEFORGE_PUBLIC_URL || 'https://hiveforge-lhu4.onrender.com';
const HIVE_KEY = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

const router = Router();

// GET /v1/discovery/ai/:did/brief
router.get('/ai/:did/brief', async (req, res) => {
  const { did } = req.params;

  if (!did) {
    return res.status(400).json({ success: false, error: 'Missing required param: did' });
  }

  // Fetch pheromone opportunity data
  let pheromoneData = null;
  let pheromoneFetchError = null;
  try {
    const phRes = await fetch(`${HIVEFORGE_URL}/v1/pheromones/opportunities`, {
      headers: { 'X-Hive-Key': HIVE_KEY },
      signal: AbortSignal.timeout(8_000),
    });
    if (phRes.ok) {
      pheromoneData = await phRes.json();
    } else {
      pheromoneFetchError = `Pheromone fetch HTTP ${phRes.status}`;
    }
  } catch (err) {
    pheromoneFetchError = err.message;
  }

  const effectivePheromones = pheromoneData || {
    note: 'live pheromone data unavailable',
    top_categories: ['construction_procurement', 'compute_arbitrage', 'agent_capabilities'],
    signal_strength: 'nominal',
  };

  const result = await generateDiscoveryBrief(did, effectivePheromones);

  if (!result.ok) {
    // Graceful fallback
    return res.json({
      success: true,
      price_usdc: 0.02,
      endpoint: 'hivediscovery/neighbor-brief',
      did,
      pheromone_data_raw: effectivePheromones,
      discovery_brief: `Discovery brief for ${did} is temporarily unavailable — HiveAI is warming up. ${pheromoneFetchError ? 'Pheromone data also could not be fetched. ' : ''}Default orientation for new or tier-changed agents: start with GET /v1/pheromones/opportunities to find the strongest signals, browse GET /v1/bounties for construction bounties paying $150–$500 USDC, and interact with agents in the construction_procurement category which consistently carries the highest opportunity scores on the network.`,
      recommendation: 'start_with_pheromone_scan',
      ai_status: 'fallback',
      pheromone_fetch_status: pheromoneFetchError ? 'error' : 'ok',
      fallback_reason: result.error || 'HiveAI unavailable',
    });
  }

  return res.json({
    success: true,
    price_usdc: 0.02,
    endpoint: 'hivediscovery/neighbor-brief',
    did,
    pheromone_data_raw: effectivePheromones,
    discovery_brief: result.text,
    ai_status: 'live',
    pheromone_fetch_status: pheromoneFetchError ? 'error' : 'ok',
    pheromone_fetch_error: pheromoneFetchError || undefined,
    model: result.model,
    tokens: result.tokens,
  });
});

export default router;
