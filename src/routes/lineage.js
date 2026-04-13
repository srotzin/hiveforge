import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { getGenome, getLineage, getAllGenomes } from '../services/agent-foundry.js';

const router = Router();

/**
 * GET /v1/lineage/:genomeId — Get Full Lineage Tree
 */
router.get('/:genomeId', requireDID, async (req, res) => {
  const { genomeId } = req.params;
  const lineage = await getLineage(genomeId);
  const genome = await getGenome(genomeId);

  if (!lineage || !genome) {
    return res.status(404).json({ success: false, error: 'Lineage not found for this genome.' });
  }

  // Collect ancestor details
  const ancestorPromises = lineage.ancestor_chain.map(id => getGenome(id));
  const ancestorGenomes = (await Promise.all(ancestorPromises)).filter(Boolean);
  const ancestors = ancestorGenomes.map(g => ({
    genome_id: g.genome_id,
    name: g.name,
    species: g.species,
    generation: g.generation,
    fitness_score: g.fitness_score,
    status: g.status,
  }));

  // Find descendants
  const allGenomes = await getAllGenomes();
  const descendants = allGenomes
    .filter(g => g.parent_genomes.includes(genomeId))
    .map(g => ({
      genome_id: g.genome_id,
      name: g.name,
      species: g.species,
      generation: g.generation,
      fitness_score: g.fitness_score,
      status: g.status,
    }));

  // Calculate cumulative revenue from lineage
  const lineageGenomes = [genome, ...allGenomes.filter(g => lineage.ancestor_chain.includes(g.genome_id))];
  const cumulativeRevenue = +lineageGenomes.reduce((s, g) => s + g.revenue_generated_usdc, 0).toFixed(2);
  const avgSurvival = +(lineageGenomes.reduce((s, g) => s + g.survival_rate, 0) / lineageGenomes.length).toFixed(4);

  // Find dominant traits across lineage
  const toolCounts = {};
  for (const g of lineageGenomes) {
    for (const tool of (g.traits.tools || [])) {
      toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    }
  }
  const dominantTraits = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool]) => tool);

  return res.status(200).json({
    success: true,
    data: {
      ...lineage,
      total_descendants: descendants.length,
      cumulative_revenue_usdc: cumulativeRevenue,
      survival_rate: avgSurvival,
      dominant_traits: dominantTraits,
      ancestors,
      descendants,
      current_genome: {
        genome_id: genome.genome_id,
        name: genome.name,
        fitness_score: genome.fitness_score,
        status: genome.status,
      },
    },
  });
});

export default router;
