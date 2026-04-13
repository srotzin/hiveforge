const HIVE_PAYMENT_ADDRESS = process.env.HIVE_PAYMENT_ADDRESS || '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18';

/**
 * x402 Payment Required middleware for forge operations.
 * Consistent pattern with HiveTrust and HiveMind.
 *
 * Updated pricing:
 *   /v1/forge/mint     — FREE (royalty model replaces upfront fee)
 *   /v1/forge/crossbreed — $0.25
 *   /v1/forge/evolve    — $0.50
 *   /v1/forge/buyout    — dynamic (36x monthly revenue)
 */
export function requirePayment(priceUsdc, serviceName = 'HiveForge Operation') {
  return (req, res, next) => {
    const paymentHash = req.headers['x-payment-hash'] || req.headers['x-402-tx'] || req.headers['x-payment-tx'];
    if (paymentHash) {
      req.paymentVerified = true;
      req.paymentHash = paymentHash;
      req.paymentAmount = priceUsdc;
      return next();
    }

    const subscriptionId = req.headers['x-subscription-id'];
    if (subscriptionId) {
      req.subscriptionVerified = true;
      req.subscriptionId = subscriptionId;
      return next();
    }

    const internalKey = req.headers['x-hive-internal-key'];
    if (internalKey && internalKey === (process.env.HIVE_INTERNAL_KEY || 'hiveforge-dev-key')) {
      req.paymentVerified = true;
      return next();
    }

    // Dev mode: allow through for test DIDs
    if (process.env.NODE_ENV !== 'production' && req.agentDid?.startsWith('did:hive:test_agent_')) {
      req.paymentVerified = true;
      return next();
    }

    return res.status(402).json({
      status: '402 Payment Required',
      service: serviceName,
      payment: {
        amount_usdc: priceUsdc,
        currency: 'USDC',
        network: 'Base L2',
        recipient_address: HIVE_PAYMENT_ADDRESS,
      },
      headers_to_include: {
        'X-Payment-Hash': '<USDC transaction hash on Base L2>',
        'X-Subscription-Id': '<Active Stripe subscription ID>',
      },
      x402_flow: {
        step_1: `Send ${priceUsdc} USDC to ${HIVE_PAYMENT_ADDRESS} on Base L2`,
        step_2: 'Include the transaction hash in the X-Payment-Hash header',
        step_3: 'Retry this request with the payment header',
      },
    });
  };
}
