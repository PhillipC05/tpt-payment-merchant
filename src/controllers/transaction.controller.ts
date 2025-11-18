import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { transactionService } from '../services/transaction.service';

const createChargeSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  customerId: z.string().uuid().optional(),
  paymentMethodId: z.string().optional(),
  description: z.string().optional(),
  statementDescriptor: z.string().max(22).optional(),
  metadata: z.record(z.any()).optional(),
  capture: z.boolean().optional(),
});

const refundSchema = z.object({
  amount: z.number().int().positive().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'refunded', 'disputed']).optional(),
  type: z.enum(['charge', 'refund', 'payout', 'fee', 'adjustment']).optional(),
  customerId: z.string().uuid().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export class TransactionController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createChargeSchema.parse(req.body);
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

      const transaction = await transactionService.createCharge(req.merchantId!, {
        ...data,
        idempotencyKey,
      });

      res.status(201).json(transaction);
    } catch (error) {
      next(error);
    }
  }

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const transaction = await transactionService.findById(
        req.params.id,
        req.merchantId
      );

      res.json(transaction);
    } catch (error) {
      next(error);
    }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const query = listQuerySchema.parse(req.query);
      const result = await transactionService.list(req.merchantId!, query);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  async refund(req: Request, res: Response, next: NextFunction) {
    try {
      const data = refundSchema.parse(req.body);
      const transaction = await transactionService.refund(req.merchantId!, {
        transactionId: req.params.id,
        ...data,
      });

      res.status(201).json(transaction);
    } catch (error) {
      next(error);
    }
  }

  async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;

      const start = startDate
        ? new Date(startDate as string)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      const end = endDate
        ? new Date(endDate as string)
        : new Date();

      const stats = await transactionService.getStats(
        req.merchantId!,
        start,
        end
      );

      res.json(stats);
    } catch (error) {
      next(error);
    }
  }
}

export const transactionController = new TransactionController();
