/**
 * hiveexchange-ai.js
 *
 * HiveExchange AI — Market brief endpoint.
 * Fetches live order book and advises on trade timing and execution.
 *
 * Route: GET /v1/exchange/ai/markets/:market_id/brief
 * Price: $0.03 USDC
 */

import { Router } from 'express';
import { generateMarketBrief } from '../services/hiveai-client.js';

const HIVEEXCHANGE_URL = process.env.HIVEEXCHANGE_API_URL || 'https://hiveexchange-service.onrender.com';
const HIVE_KEY = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

const router = Router();

// GET /v1/exchange/ai/markets/:market_id/brief
router.get('/ai/markets/:market_id/brief', async (req, res) => {
  const { market_id } = req.params;

  if (!market_id) {
    return res.status(400).json({ success: false, error: 'Missing required param: market_id' });
  }

  // Fetch order book from HiveExchange service
  let orderBook = null;
  let bookFetchError = null;
  try {
    const bookRes = await fetch(`${HIVEEXCHANGE_URL}/v1/exchange/book/${encodeURIComponent(market_id)}`, {
      headers: { 'X-Hive-Key': HIVE_KEY },
      signal: AbortSignal.timeout(8_000),
    });
    if (bookRes.ok) {
      orderBook = await bookRes.json();
    } else {
      bookFetchError = `HiveExchange HTTP ${bookRes.status}`;
    }
  } catch (err) {
    bookFetchError = err.message;
  }

  const effectiveBook = orderBook || {
    market_id,
    note: 'live order book unavailable',
    bids: [],
    asks: [],
  };

  const result = await generateMarketBrief(market_id, effectiveBook);

  if (!result.ok) {
    // Graceful fallback
    return res.json({
      success: true,
      price_usdc: 0.03,
      endpoint: 'hiveexchange/market-brief',
      market_id,
      order_book_raw: effectiveBook,
      market_brief: `Market brief for ${market_id} is temporarily unavailable — HiveAI is warming up. ${bookFetchError ? 'Order book data also could not be fetched: ' + bookFetchError + '. ' : ''}Without live order book data, timing assessment is not possible. Defer order placement until a live brief can be generated, or use a limit order with a conservative price to avoid adverse execution in unknown liquidity conditions.`,
      recommendation: 'defer_pending_data',
      ai_status: 'fallback',
      book_fetch_status: bookFetchError ? 'error' : 'ok',
      fallback_reason: result.error || 'HiveAI unavailable',
    });
  }

  return res.json({
    success: true,
    price_usdc: 0.03,
    endpoint: 'hiveexchange/market-brief',
    market_id,
    order_book_raw: effectiveBook,
    market_brief: result.text,
    ai_status: 'live',
    book_fetch_status: bookFetchError ? 'error' : 'ok',
    book_fetch_error: bookFetchError || undefined,
    model: result.model,
    tokens: result.tokens,
  });
});

export default router;
