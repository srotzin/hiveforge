import { getAllGenomes, getActiveGenomes, recordEvolutionCycle } from './agent-foundry.js';
import { evaluatePopulation, getPopulationHealth } from './fitness-evaluator.js';
import { scanPheromones } from './pheromone-scanner.js';
import { evolve } from './genetic-engine.js';

/**
 * Lifecycle Manager — tracks birth/death/evolution events,
 * runs periodic fitness evaluations and optional auto-evolution.
 */
class LifecycleManager {
  constructor() {
    this.timer = null;
    this.running = false;
    this.cycleCount = 0;
    this.lastCycleAt = null;
    this.events = [];
  }

  start(intervalMs = 120_000) {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.cycle(), intervalMs);
    // Initial evaluation after 5 seconds
    setTimeout(() => this.cycle(), 5000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  async cycle() {
    try {
      this.cycleCount++;
      this.lastCycleAt = new Date().toISOString();

      // 1. Re-evaluate fitness for all genomes
      const allGenomes = await getAllGenomes();
      const fitnessResults = await evaluatePopulation(allGenomes);

      // 2. Scan for pheromone signals
      const signals = await scanPheromones();

      // 3. Log events
      this.events.push({
        cycle: this.cycleCount,
        timestamp: this.lastCycleAt,
        population_size: allGenomes.length,
        active: allGenomes.filter(g => g.status === 'active').length,
        fitness_evaluations: fitnessResults.length,
        pheromone_signals: signals.length,
      });

      // Keep only last 100 events
      if (this.events.length > 100) this.events = this.events.slice(-100);
    } catch (err) {
      console.error('Lifecycle cycle error:', err.message);
    }
  }

  getStatus() {
    return {
      daemon: 'lifecycle-manager',
      running: this.running,
      cycle_count: this.cycleCount,
      last_cycle_at: this.lastCycleAt,
      recent_events: this.events.slice(-5),
    };
  }
}

const lifecycleManager = new LifecycleManager();
export default lifecycleManager;
