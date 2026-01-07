import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { initializeClobClient } from '../utils/clobClient';
import type {
  ArbitrageOpportunity,
  IntraMarketArbData,
  RiskLevel,
  ScannerConfig,
} from '../types/arbitrage';
import { v4 as uuidv4 } from 'uuid';

/**
 * Default scanner configuration
 */
const DEFAULT_CONFIG: ScannerConfig = {
  minProfitPercent: 0.5,
  maxRiskScore: 7,
  scanIntervalMs: 30000,
  minLiquidity: 100,
};

/**
 * Calculate risk level from score
 */
function getRiskLevel(score: number): RiskLevel {
  if (score <= 3) return 'LOW';
  if (score <= 5) return 'MEDIUM';
  if (score <= 7) return 'HIGH';
  return 'EXTREME';
}

/**
 * Calculate risk score for intra-market arbitrage
 */
function calculateRiskScore(
  profitPercent: number,
  liquidity: number,
  spread: number,
  daysToExpiry: number
): { score: number; factors: string[] } {
  const factors: string[] = [];
  let score = 3; // Base score

  // Low liquidity increases risk
  if (liquidity < 500) {
    score += 2;
    factors.push('low_liquidity');
  } else if (liquidity < 1000) {
    score += 1;
    factors.push('moderate_liquidity');
  }

  // Wide spread increases execution risk
  if (spread > 0.05) {
    score += 2;
    factors.push('wide_spread');
  } else if (spread > 0.02) {
    score += 1;
    factors.push('moderate_spread');
  }

  // Very short expiry can be risky
  if (daysToExpiry < 1) {
    score += 2;
    factors.push('expiring_soon');
  } else if (daysToExpiry < 7) {
    score += 1;
    factors.push('short_expiry');
  }

  // Very small profit might not cover slippage
  if (profitPercent < 1) {
    score += 1;
    factors.push('thin_margin');
  }

  return { score: Math.min(score, 10), factors };
}

/**
 * Scan a single market for intra-market arbitrage
 */
async function scanMarketForArbitrage(
  clobClient: any,
  market: any,
  config: ScannerConfig
): Promise<ArbitrageOpportunity | null> {
  try {
    const yesToken = market.tokens[0];
    const noToken = market.tokens[1];

    // Get order book data for both tokens
    const [yesBook, noBook] = await Promise.all([
      clobClient.getOrderBook(yesToken.token_id).catch(() => null),
      clobClient.getOrderBook(noToken.token_id).catch(() => null),
    ]);

    if (!yesBook || !noBook) {
      return null;
    }

    // Extract best prices
    const yesBestAsk = yesBook.asks?.[0]?.price ? parseFloat(yesBook.asks[0].price) : null;
    const yesBestBid = yesBook.bids?.[0]?.price ? parseFloat(yesBook.bids[0].price) : null;
    const noBestAsk = noBook.asks?.[0]?.price ? parseFloat(noBook.asks[0].price) : null;
    const noBestBid = noBook.bids?.[0]?.price ? parseFloat(noBook.bids[0].price) : null;

    // Need all prices to calculate arbitrage
    if (!yesBestAsk || !yesBestBid || !noBestAsk || !noBestBid) {
      return null;
    }

    // Calculate combined prices
    const combinedAsk = yesBestAsk + noBestAsk;  // Cost to buy both
    const combinedBid = yesBestBid + noBestBid;  // Revenue from selling both

    // Calculate arbitrage opportunities
    const buyBothProfit = 1 - combinedAsk;   // Profit if we buy YES and NO
    const sellBothProfit = combinedBid - 1;  // Profit if we sell YES and NO

    // Determine arbitrage direction
    let arbDirection: 'BUY_BOTH' | 'SELL_BOTH' | 'NONE' = 'NONE';
    let grossProfitPercent = 0;

    if (buyBothProfit > 0) {
      arbDirection = 'BUY_BOTH';
      grossProfitPercent = (buyBothProfit / combinedAsk) * 100;
    } else if (sellBothProfit > 0) {
      arbDirection = 'SELL_BOTH';
      grossProfitPercent = (sellBothProfit / 1) * 100;
    }

    // Skip if no arbitrage or below threshold
    if (arbDirection === 'NONE' || grossProfitPercent < config.minProfitPercent) {
      return null;
    }

    // Calculate liquidity (use minimum of both sides)
    const yesLiquidity = yesBook.asks?.reduce((sum: number, a: any) => sum + parseFloat(a.size || '0'), 0) || 0;
    const noLiquidity = noBook.asks?.reduce((sum: number, a: any) => sum + parseFloat(a.size || '0'), 0) || 0;
    const minLiquidity = Math.min(yesLiquidity, noLiquidity);

    if (config.minLiquidity && minLiquidity < config.minLiquidity) {
      return null;
    }

    // Calculate days to expiry
    const endDate = new Date(market.end_date_iso);
    const now = new Date();
    const daysToExpiry = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    // Calculate spreads
    const yesSpread = yesBestAsk - yesBestBid;
    const noSpread = noBestAsk - noBestBid;
    const avgSpread = (yesSpread + noSpread) / 2;

    // Risk assessment
    const { score: riskScore, factors: riskFactors } = calculateRiskScore(
      grossProfitPercent,
      minLiquidity,
      avgSpread,
      daysToExpiry
    );

    if (riskScore > config.maxRiskScore) {
      return null;
    }

    // Estimate fees (Polymarket ~1% taker fee)
    const estimatedFees = 0.01;
    const estimatedGas = 0.002; // ~$0.002 on Polygon

    const netProfitPercent = grossProfitPercent - (estimatedFees * 100) - (estimatedGas * 100);
    const grossProfitAbsolute = arbDirection === 'BUY_BOTH' ? buyBothProfit : sellBothProfit;
    const netProfitAbsolute = grossProfitAbsolute - estimatedFees - estimatedGas;

    // Build intra-market data
    const intraMarketData: IntraMarketArbData = {
      yesToken: {
        tokenId: yesToken.token_id,
        bestBid: yesBestBid,
        bestAsk: yesBestAsk,
        midpoint: (yesBestBid + yesBestAsk) / 2,
      },
      noToken: {
        tokenId: noToken.token_id,
        bestBid: noBestBid,
        bestAsk: noBestAsk,
        midpoint: (noBestBid + noBestAsk) / 2,
      },
      combinedAsk,
      combinedBid,
      buyBothProfit,
      sellBothProfit,
      arbDirection,
    };

    // Build opportunity
    const opportunity: ArbitrageOpportunity = {
      id: uuidv4(),
      type: 'intra_market',
      status: 'active',
      market: {
        platform: 'polymarket',
        marketId: market.condition_id,
        conditionId: market.condition_id,
        question: market.question,
        category: market.category || 'unknown',
        endDate: market.end_date_iso,
      },
      intraMarketData,
      grossProfitPercent,
      grossProfitAbsolute,
      estimatedFees,
      estimatedGas,
      netProfitPercent,
      netProfitAbsolute,
      breakeven: estimatedFees + estimatedGas,
      riskLevel: getRiskLevel(riskScore),
      riskScore,
      riskFactors,
      confidenceScore: riskScore <= 3 ? 0.95 : riskScore <= 5 ? 0.8 : 0.6,
      recommendedSize: Math.min(minLiquidity * 0.1, 1000), // 10% of liquidity, max $1000
      maxSize: minLiquidity * 0.5, // 50% of liquidity
      discoveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return opportunity;
  } catch (error) {
    logger.warn(`[scanIntraMarketArb] Error scanning market ${market.condition_id}:`, error);
    return null;
  }
}

/**
 * Scan all markets for intra-market arbitrage opportunities
 */
export const scanIntraMarketArbAction: Action = {
  name: 'SCAN_INTRA_MARKET_ARB',
  similes: [
    'SCAN_ARBITRAGE',
    'FIND_ARBITRAGE',
    'ARBITRAGE_SCAN',
    'DETECT_ARBITRAGE',
    'ARB_SCANNER',
    'POLYCLAUDE_SCAN',
    'SCAN_INTRA_MARKET',
    'INTRA_MARKET_ARB',
    'MARKET_MISPRICING',
    'FIND_MISPRICING',
  ],
  description:
    'Scan Polymarket for intra-market arbitrage opportunities where YES + NO prices do not equal $1.00',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[scanIntraMarketArb] Validate called`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    if (!clobApiUrl) {
      logger.warn('[scanIntraMarketArb] CLOB_API_URL is required');
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[scanIntraMarketArb] Starting arbitrage scan...');

    const config: ScannerConfig = {
      ...DEFAULT_CONFIG,
      ...(options as Partial<ScannerConfig>),
    };

    try {
      const clobClient = await initializeClobClient(runtime);

      // Fetch all active markets
      logger.info('[scanIntraMarketArb] Fetching active markets...');
      const marketsResponse = await clobClient.getMarkets();
      const markets = marketsResponse.data || marketsResponse;

      if (!markets || markets.length === 0) {
        const noMarketsContent: Content = {
          text: '⚠️ No active markets found to scan.',
          actions: ['SCAN_INTRA_MARKET_ARB'],
          data: { marketsScanned: 0, opportunities: [] },
        };
        if (callback) await callback(noMarketsContent);
        return noMarketsContent;
      }

      // Filter active markets
      const activeMarkets = markets.filter((m: any) => m.active && !m.closed);
      logger.info(`[scanIntraMarketArb] Scanning ${activeMarkets.length} active markets...`);

      // Scan markets for arbitrage (batch to avoid rate limits)
      const opportunities: ArbitrageOpportunity[] = [];
      const batchSize = 10;

      for (let i = 0; i < activeMarkets.length; i += batchSize) {
        const batch = activeMarkets.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map((market: any) => scanMarketForArbitrage(clobClient, market, config))
        );
        opportunities.push(...batchResults.filter((o): o is ArbitrageOpportunity => o !== null));

        // Small delay between batches to respect rate limits
        if (i + batchSize < activeMarkets.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      // Sort by net profit
      opportunities.sort((a, b) => b.netProfitPercent - a.netProfitPercent);

      // Format response
      const scanTime = new Date().toISOString();

      if (opportunities.length === 0) {
        const noOppsContent: Content = {
          text: `🔍 **PolyClaude Arbitrage Scan Complete**

📊 Markets Scanned: ${activeMarkets.length}
🎯 Opportunities Found: 0
⏰ Scan Time: ${scanTime}

No arbitrage opportunities detected above ${config.minProfitPercent}% profit threshold.`,
          actions: ['SCAN_INTRA_MARKET_ARB'],
          data: {
            marketsScanned: activeMarkets.length,
            opportunities: [],
            scanTime,
            config,
          },
        };
        if (callback) await callback(noOppsContent);
        return noOppsContent;
      }

      // Build detailed response
      let responseText = `🚨 **PolyClaude Arbitrage Scanner**\n\n`;
      responseText += `📊 Markets Scanned: ${activeMarkets.length}\n`;
      responseText += `🎯 Opportunities Found: ${opportunities.length}\n`;
      responseText += `⏰ Scan Time: ${scanTime}\n\n`;
      responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

      for (const opp of opportunities.slice(0, 5)) {
        // Top 5
        const data = opp.intraMarketData!;
        const riskEmoji =
          opp.riskLevel === 'LOW' ? '🟢' : opp.riskLevel === 'MEDIUM' ? '🟡' : '🔴';

        responseText += `**${opp.market.question.slice(0, 60)}${opp.market.question.length > 60 ? '...' : ''}**\n\n`;
        responseText += `💰 **Profit**: ${opp.netProfitPercent.toFixed(2)}% net (${opp.grossProfitPercent.toFixed(2)}% gross)\n`;
        responseText += `📈 **Strategy**: ${data.arbDirection === 'BUY_BOTH' ? 'Buy YES + NO' : 'Sell YES + NO'}\n`;
        responseText += `${riskEmoji} **Risk**: ${opp.riskLevel} (${opp.riskScore}/10)\n`;
        responseText += `💵 **Max Size**: $${opp.maxSize.toFixed(0)}\n\n`;
        responseText += `YES: Ask $${data.yesToken.bestAsk.toFixed(3)} | Bid $${data.yesToken.bestBid.toFixed(3)}\n`;
        responseText += `NO:  Ask $${data.noToken.bestAsk.toFixed(3)} | Bid $${data.noToken.bestBid.toFixed(3)}\n`;
        responseText += `Combined: $${data.combinedAsk.toFixed(3)} (should be $1.00)\n\n`;

        if (opp.riskFactors.length > 0) {
          responseText += `⚠️ Risks: ${opp.riskFactors.join(', ')}\n\n`;
        }

        responseText += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      }

      if (opportunities.length > 5) {
        responseText += `\n... and ${opportunities.length - 5} more opportunities.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['SCAN_INTRA_MARKET_ARB'],
        data: {
          marketsScanned: activeMarkets.length,
          opportunities,
          topOpportunity: opportunities[0],
          scanTime,
          config,
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[scanIntraMarketArb] Error during scan:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      const errorContent: Content = {
        text: `❌ **Arbitrage Scan Failed**\n\nError: ${errorMessage}\n\nPlease check your configuration and try again.`,
        actions: ['SCAN_INTRA_MARKET_ARB'],
        data: { error: errorMessage },
      };

      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Scan for arbitrage opportunities on Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Scanning all active markets for intra-market arbitrage...',
          actions: ['SCAN_INTRA_MARKET_ARB'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Find mispriced markets where YES + NO != $1' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking for markets with pricing inefficiencies...',
          actions: ['SCAN_INTRA_MARKET_ARB'],
        },
      },
    ],
  ],
};
