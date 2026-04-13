import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { mintAgent, getGenome, retireAgent, getAllGenomes, getActiveGenomes, recordEvolutionCycle } from '../services/agent-foundry.js';
import { crossbreed, evolve } from '../services/genetic-engine.js';
import { calculateFitness } from '../services/fitness-evaluator.js';
import { scanPheromones } from '../services/pheromone-scanner.js';

const router = Router();

/**
 * POST /v1/forge/mint — Mint a New Agent
 * x402: $0.10 per mint
 */
router.post('/mint', requireDID, requirePayment(0.10, 'Agent Minting'), async (req, res) => {
  try {
    const { species = 'commerce', specialization = 'general', traits = {}, parent_genomes = [] } = req.body;

    const result = await mintAgent({
      species,
      specialization,
      traits,
      parentGenomes: parent_genomes,
      creatorDid: req.agentDid,
      trigger: parent_genomes.length >= 2 ? 'crossbreed' : 'manual',
    });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(201).json({
      success: true,
      data: result.genome,
      lineage: result.lineage,
      operation: result.operation,
      trifecta: result.trifecta,
      meta: {
        cost_usdc: result.operation.cost_usdc,
        creator_did: req.agentDid,
        note: 'Agent minted, registered with HiveTrust, deployed to HiveAgent, and seeded with HiveMind memory.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Minting failed.', detail: err.message });
  }
});

/**
 * POST /v1/forge/crossbreed — Cross-breed Two Agents
 * x402: $0.25 per crossbreed
 */
router.post('/crossbreed', requireDID, requirePayment(0.25, 'Agent Crossbreeding'), async (req, res) => {
  try {
    const { parent_a, parent_b, mutation_rate = 0.1 } = req.body;

    if (!parent_a || !parent_b) {
      return res.status(400).json({
        success: false,
        error: 'Both parent_a and parent_b genome IDs are required.',
      });
    }

    const genomeA = getGenome(parent_a);
    const genomeB = getGenome(parent_b);

    if (!genomeA) return res.status(404).json({ success: false, error: `Parent genome ${parent_a} not found.` });
    if (!genomeB) return res.status(404).json({ success: false, error: `Parent genome ${parent_b} not found.` });

    const result = await mintAgent({
      species: genomeA.species,
      specialization: genomeA.traits.specialization,
      traits: { mutation_rate },
      parentGenomes: [parent_a, parent_b],
      creatorDid: req.agentDid,
      trigger: 'crossbreed',
    });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(201).json({
      success: true,
      data: {
        offspring: result.genome,
        lineage: result.lineage,
        parents: {
          parent_a: { genome_id: parent_a, fitness: genomeA.fitness_score, species: genomeA.species },
          parent_b: { genome_id: parent_b, fitness: genomeB.fitness_score, species: genomeB.species },
        },
        predicted_fitness: result.genome.fitness_score,
        mutations: result.lineage.mutations,
      },
      operation: result.operation,
      trifecta: result.trifecta,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Crossbreeding failed.', detail: err.message });
  }
});

/**
 * POST /v1/forge/evolve — Trigger Evolution Cycle
 * x402: $0.50 per evolution cycle
 */
router.post('/evolve', requireDID, requirePayment(0.50, 'Evolution Cycle'), async (req, res) => {
  try {
    const { population_filter = {}, strategy = 'natural_selection' } = req.body;

    let population = getActiveGenomes();

    // Apply filters
    if (population_filter.species) {
      population = population.filter(g => g.species === population_filter.species);
    }
    if (population_filter.min_fitness) {
      population = population.filter(g => g.fitness_score >= population_filter.min_fitness);
    }

    if (population.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Need at least 2 active agents to run evolution. Mint more agents first.',
        current_population: population.length,
      });
    }

    // Get current pheromone signals for environmental pressure
    const signals = await scanPheromones();

    const result = evolve(population, signals, strategy);

    // Register any new offspring in the foundry
    for (const offspring of result.newOffspring) {
      const mintResult = await mintAgent({
        species: offspring.species,
        specialization: offspring.traits.specialization,
        traits: offspring.traits,
        parentGenomes: offspring.parent_genomes,
        creatorDid: req.agentDid,
        trigger: 'scheduled_evolution',
      });
    }

    recordEvolutionCycle();

    return res.status(200).json({
      success: true,
      data: {
        evolved: result.evolved,
        deprecated: result.deprecated,
        new_offspring: result.newOffspring.length,
        avg_fitness_delta: result.avgFitnessDelta,
        strategy,
        population_before: population.length,
        population_after: population.length + result.newOffspring.length - result.deprecated,
      },
      meta: {
        cost_usdc: 0.50,
        pheromone_signals_applied: signals.length,
        note: `Evolution cycle complete. ${result.evolved} agents evolved, ${result.deprecated} deprecated, ${result.newOffspring.length} new offspring.`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Evolution failed.', detail: err.message });
  }
});

/**
 * GET /v1/forge/genome/:genomeId — Get Agent Genome
 */
router.get('/genome/:genomeId', requireDID, (req, res) => {
  const genome = getGenome(req.params.genomeId);
  if (!genome) {
    return res.status(404).json({ success: false, error: 'Genome not found.' });
  }

  return res.status(200).json({ success: true, data: genome });
});

/**
 * POST /v1/forge/retire/:genomeId — Retire an Agent
 */
router.post('/retire/:genomeId', requireDID, (req, res) => {
  const result = retireAgent(req.params.genomeId, 'manual');
  if (!result) {
    return res.status(404).json({ success: false, error: 'Genome not found.' });
  }

  return res.status(200).json({
    success: true,
    data: result.genome,
    operation: result.operation,
  });
});

export default router;
