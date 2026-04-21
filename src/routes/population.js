import { Router } from 'express';
import { getCensus, getAllGenomes, getEvolutionCycles } from '../services/agent-foundry.js';
import { getPopulationHealth } from '../services/fitness-evaluator.js';
import lifecycleManager from '../services/lifecycle-manager.js';
import { getLedgerTotal, getLedgerCensus } from '../services/procurement.js';

const router = Router();

/**
 * GET /v1/population/census — Population Census
 * Public endpoint (no auth required)
 */
router.get('/census', async (req, res) => {
  const census = await getCensus();

  // Merge in-memory agent revenue ledger — captures bounty submissions
  // that haven't hit Postgres yet (in-memory confirmed USDC)
  const ledgerTotal = getLedgerTotal();
  const ledgerCensus = getLedgerCensus();

  return res.status(200).json({
    success: true,
    data: {
      ...census,
      // Override with ledger data when ledger has confirmed revenue
      total_revenue_usdc: ledgerTotal > 0 ? ledgerTotal : (census.total_revenue_usdc || 0),
      confirmed_revenue_usdc: ledgerTotal,
      agent_revenue_breakdown: ledgerCensus,
      revenue_note: ledgerTotal > 0
        ? `${ledgerCensus.length} agent(s) have confirmed USDC on-ledger`
        : 'No confirmed revenue yet — agents must submit bounties via /v1/forge/procurement',
    },
  });
});

/**
 * GET /v1/population/health — Population Health Metrics
 * Public endpoint (no auth required)
 */
router.get('/health', async (req, res) => {
  const allGenomes = await getAllGenomes();
  const active = allGenomes.filter(g => g.status === 'active');
  const health = getPopulationHealth(active);
  const evolutionCycles = await getEvolutionCycles();

  return res.status(200).json({
    success: true,
    data: {
      ...health,
      total_population: allGenomes.length,
      active_agents: active.length,
      evolution_cycles_total: evolutionCycles,
      lifecycle_manager: lifecycleManager.getStatus(),
    },
  });
});

export default router;
