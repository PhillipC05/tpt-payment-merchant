import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { balanceService } from '../services/balance.service';

const createPayoutSchema = z.object({
  currency: z.string().length(3),
  amount: z.number().int().positive().optional(),
});

const listPayoutsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
});

export class BalanceController {
  async getBalance(req: Request, res: Response, next: NextFunction) {
    try {
      const balance = await balanceService.getBalance(req.merchantId!);

      // Format for response
      const formatAmount = (amounts: { currency: string; amount: number }[]) =>
        amounts.reduce((acc, { currency, amount }) => {
          acc[currency] = amount;
          return acc;
        }, {} as Record<string, number>);

      res.json({
        available: formatAmount(balance.available),
        pending: formatAmount(balance.pending),
      });
    } catch (error) {
      next(error);
    }
  }

  async createPayout(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createPayoutSchema.parse(req.body);
      const payout = await balanceService.createPayout(
        req.merchantId!,
        data.currency,
        data.amount
      );

      res.status(201).json(payout);
    } catch (error) {
      next(error);
    }
  }

  async getPayout(req: Request, res: Response, next: NextFunction) {
    try {
      const payout = await balanceService.getPayout(
        req.params.id,
        req.merchantId!
      );

      res.json(payout);
    } catch (error) {
      next(error);
    }
  }

  async listPayouts(req: Request, res: Response, next: NextFunction) {
    try {
      const query = listPayoutsSchema.parse(req.query);
      const result = await balanceService.listPayouts(req.merchantId!, query);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
}

export const balanceController = new BalanceController();
