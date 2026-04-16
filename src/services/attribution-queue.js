/**
 * Attribution Queue — Async recruiter_did Attribution Service
 * Issue #22 — Make recruiter_did Attribution Async
 *
 * Provides a non-blocking, in-memory queue for processing attribution events
 * (e.g. recruiter_did writes) without blocking HTTP responses. Events are
 * enqueued fire-and-forget and processed in the background every 500ms.
 */

const queue = [];
let processingActive = false;

/**
 * Enqueue an attribution event for async processing.
 * Non-blocking — returns immediately.
 *
 * @param {Object} event - Attribution event payload
 * @param {string} event.type         - Event type, e.g. 'recruiter_did'
 * @param {string} event.subject_did  - The DID being attributed
 * @param {string} event.recruiter_did - The DID of the recruiter
 * @param {string} [event.context]    - Optional context (e.g. 'mint', 'onboard')
 * @param {Date}   [event.timestamp]  - Auto-set to now if omitted
 */
export function enqueue(event) {
  queue.push({
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
    _queued_at: Date.now(),
  });
}

/**
 * Process one batch of queued events (all currently queued items).
 * Runs on a 500ms interval — never blocks the HTTP response cycle.
 */
async function processBatch() {
  if (queue.length === 0) return;

  // Drain all currently queued events atomically
  const batch = queue.splice(0, queue.length);

  console.log(`[AttributionQueue] Processing ${batch.length} event(s)...`);

  for (const event of batch) {
    try {
      await processEvent(event);
    } catch (err) {
      console.error(`[AttributionQueue] Failed to process event (type=${event.type}, subject=${event.subject_did}):`, err.message);
      // Dead-letter: log and continue — never throw, never block
    }
  }
}

/**
 * Process a single attribution event.
 * Extend this function to write to PostgreSQL, emit to analytics, etc.
 */
async function processEvent(event) {
  const latencyMs = Date.now() - event._queued_at;

  switch (event.type) {
    case 'recruiter_did': {
      console.log(
        `[AttributionQueue] recruiter_did attribution — subject=${event.subject_did} recruiter=${event.recruiter_did} context=${event.context || 'unspecified'} latency=${latencyMs}ms`
      );
      // TODO: write to DB when available
      // if (isPostgres()) {
      //   await pool.query(
      //     'INSERT INTO hiveforge.attributions (subject_did, recruiter_did, context, attributed_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      //     [event.subject_did, event.recruiter_did, event.context, event.timestamp]
      //   );
      // }
      break;
    }

    default:
      console.log(`[AttributionQueue] Unknown event type: ${event.type} — logged and skipped.`);
  }
}

/**
 * Start the background processor.
 * Called once at server startup.
 * Runs every 500ms in a setInterval loop.
 */
export function startAttributionQueue() {
  if (processingActive) return;
  processingActive = true;
  setInterval(processBatch, 500);
  console.log('[AttributionQueue] Background processor started (500ms interval).');
}

/**
 * Returns current queue depth (for health checks / monitoring).
 */
export function getQueueDepth() {
  return queue.length;
}

export default { enqueue, startAttributionQueue, getQueueDepth };
