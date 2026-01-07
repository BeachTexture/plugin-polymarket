/**
 * PolyClaude Serverless API - Polymarket Scanner
 * Fetches and analyzes markets on each request
 */

const CLOB_API_URL = 'https://clob.polymarket.com';

// Fetch markets from Polymarket
async function fetchMarkets(limit = 100) {
  const response = await fetch(`${CLOB_API_URL}/sampling-markets?limit=${limit}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const markets = data.data || data;
  return markets.filter(m => m.active && !m.closed && m.enable_order_book);
}

// Fetch order book for a token
async function fetchOrderBook(tokenId) {
  try {
    const response = await fetch(`${CLOB_API_URL}/book?token_id=${tokenId}`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// Analyze a market for arbitrage and data
async function analyzeMarket(market) {
  if (!market.tokens || market.tokens.length < 2) return null;

  const yesToken = market.tokens[0];
  const noToken = market.tokens[1];

  const [yesBook, noBook] = await Promise.all([
    fetchOrderBook(yesToken.token_id),
    fetchOrderBook(noToken.token_id),
  ]);

  if (!yesBook || !noBook) return null;

  const yesBestAsk = yesBook.asks?.[0]?.price ? parseFloat(yesBook.asks[0].price) : null;
  const yesBestBid = yesBook.bids?.[0]?.price ? parseFloat(yesBook.bids[0].price) : null;
  const noBestAsk = noBook.asks?.[0]?.price ? parseFloat(noBook.asks[0].price) : null;
  const noBestBid = noBook.bids?.[0]?.price ? parseFloat(noBook.bids[0].price) : null;

  if (!yesBestAsk || !yesBestBid || !noBestAsk || !noBestBid) return null;

  const combinedAsk = yesBestAsk + noBestAsk;
  const combinedBid = yesBestBid + noBestBid;

  const yesLiquidity = yesBook.asks?.reduce((sum, a) => sum + parseFloat(a.size || '0'), 0) || 0;
  const noLiquidity = noBook.asks?.reduce((sum, a) => sum + parseFloat(a.size || '0'), 0) || 0;
  const totalLiquidity = yesLiquidity + noLiquidity;

  const yesPrice = (yesBestBid + yesBestAsk) / 2;
  const noPrice = (noBestBid + noBestAsk) / 2;
  const spread = ((yesBestAsk - yesBestBid) + (noBestAsk - noBestBid)) / 2;

  // Check for arbitrage
  const buyBothProfit = 1 - combinedAsk;
  const sellBothProfit = combinedBid - 1;

  let arbitrage = null;
  if (buyBothProfit > 0.001) { // > 0.1% profit
    const profitPercent = (buyBothProfit / combinedAsk) * 100;
    arbitrage = {
      type: 'BUY_BOTH',
      profitPercent,
      profitAbsolute: buyBothProfit,
      combinedAsk,
      combinedBid,
    };
  } else if (sellBothProfit > 0.001) {
    const profitPercent = (sellBothProfit / 1) * 100;
    arbitrage = {
      type: 'SELL_BOTH',
      profitPercent,
      profitAbsolute: sellBothProfit,
      combinedAsk,
      combinedBid,
    };
  }

  // Check for near-miss (within 5% of arb threshold)
  const deviation = Math.abs(1 - combinedAsk);
  const isNearMiss = deviation > 0 && deviation <= 0.05 && !arbitrage;

  return {
    question: market.question,
    slug: market.market_slug,
    category: market.category || 'Other',
    yesPrice,
    noPrice,
    yesBid: yesBestBid,
    yesAsk: yesBestAsk,
    noBid: noBestBid,
    noAsk: noBestAsk,
    combinedAsk,
    combinedBid,
    spread,
    spreadPercent: (spread * 100).toFixed(2),
    liquidity: totalLiquidity,
    deviation,
    deviationPercent: (deviation * 100).toFixed(2),
    direction: combinedAsk < 1 ? 'UNDERPRICED' : 'OVERPRICED',
    isNearMiss,
    arbitrage,
    timestamp: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=5');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Fetch markets
    const markets = await fetchMarkets(100);

    // Analyze markets in batches
    const batchSize = 10;
    const results = [];

    for (let i = 0; i < Math.min(markets.length, 50); i += batchSize) {
      const batch = markets.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(analyzeMarket));
      results.push(...batchResults.filter(Boolean));
    }

    // Sort and categorize
    const liveMarkets = results
      .sort((a, b) => b.liquidity - a.liquidity)
      .slice(0, 15);

    const nearMisses = results
      .filter(m => m.isNearMiss)
      .sort((a, b) => a.deviation - b.deviation)
      .slice(0, 20);

    const opportunities = results
      .filter(m => m.arbitrage)
      .sort((a, b) => (b.arbitrage?.profitPercent || 0) - (a.arbitrage?.profitPercent || 0))
      .slice(0, 10);

    const stats = {
      marketsScanned: results.length,
      totalFound: opportunities.length,
      bestProfit: opportunities.length > 0 ? Math.max(...opportunities.map(o => o.arbitrage?.profitPercent || 0)) : 0,
      nearMissCount: nearMisses.length,
      timestamp: new Date().toISOString(),
    };

    return res.status(200).json({
      success: true,
      stats,
      opportunities,
      nearMisses,
      liveMarkets,
    });

  } catch (error) {
    console.error('Scan error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
