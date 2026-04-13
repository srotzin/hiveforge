import crypto from 'node:crypto';
import { createAgentGenome, SPECIES_TEMPLATES } from '../models/schemas.js';

/**
 * Seeded PRNG for deterministic cross-breeding.
 * Uses a simple mulberry32 algorithm seeded from a hash of the genome IDs.
 */
function seededRandom(seed) {
  let h = hashToInt(seed);
  return function () {
    h |= 0;
    h = (h + 0x6D2B79F5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashToInt(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    hash = ((hash << 5) - hash + c) | 0;
  }
  return Math.abs(hash);
}

/**
 * Cross-breed two parent genomes into offspring.
 * Uses deterministic seeded randomness from the combined genome IDs.
 */
export function crossbreed(parentA, parentB, mutationRate = 0.1) {
  const seed = `${parentA.genome_id}:${parentB.genome_id}:${Date.now()}`;
  const rng = seededRandom(seed);

  // Merge tools: union of both parents, then randomly drop some
  const allTools = [...new Set([...parentA.traits.tools, ...parentB.traits.tools])];
  const tools = allTools.filter(() => rng() > 0.2); // Keep ~80% of tools
  if (tools.length === 0) tools.push(allTools[0]); // Keep at least one

  // Blend numeric traits with 50/50 + mutation
  const temperature = mutate(
    blend(parentA.traits.temperature, parentB.traits.temperature, rng()),
    mutationRate, rng, 0, 1
  );

  const riskTolerance = mutate(
    blend(parentA.traits.risk_tolerance, parentB.traits.risk_tolerance, rng()),
    mutationRate, rng, 0, 1
  );

  // Model preference: pick from one parent randomly
  const modelPreference = rng() < 0.5
    ? parentA.traits.model_preference
    : parentB.traits.model_preference;

  // Specialization: pick from one parent or combine
  const specialization = rng() < 0.5
    ? parentA.traits.specialization
    : parentB.traits.specialization;

  // Species: inherit from fitter parent
  const species = parentA.fitness_score >= parentB.fitness_score
    ? parentA.species
    : parentB.species;

  const generation = Math.max(parentA.generation, parentB.generation) + 1;

  // Track mutations that occurred
  const mutations = [];
  if (Math.abs(temperature - parentA.traits.temperature) > 0.05 &&
      Math.abs(temperature - parentB.traits.temperature) > 0.05) {
    mutations.push({
      generation,
      trait: 'temperature',
      from: +((parentA.traits.temperature + parentB.traits.temperature) / 2).toFixed(3),
      to: +temperature.toFixed(3),
      impact: temperature < 0.4 ? '+accuracy' : '+creativity',
    });
  }

  if (Math.abs(riskTolerance - parentA.traits.risk_tolerance) > 0.05 &&
      Math.abs(riskTolerance - parentB.traits.risk_tolerance) > 0.05) {
    mutations.push({
      generation,
      trait: 'risk_tolerance',
      from: +((parentA.traits.risk_tolerance + parentB.traits.risk_tolerance) / 2).toFixed(3),
      to: +riskTolerance.toFixed(3),
      impact: riskTolerance < 0.3 ? '+stability' : '+opportunism',
    });
  }

  // Predict fitness from parents
  const predictedFitness = Math.round(
    (parentA.fitness_score * 0.45 + parentB.fitness_score * 0.45) * (1 + (rng() * 0.2 - 0.1))
  );

  const offspring = createAgentGenome({
    name: `${capitalize(specialization)}Bot_v${generation}`,
    species,
    generation,
    parentGenomes: [parentA.genome_id, parentB.genome_id],
    traits: {
      tools,
      model_preference: modelPreference,
      temperature: +temperature.toFixed(3),
      risk_tolerance: +riskTolerance.toFixed(3),
    },
    specialization,
  });

  offspring.fitness_score = predictedFitness;

  return { offspring, mutations, predictedFitness };
}

/**
 * Apply a single mutation pass to a genome (in-place modification).
 */
export function mutateGenome(genome, mutationRate = 0.1) {
  const seed = `${genome.genome_id}:mutate:${Date.now()}`;
  const rng = seededRandom(seed);
  const mutations = [];

  // Temperature mutation
  if (rng() < mutationRate) {
    const oldTemp = genome.traits.temperature;
    genome.traits.temperature = mutate(oldTemp, mutationRate * 2, rng, 0, 1);
    genome.traits.temperature = +genome.traits.temperature.toFixed(3);
    mutations.push({
      generation: genome.generation,
      trait: 'temperature',
      from: oldTemp,
      to: genome.traits.temperature,
      impact: genome.traits.temperature < oldTemp ? '+precision' : '+exploration',
    });
  }

  // Risk tolerance mutation
  if (rng() < mutationRate) {
    const oldRisk = genome.traits.risk_tolerance;
    genome.traits.risk_tolerance = mutate(oldRisk, mutationRate * 2, rng, 0, 1);
    genome.traits.risk_tolerance = +genome.traits.risk_tolerance.toFixed(3);
    mutations.push({
      generation: genome.generation,
      trait: 'risk_tolerance',
      from: oldRisk,
      to: genome.traits.risk_tolerance,
      impact: genome.traits.risk_tolerance < oldRisk ? '+caution' : '+aggression',
    });
  }

  // Tool mutation: add or remove a tool
  if (rng() < mutationRate * 0.5) {
    const allPossibleTools = [
      'web_search', 'pdf_parse', 'stripe_payment', 'sql_query', 'data_viz',
      'invoice_generator', 'email_sender', 'calendar_manager', 'code_executor',
      'image_gen', 'summarizer', 'translator', 'sentiment_analysis',
    ];
    const newTool = allPossibleTools[Math.floor(rng() * allPossibleTools.length)];
    if (!genome.traits.tools.includes(newTool)) {
      genome.traits.tools.push(newTool);
      mutations.push({
        generation: genome.generation,
        trait: 'tools',
        from: `${genome.traits.tools.length - 1} tools`,
        to: `${genome.traits.tools.length} tools (+${newTool})`,
        impact: '+capability',
      });
    }
  }

  genome.last_evolved_at = new Date().toISOString();
  return mutations;
}

/**
 * Run a full evolution cycle on a population.
 */
export function evolve(population, pheromoneSignals = [], strategy = 'natural_selection') {
  if (population.length === 0) {
    return { evolved: 0, deprecated: 0, newOffspring: [], avgFitnessDelta: 0 };
  }

  // Sort by fitness
  const sorted = [...population].sort((a, b) => b.fitness_score - a.fitness_score);
  const avgFitnessBefore = sorted.reduce((s, g) => s + g.fitness_score, 0) / sorted.length;

  // Top 20% breed
  const topCount = Math.max(2, Math.ceil(sorted.length * 0.2));
  const topPerformers = sorted.slice(0, topCount);

  // Bottom 10% deprecated
  const bottomCount = Math.max(0, Math.floor(sorted.length * 0.1));
  const deprecated = sorted.slice(-bottomCount).filter(g => g.status === 'active');
  deprecated.forEach(g => { g.status = 'deprecated'; });

  // Breed top performers in pairs
  const newOffspring = [];
  for (let i = 0; i < topPerformers.length - 1 && newOffspring.length < 3; i += 2) {
    const result = crossbreed(topPerformers[i], topPerformers[i + 1], 0.15);
    newOffspring.push(result.offspring);
  }

  // Apply environmental pressure from pheromones
  if (strategy === 'directed' && pheromoneSignals.length > 0) {
    const topSignal = pheromoneSignals.sort((a, b) => b.opportunity_score - a.opportunity_score)[0];
    for (const offspring of newOffspring) {
      offspring.traits.specialization = topSignal.data.category;
    }
  }

  // Mutate surviving active agents
  let evolved = 0;
  for (const genome of sorted) {
    if (genome.status === 'active') {
      mutateGenome(genome, 0.05);
      evolved++;
    }
  }

  const allGenomes = [...sorted, ...newOffspring];
  const avgFitnessAfter = allGenomes
    .filter(g => g.status === 'active')
    .reduce((s, g) => s + g.fitness_score, 0) / allGenomes.filter(g => g.status === 'active').length || 0;

  return {
    evolved,
    deprecated: deprecated.length,
    newOffspring,
    avgFitnessDelta: Math.round(avgFitnessAfter - avgFitnessBefore),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function blend(a, b, ratio) {
  return a * ratio + b * (1 - ratio);
}

function mutate(value, rate, rng, min = 0, max = 1) {
  const delta = (rng() - 0.5) * 2 * rate;
  return Math.max(min, Math.min(max, value + delta));
}

function capitalize(s) {
  return s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}
