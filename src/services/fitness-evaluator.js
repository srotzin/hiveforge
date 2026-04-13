/**
 * Fitness Evaluator — Revenue-based fitness scoring for agent genomes.
 *
 * Formula: (revenue * 0.4) + (task_success_rate * 0.3) + (survival_days * 0.2) + (memory_nodes * 0.1)
 * Scale: 0–1000
 */

/**
 * Calculate fitness score for a genome.
 */
export function calculateFitness(genome) {
  const revenueScore = Math.min(400, genome.revenue_generated_usdc * 0.32);

  const totalTasks = genome.tasks_completed + genome.tasks_failed;
  const successRate = totalTasks > 0 ? genome.tasks_completed / totalTasks : 0.5;
  const taskScore = successRate * 300;

  const mintedAt = new Date(genome.minted_at).getTime();
  const survivalDays = Math.max(0, (Date.now() - mintedAt) / 86400000);
  const survivalScore = Math.min(200, survivalDays * 2);

  const memoryScore = Math.min(100, genome.hivemind_memory_nodes * 2.5);

  return Math.round(revenueScore + taskScore + survivalScore + memoryScore);
}

/**
 * Evaluate the entire population and update fitness scores.
 */
export function evaluatePopulation(genomes) {
  const results = [];

  for (const genome of genomes) {
    const oldFitness = genome.fitness_score;
    const newFitness = calculateFitness(genome);
    genome.fitness_score = newFitness;
    genome.survival_rate = genome.tasks_completed + genome.tasks_failed > 0
      ? +(genome.tasks_completed / (genome.tasks_completed + genome.tasks_failed)).toFixed(4)
      : 1.0;

    results.push({
      genome_id: genome.genome_id,
      old_fitness: oldFitness,
      new_fitness: newFitness,
      delta: newFitness - oldFitness,
    });
  }

  return results;
}

/**
 * Predict fitness for offspring based on parent lineage.
 */
export function predictFitness(parentA, parentB) {
  const parentAvg = (parentA.fitness_score + parentB.fitness_score) / 2;
  // Genetic vigor bonus: offspring of different species get a small boost
  const vigorBonus = parentA.species !== parentB.species ? 25 : 0;
  // Generation penalty: diminishing returns at high generations
  const genPenalty = Math.max(parentA.generation, parentB.generation) * 2;

  return Math.round(Math.max(0, Math.min(1000, parentAvg + vigorBonus - genPenalty)));
}

/**
 * Get population health metrics.
 */
export function getPopulationHealth(genomes) {
  const active = genomes.filter(g => g.status === 'active');
  if (active.length === 0) {
    return {
      diversity_index: 0,
      avg_survival_rate: 0,
      avg_fitness: 0,
      revenue_per_agent_usdc: 0,
      genetic_variance: 0,
    };
  }

  // Species diversity (Simpson's diversity index)
  const speciesCounts = {};
  for (const g of active) {
    speciesCounts[g.species] = (speciesCounts[g.species] || 0) + 1;
  }
  const n = active.length;
  let simpsonD = 0;
  for (const count of Object.values(speciesCounts)) {
    simpsonD += (count / n) * (count / n);
  }
  const diversityIndex = n > 1 ? +(1 - simpsonD).toFixed(4) : 0;

  const avgSurvival = +(active.reduce((s, g) => s + g.survival_rate, 0) / active.length).toFixed(4);
  const avgFitness = Math.round(active.reduce((s, g) => s + g.fitness_score, 0) / active.length);
  const totalRevenue = active.reduce((s, g) => s + g.revenue_generated_usdc, 0);
  const revenuePerAgent = +(totalRevenue / active.length).toFixed(2);

  // Genetic variance (temperature spread)
  const temps = active.map(g => g.traits.temperature);
  const avgTemp = temps.reduce((s, t) => s + t, 0) / temps.length;
  const variance = +(temps.reduce((s, t) => s + (t - avgTemp) ** 2, 0) / temps.length).toFixed(6);

  return {
    diversity_index: diversityIndex,
    avg_survival_rate: avgSurvival,
    avg_fitness: avgFitness,
    revenue_per_agent_usdc: revenuePerAgent,
    genetic_variance: variance,
  };
}
