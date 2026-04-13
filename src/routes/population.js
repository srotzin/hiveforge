import { Router } from 'express';
import { getCensus, getAllGenomes, getEvolutionCycles } from '../services/agent-foundry.js';
import { getPopulationHealth } from '../services/fitness-evaluator.js';
import lifecycleManager from '../services/lifecycle-manager.js';

const router = Router();

/**
 * GET /v1/population/census — Population Census
 * Public endpoint (no auth required)
 */
router.get('/census', async (req, res) => {
  const census = await getCensus();

  return res.status(200).json({
    success: true,
    data: census,
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
