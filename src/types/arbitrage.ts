/**
 * PolyClaude Arbitrage Hunter - Type Definitions
 */

/**
 * Types of arbitrage opportunities
 */
export type ArbitrageType =
  | 'intra_market'      // YES + NO != $1.00
  | 'cross_platform'    // Same market, different platforms
  | 'correlated'        // Related markets with inconsistent pricing
  | 'spread';           // Wide bid-ask spreads

/**
 * Risk level classification
 */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

/**
 * Opportunity status
 */
export type OpportunityStatus =
  | 'active'            // Currently available
  | 'executing'         // Trade in progress
  | 'executed'          // Successfully captured
  | 'expired'           // No longer available
  | 'missed';           // Was available but not captured

/**
 * Market side in an arbitrage opportunity
 */
export interface ArbMarketSide {
  platform: string;
  marketId: string;
  conditionId: string;
  question: string;
  tokenId: string;
  side: 'YES' | 'NO';
  price: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  liquidity: number;
  volume24h?: number;
}

/**
 * Intra-market arbitrage specific data
 * When YES price + NO price < 1.00, buy both for guaranteed profit
 * When YES price + NO price > 1.00, sell both (if you have positions)
 */
export interface IntraMarketArbData {
  yesToken: {
    tokenId: string;
    bestBid: number;
    bestAsk: number;
    midpoint: number;
  };
  noToken: {
    tokenId: string;
    bestBid: number;
    bestAsk: number;
    midpoint: number;
  };
  // Combined prices
  combinedAsk: number;      // Cost to buy YES + NO
  combinedBid: number;      // Revenue from selling YES + NO
  // Arbitrage calculations
  buyBothProfit: number;    // Profit if buying both (when combinedAsk < 1)
  sellBothProfit: number;   // Profit if selling both (when combinedBid > 1)
  arbDirection: 'BUY_BOTH' | 'SELL_BOTH' | 'NONE';
}

/**
 * Core arbitrage opportunity structure
 */
export interface ArbitrageOpportunity {
  id: string;
  type: ArbitrageType;
  status: OpportunityStatus;

  // Market information
  market: {
    platform: string;
    marketId: string;
    conditionId: string;
    question: string;
    category: string;
    endDate: string;
  };

  // Type-specific data
  intraMarketData?: IntraMarketArbData;

  // Profit analysis
  grossProfitPercent: number;
  grossProfitAbsolute: number;  // Per $1 position
  estimatedFees: number;
  estimatedGas: number;
  netProfitPercent: number;
  netProfitAbsolute: number;
  breakeven: number;

  // Risk assessment
  riskLevel: RiskLevel;
  riskScore: number;            // 1-10
  riskFactors: string[];
  confidenceScore: number;      // 0-1, how confident we are this is real

  // Execution recommendations
  recommendedSize: number;
  maxSize: number;              // Limited by liquidity

  // Claude's analysis
  claudeAnalysis?: string;

  // Timestamps
  discoveredAt: string;
  updatedAt: string;
  expiresAt?: string;
  executedAt?: string;
}

/**
 * Scanner configuration
 */
export interface ScannerConfig {
  minProfitPercent: number;     // Minimum profit to report (e.g., 0.5%)
  maxRiskScore: number;         // Maximum risk to report (1-10)
  scanIntervalMs: number;       // How often to scan
  includeCategories?: string[]; // Filter by category
  excludeCategories?: string[]; // Exclude categories
  minLiquidity?: number;        // Minimum liquidity threshold
}

/**
 * Alert configuration
 */
export interface AlertConfig {
  enabled: boolean;
  telegramEnabled: boolean;
  telegramChatId?: string;
  telegramBotToken?: string;
  webInterfaceEnabled: boolean;
  webInterfacePort?: number;
  minProfitForAlert: number;    // Minimum profit % to trigger alert
  maxRiskForAlert: number;      // Maximum risk score to alert on
  alertCooldownMs: number;      // Prevent spam for same opportunity
}

/**
 * Alert message structure
 */
export interface ArbitrageAlert {
  id: string;
  opportunity: ArbitrageOpportunity;
  timestamp: string;
  formattedMessage: string;
  terminalOutput: string;       // ANSI-colored terminal output
  telegramMessage: string;      // Telegram-formatted message
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

/**
 * Scanner statistics
 */
export interface ScannerStats {
  totalScans: number;
  totalOpportunitiesFound: number;
  activeOpportunities: number;
  totalProfitCaptured: number;
  lastScanAt: string;
  uptime: number;
  marketsScanned: number;
}

/**
 * Web interface state
 */
export interface TerminalState {
  alerts: ArbitrageAlert[];
  stats: ScannerStats;
  isScanning: boolean;
  lastUpdate: string;
  config: ScannerConfig;
}
