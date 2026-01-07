/**
 * PolyClaude Arbitrage Hunter Service
 * Main service that coordinates scanning, alerting, and the web interface
 */

import { Service, type IAgentRuntime, logger } from '@elizaos/core';
import { TelegramBotService, createTelegramBot } from './telegramBot';
import { TerminalServer, createTerminalServer } from './terminalServer';
import { initializeClobClient } from '../utils/clobClient';
import type {
  ArbitrageOpportunity,
  IntraMarketArbData,
  RiskLevel,
  ScannerConfig,
  ScannerStats,
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
 * Calculate risk score
 */
function calculateRiskScore(
  profitPercent: number,
  liquidity: number,
  spread: number,
  daysToExpiry: number
): { score: number; factors: string[] } {
  const factors: string[] = [];
  let score = 3;

  if (liquidity < 500) {
    score += 2;
    factors.push('low_liquidity');
  } else if (liquidity < 1000) {
    score += 1;
    factors.push('moderate_liquidity');
  }

  if (spread > 0.05) {
    score += 2;
    factors.push('wide_spread');
  } else if (spread > 0.02) {
    score += 1;
    factors.push('moderate_spread');
  }

  if (daysToExpiry < 1) {
    score += 2;
    factors.push('expiring_soon');
  } else if (daysToExpiry < 7) {
    score += 1;
    factors.push('short_expiry');
  }

  if (profitPercent < 1) {
    score += 1;
    factors.push('thin_margin');
  }

  return { score: Math.min(score, 10), factors };
}

/**
 * PolyClaude Arbitrage Hunter Service
 */
export class PolyClaudeService extends Service {
  static serviceType = 'polyclaude';
  capabilityDescription =
    'PolyClaude Arbitrage Hunter - Scans markets for arbitrage opportunities and sends alerts via Telegram and web interface.';

  private runtime: IAgentRuntime;
  private config: ScannerConfig;
  private telegramBot: TelegramBotService | null = null;
  private terminalServer: TerminalServer | null = null;
  private scanInterval: NodeJS.Timeout | null = null;
  private isScanning: boolean = false;
  private stats: ScannerStats;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.runtime = runtime;
    this.config = { ...DEFAULT_CONFIG };
    this.stats = {
      totalScans: 0,
      totalOpportunitiesFound: 0,
      activeOpportunities: 0,
      totalProfitCaptured: 0,
      lastScanAt: '',
      uptime: Date.now(),
      marketsScanned: 0,
    };
  }

  /**
   * Start the service
   */
  static async start(runtime: IAgentRuntime): Promise<PolyClaudeService> {
    logger.info('[PolyClaude] Starting PolyClaude Arbitrage Hunter...');

    const service = new PolyClaudeService(runtime);

    // Initialize Telegram bot
    service.telegramBot = createTelegramBot();
    if (service.telegramBot) {
      logger.info('[PolyClaude] Telegram bot initialized');
      await service.telegramBot.sendTestMessage().catch(() => {
        logger.warn('[PolyClaude] Could not send Telegram test message');
      });
    }

    // Initialize terminal server
    const webPort = parseInt(process.env.POLYCLAUDE_WEB_PORT || '3333', 10);
    service.terminalServer = createTerminalServer(webPort);
    await service.terminalServer.start();
    logger.info(`[PolyClaude] Terminal server running at http://localhost:${service.terminalServer.getPort()}`);

    // Start auto-scanning if enabled
    const autoScan = process.env.POLYCLAUDE_AUTO_SCAN !== 'false';
    if (autoScan) {
      service.startAutoScan();
    }

    return service;
  }

  /**
   * Stop the service
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('[PolyClaude] Stopping PolyClaude service...');
    const service = runtime.getService(PolyClaudeService.serviceType) as PolyClaudeService;
    if (service) {
      await service.stop();
    }
  }

  /**
   * Stop instance
   */
  async stop(): Promise<void> {
    this.stopAutoScan();
    if (this.terminalServer) {
      await this.terminalServer.stop();
    }
    logger.info('[PolyClaude] Service stopped');
  }

  /**
   * Start automatic scanning
   */
  startAutoScan(): void {
    if (this.scanInterval) {
      logger.warn('[PolyClaude] Auto-scan already running');
      return;
    }

    logger.info(`[PolyClaude] Starting auto-scan every ${this.config.scanIntervalMs}ms`);

    // Run initial scan
    this.runScan().catch((err) => logger.error('[PolyClaude] Initial scan error:', err));

    // Set up interval
    this.scanInterval = setInterval(() => {
      this.runScan().catch((err) => logger.error('[PolyClaude] Scan error:', err));
    }, this.config.scanIntervalMs);
  }

  /**
   * Stop automatic scanning
   */
  stopAutoScan(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
      logger.info('[PolyClaude] Auto-scan stopped');
    }
  }

  /**
   * Run a single scan
   */
  async runScan(): Promise<ArbitrageOpportunity[]> {
    if (this.isScanning) {
      logger.warn('[PolyClaude] Scan already in progress, skipping');
      return [];
    }

    this.isScanning = true;
    this.terminalServer?.setScanning(true);

    try {
      logger.info('[PolyClaude] Starting arbitrage scan...');
      const clobClient = await initializeClobClient(this.runtime);

      // Fetch markets
      const marketsResponse = await clobClient.getMarkets();
      const markets = marketsResponse.data || marketsResponse;

      if (!markets || markets.length === 0) {
        logger.warn('[PolyClaude] No markets found');
        return [];
      }

      const activeMarkets = markets.filter((m: any) => m.active && !m.closed);
      logger.info(`[PolyClaude] Scanning ${activeMarkets.length} active markets`);

      // Scan for opportunities
      const opportunities: ArbitrageOpportunity[] = [];
      const batchSize = 10;

      for (let i = 0; i < activeMarkets.length; i += batchSize) {
        const batch = activeMarkets.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map((market: any) => this.scanMarket(clobClient, market))
        );
        opportunities.push(...results.filter((o): o is ArbitrageOpportunity => o !== null));

        if (i + batchSize < activeMarkets.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      // Sort by profit
      opportunities.sort((a, b) => b.netProfitPercent - a.netProfitPercent);

      // Update stats
      this.stats.totalScans++;
      this.stats.marketsScanned = activeMarkets.length;
      this.stats.lastScanAt = new Date().toISOString();
      this.stats.totalOpportunitiesFound += opportunities.length;
      this.stats.activeOpportunities = opportunities.length;

      // Update terminal server
      if (this.terminalServer) {
        this.terminalServer.updateStats(this.stats);
        this.terminalServer.addAlerts(opportunities);
      }

      // Send Telegram alerts for significant opportunities
      if (this.telegramBot && opportunities.length > 0) {
        const significantOpps = opportunities.filter((o) => o.netProfitPercent >= 1);
        for (const opp of significantOpps.slice(0, 3)) {
          await this.telegramBot.sendArbitrageAlert(opp);
        }
      }

      logger.info(`[PolyClaude] Scan complete: ${opportunities.length} opportunities found`);
      return opportunities;
    } catch (error) {
      logger.error('[PolyClaude] Scan error:', error);
      return [];
    } finally {
      this.isScanning = false;
      this.terminalServer?.setScanning(false);
    }
  }

  /**
   * Scan a single market for arbitrage
   */
  private async scanMarket(clobClient: any, market: any): Promise<ArbitrageOpportunity | null> {
    try {
      const yesToken = market.tokens[0];
      const noToken = market.tokens[1];

      const [yesBook, noBook] = await Promise.all([
        clobClient.getOrderBook(yesToken.token_id).catch(() => null),
        clobClient.getOrderBook(noToken.token_id).catch(() => null),
      ]);

      if (!yesBook || !noBook) return null;

      const yesBestAsk = yesBook.asks?.[0]?.price ? parseFloat(yesBook.asks[0].price) : null;
      const yesBestBid = yesBook.bids?.[0]?.price ? parseFloat(yesBook.bids[0].price) : null;
      const noBestAsk = noBook.asks?.[0]?.price ? parseFloat(noBook.asks[0].price) : null;
      const noBestBid = noBook.bids?.[0]?.price ? parseFloat(noBook.bids[0].price) : null;

      if (!yesBestAsk || !yesBestBid || !noBestAsk || !noBestBid) return null;

      const combinedAsk = yesBestAsk + noBestAsk;
      const combinedBid = yesBestBid + noBestBid;

      const buyBothProfit = 1 - combinedAsk;
      const sellBothProfit = combinedBid - 1;

      let arbDirection: 'BUY_BOTH' | 'SELL_BOTH' | 'NONE' = 'NONE';
      let grossProfitPercent = 0;

      if (buyBothProfit > 0) {
        arbDirection = 'BUY_BOTH';
        grossProfitPercent = (buyBothProfit / combinedAsk) * 100;
      } else if (sellBothProfit > 0) {
        arbDirection = 'SELL_BOTH';
        grossProfitPercent = (sellBothProfit / 1) * 100;
      }

      if (arbDirection === 'NONE' || grossProfitPercent < this.config.minProfitPercent) {
        return null;
      }

      const yesLiquidity =
        yesBook.asks?.reduce((sum: number, a: any) => sum + parseFloat(a.size || '0'), 0) || 0;
      const noLiquidity =
        noBook.asks?.reduce((sum: number, a: any) => sum + parseFloat(a.size || '0'), 0) || 0;
      const minLiquidity = Math.min(yesLiquidity, noLiquidity);

      if (this.config.minLiquidity && minLiquidity < this.config.minLiquidity) {
        return null;
      }

      const endDate = new Date(market.end_date_iso);
      const daysToExpiry = (endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

      const yesSpread = yesBestAsk - yesBestBid;
      const noSpread = noBestAsk - noBestBid;
      const avgSpread = (yesSpread + noSpread) / 2;

      const { score: riskScore, factors: riskFactors } = calculateRiskScore(
        grossProfitPercent,
        minLiquidity,
        avgSpread,
        daysToExpiry
      );

      if (riskScore > this.config.maxRiskScore) return null;

      const estimatedFees = 0.01;
      const estimatedGas = 0.002;
      const netProfitPercent = grossProfitPercent - estimatedFees * 100 - estimatedGas * 100;
      const grossProfitAbsolute = arbDirection === 'BUY_BOTH' ? buyBothProfit : sellBothProfit;
      const netProfitAbsolute = grossProfitAbsolute - estimatedFees - estimatedGas;

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

      return {
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
        recommendedSize: Math.min(minLiquidity * 0.1, 1000),
        maxSize: minLiquidity * 0.5,
        discoveredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Get current stats
   */
  getStats(): ScannerStats {
    return this.stats;
  }

  /**
   * Get terminal server URL
   */
  getTerminalUrl(): string | null {
    return this.terminalServer ? `http://localhost:${this.terminalServer.getPort()}` : null;
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ScannerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('[PolyClaude] Config updated:', this.config);
  }

  /**
   * Manual trigger for Telegram test
   */
  async testTelegram(): Promise<boolean> {
    if (!this.telegramBot) {
      logger.warn('[PolyClaude] Telegram not configured');
      return false;
    }
    return this.telegramBot.sendTestMessage();
  }
}
