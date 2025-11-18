import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { fraudService } from '../services/fraud.service';

const addBlocklistSchema = z.object({
  type: z.enum(['email', 'ip', 'card_fingerprint', 'country']),
  value: z.string().min(1),
  reason: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
});

const createRuleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  conditions: z.array(z.object({
    field: z.string(),
    operator: z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'in', 'contains', 'regex']),
    value: z.any(),
  })),
  action: z.enum(['allow', 'review', 'block']),
  priority: z.number().int().optional(),
});

export class FraudController {
  // Blocklist
  async addToBlocklist(req: Request, res: Response, next: NextFunction) {
    try {
      const data = addBlocklistSchema.parse(req.body);
      const entry = await fraudService.addToBlocklist(req.merchantId!, data);
      res.status(201).json(entry);
    } catch (error) { next(error); }
  }

  async getBlocklist(req: Request, res: Response, next: NextFunction) {
    try {
      const entries = await fraudService.getBlocklist(req.merchantId!, req.query.type as string);
      res.json(entries);
    } catch (error) { next(error); }
  }

  async removeFromBlocklist(req: Request, res: Response, next: NextFunction) {
    try {
      await fraudService.removeFromBlocklist(req.params.id, req.merchantId!);
      res.status(204).send();
    } catch (error) { next(error); }
  }

  // Rules
  async createRule(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createRuleSchema.parse(req.body);
      const rule = await fraudService.createRule(req.merchantId!, data);
      res.status(201).json(rule);
    } catch (error) { next(error); }
  }

  async getRules(req: Request, res: Response, next: NextFunction) {
    try {
      const rules = await fraudService.getRules(req.merchantId!);
      res.json(rules);
    } catch (error) { next(error); }
  }

  async deleteRule(req: Request, res: Response, next: NextFunction) {
    try {
      await fraudService.deleteRule(req.params.id, req.merchantId!);
      res.status(204).send();
    } catch (error) { next(error); }
  }
}

export const fraudController = new FraudController();
