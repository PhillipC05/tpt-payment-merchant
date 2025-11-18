import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { cryptoService } from '../services/crypto.service';

const createPaymentSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  cryptocurrency: z.enum(['BTC', 'ETH', 'USDT', 'USDC', 'DAI', 'BUSD']),
  network: z.enum(['bitcoin', 'ethereum', 'polygon', 'solana', 'tron', 'bsc']).optional(),
  customerId: z.string().uuid().optional(),
  description: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  expirationMinutes: z.number().int().min(5).max(1440).optional(),
});

const addWalletSchema = z.object({
  network: z.enum(['bitcoin', 'ethereum', 'polygon', 'solana', 'tron', 'bsc']),
  currency: z.enum(['BTC', 'ETH', 'USDT', 'USDC', 'DAI', 'BUSD']),
  address: z.string().min(20),
  label: z.string().optional(),
});

export class CryptoController {
  async createPayment(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createPaymentSchema.parse(req.body);
      const payment = await cryptoService.createPayment(req.merchantId!, data);
      res.status(201).json(payment);
    } catch (error) { next(error); }
  }

  async getPayment(req: Request, res: Response, next: NextFunction) {
    try {
      const payment = await cryptoService.getPayment(req.params.id, req.merchantId!);
      res.json(payment);
    } catch (error) { next(error); }
  }

  async listPayments(req: Request, res: Response, next: NextFunction) {
    try {
      const payments = await cryptoService.listPayments(req.merchantId!, {
        status: req.query.status as any,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
        offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
      });
      res.json(payments);
    } catch (error) { next(error); }
  }

  async checkStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const payment = await cryptoService.checkPaymentStatus(req.params.id);
      res.json(payment);
    } catch (error) { next(error); }
  }

  async getExchangeRate(req: Request, res: Response, next: NextFunction) {
    try {
      const { crypto, fiat } = req.params;
      const rate = await cryptoService.getExchangeRate(crypto as any, fiat);
      res.json({ cryptocurrency: crypto, fiatCurrency: fiat, rate, timestamp: new Date() });
    } catch (error) { next(error); }
  }

  async addWallet(req: Request, res: Response, next: NextFunction) {
    try {
      const data = addWalletSchema.parse(req.body);
      const wallet = await cryptoService.addWallet(req.merchantId!, data.network, data.currency, data.address, data.label);
      res.status(201).json(wallet);
    } catch (error) { next(error); }
  }

  async getWallets(req: Request, res: Response, next: NextFunction) {
    try {
      const wallets = await cryptoService.getWallets(req.merchantId!);
      res.json(wallets);
    } catch (error) { next(error); }
  }
}

export const cryptoController = new CryptoController();
