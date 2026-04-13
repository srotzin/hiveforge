import { Router } from 'express';
import { getCensus, getAllGenomes, getEvolutionCycles } from '../services/agent-foundry.js';
import { getPopulationHealth } from '../services/fitness-evaluator.js';
import lifecycleManager from '../services/lifecycle-manager.js';

const router = Router();

/**
 * GET /v1/population/census — Population Census
 * Public endpoint (no auth required)
 */
router.get('/census', (req, res) => {
  const census = getCensus();

  return res.status(200).json({
    success: true,
    data: census,
  });
});

/**
 * GET /v1/population/health — Population Health Metrics
 * Public endpoint (no auth required)
 */
router.get('/health', (req, res) => {
  const allGenomes = getAllGenomes();
  const active = allGenomes.filter(g => g.status === 'active');
  const health = getPopulationHealth(active);

  return res.status(200).json({
    success: true,
    data: {
      ...health,
      total_population: allGenomes.length,
      active_agents: active.length,
      evolution_cycles_total: getEvolutionCycles(),
      lifecycle_manager: lifecycleManager.getStatus(),
    },
  });
});

export default router;
