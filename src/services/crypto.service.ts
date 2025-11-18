import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { webhookService } from './webhook.service';
import { cacheGet, cacheSet } from '../database/redis';
import {
  CryptoPayment,
  CreateCryptoPaymentInput,
  CryptoWallet,
  CryptoExchangeRate,
  CryptoCurrency,
  CryptoNetwork,
  CryptoPaymentStatus,
} from '../types';

// Network configurations
const NETWORK_CONFIG: Record<CryptoNetwork, {
  confirmations: number;
  blockTime: number; // seconds
  currencies: CryptoCurrency[];
}> = {
  bitcoin: { confirmations: 3, blockTime: 600, currencies: ['BTC'] },
  ethereum: { confirmations: 12, blockTime: 12, currencies: ['ETH', 'USDT', 'USDC', 'DAI'] },
  polygon: { confirmations: 128, blockTime: 2, currencies: ['USDT', 'USDC', 'DAI'] },
  solana: { confirmations: 32, blockTime: 0.4, currencies: ['USDT', 'USDC'] },
  tron: { confirmations: 20, blockTime: 3, currencies: ['USDT', 'USDC'] },
  bsc: { confirmations: 15, blockTime: 3, currencies: ['BUSD', 'USDT', 'USDC'] },
};

// Stablecoin precision
const CRYPTO_DECIMALS: Record<CryptoCurrency, number> = {
  BTC: 8,
  ETH: 18,
  USDT: 6,
  USDC: 6,
  DAI: 18,
  BUSD: 18,
};

export class CryptoService {
  private priceApiUrl = 'https://api.coingecko.com/api/v3';

  async createPayment(merchantId: string, input: CreateCryptoPaymentInput): Promise<CryptoPayment> {
    const {
      amount,
      currency,
      cryptocurrency,
      network = this.getDefaultNetwork(cryptocurrency),
      customerId,
      description,
      metadata = {},
      expirationMinutes = 30,
    } = input;

    // Validate network supports cryptocurrency
    if (!NETWORK_CONFIG[network].currencies.includes(cryptocurrency)) {
      throw new Error(`${cryptocurrency} is not supported on ${network}`);
    }

    // Get exchange rate
    const exchangeRate = await this.getExchangeRate(cryptocurrency, currency);

    // Calculate crypto amount
    const cryptoAmount = this.calculateCryptoAmount(amount, exchangeRate, cryptocurrency);

    // Get or generate wallet address
    const walletAddress = await this.getPaymentAddress(merchantId, network, cryptocurrency);

    // Create transaction record first
    const transactionId = uuidv4();
    await query(
      `INSERT INTO transactions (id, merchant_id, customer_id, type, status, amount, currency, fee, net_amount, description, metadata)
       VALUES ($1, $2, $3, 'charge', 'pending', $4, $5, 0, $4, $6, $7)`,
      [transactionId, merchantId, customerId, amount, currency, description, JSON.stringify(metadata)]
    );

    // Create crypto payment
    const paymentId = uuidv4();
    const expiresAt = new Date(Date.now() + expirationMinutes * 60 * 1000);

    const result = await query<any>(
      `INSERT INTO crypto_payments (
        id, merchant_id, customer_id, transaction_id, status, cryptocurrency, network,
        amount, crypto_amount, exchange_rate, wallet_address, required_confirmations,
        expires_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        paymentId, merchantId, customerId, transactionId, 'pending', cryptocurrency, network,
        amount, cryptoAmount, exchangeRate, walletAddress,
        NETWORK_CONFIG[network].confirmations, expiresAt, JSON.stringify(metadata),
      ]
    );

    const payment = this.mapCryptoPayment(result.rows[0]);

    // Send webhook
    await webhookService.send(merchantId, 'crypto.payment.pending' as any, { payment });

    logger.info('Crypto payment created', {
      paymentId,
      cryptocurrency,
      network,
      amount: cryptoAmount,
    });

    return payment;
  }

  async getPayment(paymentId: string, merchantId: string): Promise<CryptoPayment> {
    const result = await query<any>(
      'SELECT * FROM crypto_payments WHERE id = $1 AND merchant_id = $2',
      [paymentId, merchantId]
    );

    if (result.rows.length === 0) {
      throw new Error('Crypto payment not found');
    }

    return this.mapCryptoPayment(result.rows[0]);
  }

  async checkPaymentStatus(paymentId: string): Promise<CryptoPayment> {
    const result = await query<any>(
      'SELECT * FROM crypto_payments WHERE id = $1',
      [paymentId]
    );

    if (result.rows.length === 0) {
      throw new Error('Crypto payment not found');
    }

    const payment = this.mapCryptoPayment(result.rows[0]);

    // Check if expired
    if (payment.status === 'pending' && new Date() > payment.expiresAt) {
      await this.updatePaymentStatus(paymentId, 'expired');
      payment.status = 'expired';

      await webhookService.send(payment.merchantId, 'crypto.payment.expired' as any, { payment });
    }

    return payment;
  }

  async confirmPayment(
    paymentId: string,
    txHash: string,
    confirmations: number
  ): Promise<CryptoPayment> {
    const payment = await this.getPaymentById(paymentId);

    if (payment.status === 'completed' || payment.status === 'expired') {
      return payment;
    }

    let newStatus: CryptoPaymentStatus = 'confirming';

    if (confirmations >= payment.requiredConfirmations) {
      newStatus = 'completed';
    }

    const result = await query<any>(
      `UPDATE crypto_payments SET
        status = $1, tx_hash = $2, confirmations = $3,
        paid_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE paid_at END
      WHERE id = $4 RETURNING *`,
      [newStatus, txHash, confirmations, paymentId]
    );

    const updatedPayment = this.mapCryptoPayment(result.rows[0]);

    if (newStatus === 'completed') {
      // Update transaction status
      await query(
        `UPDATE transactions SET status = 'completed' WHERE id = $1`,
        [payment.transactionId]
      );

      await webhookService.send(payment.merchantId, 'crypto.payment.completed' as any, {
        payment: updatedPayment,
      });

      logger.info('Crypto payment completed', {
        paymentId,
        txHash,
        confirmations,
      });
    }

    return updatedPayment;
  }

  async getExchangeRate(crypto: CryptoCurrency, fiat: string): Promise<number> {
    const cacheKey = `crypto_rate:${crypto}:${fiat}`;

    // Check cache (5 minute TTL)
    const cached = await cacheGet<number>(cacheKey);
    if (cached) return cached;

    try {
      // Map crypto to CoinGecko IDs
      const coinIds: Record<CryptoCurrency, string> = {
        BTC: 'bitcoin',
        ETH: 'ethereum',
        USDT: 'tether',
        USDC: 'usd-coin',
        DAI: 'dai',
        BUSD: 'binance-usd',
      };

      const response = await axios.get(
        `${this.priceApiUrl}/simple/price?ids=${coinIds[crypto]}&vs_currencies=${fiat.toLowerCase()}`
      );

      const rate = response.data[coinIds[crypto]][fiat.toLowerCase()];

      // Cache for 5 minutes
      await cacheSet(cacheKey, rate, 300);

      return rate;
    } catch (error) {
      logger.error('Failed to fetch exchange rate', { crypto, fiat, error });

      // Fallback rates for stablecoins
      if (['USDT', 'USDC', 'DAI', 'BUSD'].includes(crypto)) {
        return fiat === 'USD' ? 1 : 0;
      }

      throw new Error('Could not fetch exchange rate');
    }
  }

  async listPayments(
    merchantId: string,
    params: { status?: CryptoPaymentStatus; limit?: number; offset?: number }
  ): Promise<CryptoPayment[]> {
    const { status, limit = 50, offset = 0 } = params;

    let queryText = 'SELECT * FROM crypto_payments WHERE merchant_id = $1';
    const values: any[] = [merchantId];

    if (status) {
      queryText += ' AND status = $2';
      values.push(status);
    }

    queryText += ' ORDER BY created_at DESC LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2);
    values.push(limit, offset);

    const result = await query<any>(queryText, values);
    return result.rows.map(row => this.mapCryptoPayment(row));
  }

  // Wallet management
  async addWallet(
    merchantId: string,
    network: CryptoNetwork,
    currency: CryptoCurrency,
    address: string,
    label?: string
  ): Promise<CryptoWallet> {
    const result = await query<any>(
      `INSERT INTO crypto_wallets (merchant_id, network, currency, address, label)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (merchant_id, network, currency) DO UPDATE SET address = $4, label = $5
       RETURNING *`,
      [merchantId, network, currency, address, label]
    );

    return this.mapCryptoWallet(result.rows[0]);
  }

  async getWallets(merchantId: string): Promise<CryptoWallet[]> {
    const result = await query<any>(
      'SELECT * FROM crypto_wallets WHERE merchant_id = $1 AND is_active = true',
      [merchantId]
    );
    return result.rows.map(row => this.mapCryptoWallet(row));
  }

  // Helper methods
  private getDefaultNetwork(crypto: CryptoCurrency): CryptoNetwork {
    switch (crypto) {
      case 'BTC': return 'bitcoin';
      case 'ETH': return 'ethereum';
      case 'USDT': return 'ethereum'; // Default to Ethereum, but also available on Tron, BSC
      case 'USDC': return 'ethereum';
      case 'DAI': return 'ethereum';
      case 'BUSD': return 'bsc';
      default: return 'ethereum';
    }
  }

  private calculateCryptoAmount(fiatAmount: number, exchangeRate: number, crypto: CryptoCurrency): string {
    const cryptoAmount = fiatAmount / 100 / exchangeRate; // Convert cents to dollars, then to crypto
    const decimals = CRYPTO_DECIMALS[crypto];
    return cryptoAmount.toFixed(decimals);
  }

  private async getPaymentAddress(merchantId: string, network: CryptoNetwork, currency: CryptoCurrency): Promise<string> {
    // Try to get merchant's wallet
    const result = await query<any>(
      'SELECT address FROM crypto_wallets WHERE merchant_id = $1 AND network = $2 AND currency = $3 AND is_active = true',
      [merchantId, network, currency]
    );

    if (result.rows.length > 0) {
      return result.rows[0].address;
    }

    // Generate a mock address for development
    // In production, integrate with a wallet provider or HD wallet generation
    const prefix = network === 'bitcoin' ? 'bc1' : '0x';
    const randomHex = [...Array(40)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    return `${prefix}${randomHex}`;
  }

  private async getPaymentById(paymentId: string): Promise<CryptoPayment> {
    const result = await query<any>('SELECT * FROM crypto_payments WHERE id = $1', [paymentId]);
    if (result.rows.length === 0) {
      throw new Error('Crypto payment not found');
    }
    return this.mapCryptoPayment(result.rows[0]);
  }

  private async updatePaymentStatus(paymentId: string, status: CryptoPaymentStatus): Promise<void> {
    await query('UPDATE crypto_payments SET status = $1 WHERE id = $2', [status, paymentId]);
  }

  private mapCryptoPayment(row: any): CryptoPayment {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      transactionId: row.transaction_id,
      status: row.status,
      cryptocurrency: row.cryptocurrency,
      network: row.network,
      amount: parseInt(row.amount),
      cryptoAmount: row.crypto_amount,
      exchangeRate: parseFloat(row.exchange_rate),
      walletAddress: row.wallet_address,
      txHash: row.tx_hash,
      confirmations: row.confirmations,
      requiredConfirmations: row.required_confirmations,
      expiresAt: row.expires_at,
      paidAt: row.paid_at,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapCryptoWallet(row: any): CryptoWallet {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      network: row.network,
      currency: row.currency,
      address: row.address,
      label: row.label,
      isActive: row.is_active,
      createdAt: row.created_at,
    };
  }
}

export const cryptoService = new CryptoService();
