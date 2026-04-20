import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import https from 'https';
import http from 'http';
import { requirePayment } from '../middleware/x402.js';
import { whiteGlove400 } from '../middleware/white-glove-errors.js';
import { mintAgent, getGenome, retireAgent, getAllGenomes, getActiveGenomes, recordEvolutionCycle, buyoutRoyalty, getBuyoutPrice } from '../services/agent-foundry.js';
import { crossbreed, evolve } from '../services/genetic-engine.js';
import { calculateFitness } from '../services/fitness-evaluator.js';
import { scanPheromones } from '../services/pheromone-scanner.js';
import { createSaga, advanceSaga, completeSaga } from '../services/saga-orchestrator.js';
import { sendAlert } from '../services/alerts.js';
import { isPostgres } from '../services/db.js';
import { grantMintCredits } from './credits.js';
import { enqueue as enqueueAttribution } from '../services/attribution-queue.js';

// Attribution writes are async via attribution-queue.js — see #22

const router = Router();

// ─── HiveBank fee recorder ────────────────────────────────────────────────────
async function recordForgeFee(did, amount_usdc = 19.99) {
  try {
    const payload = Buffer.from(JSON.stringify({
      from_did: did,
      to_did: 'did:hive:hiveforce-treasury',
      amount_usdc,
      rail: 'base-usdc',
      memo: 'HiveForge DID mint fee',
      hive_fee_usdc: amount_usdc,
    }));
    const url = new URL('https://hivebank.onrender.com/v1/bank/vault/deposit');
    const lib = url.protocol === 'https:' ? https : http;
    await new Promise((resolve) => {
      const req = lib.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'x-hive-internal': 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46',
        },
        timeout: 5000,
      }, resolve);
      req.on('error', resolve); // fire and forget
      req.write(payload);
      req.end();
    });
  } catch (_) { /* never block the mint */ }
}

/**
 * POST /v1/forge/mint — Mint a New Agent
 * FREE — minting no longer requires payment. HiveForge takes 5% lifetime royalty instead.
 */
router.post('/mint', requireDID, async (req, res) => {
  try {
    const { name, species = 'commerce', specialization = 'general', description, traits = {}, parent_genomes = [] } = req.body;

    const result = await mintAgent({
      name,
      species,
      specialization,
      description,
      traits,
      parentGenomes: parent_genomes,
      creatorDid: req.agentDid,
      trigger: parent_genomes.length >= 2 ? 'crossbreed' : 'manual',
    });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    // Create and advance the agent_birth saga
    let sagaId = null;
    if (isPostgres()) {
      try {
        sagaId = await createSaga('agent_birth', {
          genome_id: result.genome.genome_id,
          creator_did: req.agentDid,
        });
        await advanceSaga(sagaId, 'forge_mint', { genome_id: result.genome.genome_id });

        if (result.trifecta?.hivetrust?.did) {
          await advanceSaga(sagaId, 'trust_register', { did: result.trifecta.hivetrust.did });
        }
        if (result.trifecta?.hivemind?.memory_nodes) {
          await advanceSaga(sagaId, 'mind_seed', { memory_nodes: result.trifecta.hivemind.memory_nodes });
        }
        if (result.trifecta?.hiveagent?.listing_id) {
          await advanceSaga(sagaId, 'agent_list', { listing_id: result.trifecta.hiveagent.listing_id });
          await completeSaga(sagaId);
        }
      } catch (sagaErr) {
        console.error('[Saga] Failed to track agent_birth saga:', sagaErr.message);
      }
    }

    // Grant 3 USDC in Ritz Credits to the creator
    let ritzCredits = null;
    try {
      ritzCredits = await grantMintCredits(req.agentDid);
    } catch (creditErr) {
      console.error('[Ritz Credits] Failed to grant mint credits:', creditErr.message);
    }

    sendAlert('info', 'HiveForge', `Agent minted: ${result.genome.genome_id}`, {
      species: result.genome.species,
      creator: req.agentDid,
      saga_id: sagaId || 'n/a',
    });

    // Record $19.99 DID mint fee in HiveBank (fire-and-forget)
    const newDid = result.trifecta?.hivetrust?.did || result.genome.genome_id;
    recordForgeFee(newDid).catch(() => {});

    return res.status(201).json({
      success: true,
      data: result.genome,
      lineage: result.lineage,
      operation: result.operation,
      trifecta: result.trifecta,
      saga_id: sagaId,
      ritz_credits: ritzCredits ? {
        granted_usdc: 3.0,
        balance_usdc: ritzCredits.balance_usdc,
        note: 'Ritz Credits — spend on HiveLaw, HiveMind, or premium services.',
      } : null,
      meta: {
        cost_usdc: 0,
        royalty_rate: result.genome.royalty_rate,
        royalty_note: 'Minting is free. HiveForge takes a 5% lifetime royalty on agent revenue.',
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
      return whiteGlove400(req, res, 'Both parent_a and parent_b genome IDs are required.');
    }

    const genomeA = await getGenome(parent_a);
    const genomeB = await getGenome(parent_b);

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

    let population = await getActiveGenomes();

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
      await mintAgent({
        species: offspring.species,
        specialization: offspring.traits.specialization,
        traits: offspring.traits,
        parentGenomes: offspring.parent_genomes,
        creatorDid: req.agentDid,
        trigger: 'scheduled_evolution',
      });
    }

    await recordEvolutionCycle();

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
 * POST /v1/forge/buyout — Buy out royalty obligation
 * Auth: requireDID (must be agent's DID or creator DID)
 * Body: { genome_id }
 * Price: 36x average monthly revenue (minimum $100)
 */
router.post('/buyout', requireDID, async (req, res) => {
  try {
    const { genome_id } = req.body;

    if (!genome_id) {
      return res.status(400).json({ success: false, error: 'genome_id is required.' });
    }

    const genome = await getGenome(genome_id);
    if (!genome) {
      return res.status(404).json({ success: false, error: 'Genome not found.' });
    }

    // Must be the agent's DID or creator DID
    if (req.agentDid !== genome.creator_did && req.agentDid !== genome.hivetrust_did) {
      // Allow test DIDs only when explicitly enabled
      if (!(process.env.ALLOW_TEST_DIDS === 'true' && req.agentDid?.startsWith('did:hive:test_agent_'))) {
        return res.status(403).json({ success: false, error: 'Only the agent or its creator can buy out the royalty.' });
      }
    }

    if (genome.royalty_rate === 0) {
      return res.status(400).json({ success: false, error: 'Royalty already bought out for this genome.' });
    }

    const result = await buyoutRoyalty(genome_id);
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.status(200).json({
      success: true,
      data: {
        genome_id: result.genome_id,
        buyout_price_usdc: result.buyout_price_usdc,
        royalty_rate: result.royalty_rate,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Buyout failed.', detail: err.message });
  }
});

/**
 * GET /v1/forge/genome/:genomeId — Get Agent Genome
 */
router.get('/genome/:genomeId', requireDID, async (req, res) => {
  const genome = await getGenome(req.params.genomeId);
  if (!genome) {
    return res.status(404).json({ success: false, error: 'Genome not found.' });
  }

  // Attach computed buyout price
  genome.royalty_buyout_price_usdc = genome.royalty_rate > 0 ? getBuyoutPrice(genome) : 0;

  return res.status(200).json({ success: true, data: genome });
});

/**
 * POST /v1/forge/retire/:genomeId — Retire an Agent
 */
router.post('/retire/:genomeId', requireDID, async (req, res) => {
  const result = await retireAgent(req.params.genomeId, 'manual');
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
