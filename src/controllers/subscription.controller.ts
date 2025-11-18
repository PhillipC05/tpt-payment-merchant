import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { subscriptionService } from '../services/subscription.service';

const createPlanSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  interval: z.enum(['day', 'week', 'month', 'year']),
  intervalCount: z.number().int().positive().optional(),
  trialPeriodDays: z.number().int().min(0).optional(),
  features: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
});

const createSubscriptionSchema = z.object({
  customerId: z.string().uuid(),
  planId: z.string().uuid(),
  quantity: z.number().int().positive().optional(),
  trialDays: z.number().int().min(0).optional(),
  metadata: z.record(z.any()).optional(),
  couponId: z.string().uuid().optional(),
});

const createCouponSchema = z.object({
  code: z.string().min(3).max(50),
  name: z.string().min(1),
  discountType: z.enum(['percentage', 'fixed']),
  discountValue: z.number().positive(),
  currency: z.string().length(3).optional(),
  maxRedemptions: z.number().int().positive().optional(),
  expiresAt: z.coerce.date().optional(),
});

export class SubscriptionController {
  // Plans
  async createPlan(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createPlanSchema.parse(req.body);
      const plan = await subscriptionService.createPlan(req.merchantId!, data);
      res.status(201).json(plan);
    } catch (error) { next(error); }
  }

  async getPlan(req: Request, res: Response, next: NextFunction) {
    try {
      const plan = await subscriptionService.getPlan(req.params.id, req.merchantId!);
      res.json(plan);
    } catch (error) { next(error); }
  }

  async listPlans(req: Request, res: Response, next: NextFunction) {
    try {
      const plans = await subscriptionService.listPlans(req.merchantId!, req.query.active !== 'false');
      res.json(plans);
    } catch (error) { next(error); }
  }

  // Subscriptions
  async createSubscription(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createSubscriptionSchema.parse(req.body);
      const subscription = await subscriptionService.createSubscription(req.merchantId!, data);
      res.status(201).json(subscription);
    } catch (error) { next(error); }
  }

  async getSubscription(req: Request, res: Response, next: NextFunction) {
    try {
      const subscription = await subscriptionService.getSubscription(req.params.id, req.merchantId!);
      res.json(subscription);
    } catch (error) { next(error); }
  }

  async listSubscriptions(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await subscriptionService.listSubscriptions(req.merchantId!, {
        page: parseInt(req.query.page as string) || 1,
        limit: parseInt(req.query.limit as string) || 20,
        customerId: req.query.customerId as string,
        status: req.query.status as any,
      });
      res.json(result);
    } catch (error) { next(error); }
  }

  async cancelSubscription(req: Request, res: Response, next: NextFunction) {
    try {
      const cancelAtPeriodEnd = req.body.cancelAtPeriodEnd !== false;
      const subscription = await subscriptionService.cancelSubscription(req.params.id, req.merchantId!, cancelAtPeriodEnd);
      res.json(subscription);
    } catch (error) { next(error); }
  }

  // Coupons
  async createCoupon(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createCouponSchema.parse(req.body);
      const coupon = await subscriptionService.createCoupon(req.merchantId!, data);
      res.status(201).json(coupon);
    } catch (error) { next(error); }
  }

  async validateCoupon(req: Request, res: Response, next: NextFunction) {
    try {
      const coupon = await subscriptionService.validateCoupon(req.params.code, req.merchantId!);
      res.json(coupon);
    } catch (error) { next(error); }
  }
}

export const subscriptionController = new SubscriptionController();
