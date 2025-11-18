import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { customerService } from '../services/customer.service';

const createCustomerSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  phone: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const updateCustomerSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const addPaymentMethodSchema = z.object({
  token: z.string(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

export class CustomerController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const data = createCustomerSchema.parse(req.body);
      const customer = await customerService.create(req.merchantId!, data);

      res.status(201).json(customer);
    } catch (error) {
      next(error);
    }
  }

  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const customer = await customerService.findById(
        req.params.id,
        req.merchantId!
      );

      res.json(customer);
    } catch (error) {
      next(error);
    }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const query = listQuerySchema.parse(req.query);
      const result = await customerService.list(req.merchantId!, query);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const data = updateCustomerSchema.parse(req.body);
      const customer = await customerService.update(
        req.params.id,
        req.merchantId!,
        data
      );

      res.json(customer);
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      await customerService.delete(req.params.id, req.merchantId!);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  // Payment Methods
  async addPaymentMethod(req: Request, res: Response, next: NextFunction) {
    try {
      const data = addPaymentMethodSchema.parse(req.body);
      const paymentMethod = await customerService.addPaymentMethod(
        req.params.id,
        req.merchantId!,
        data.token
      );

      res.status(201).json(paymentMethod);
    } catch (error) {
      next(error);
    }
  }

  async getPaymentMethods(req: Request, res: Response, next: NextFunction) {
    try {
      const paymentMethods = await customerService.getPaymentMethods(
        req.params.id,
        req.merchantId!
      );

      res.json(paymentMethods);
    } catch (error) {
      next(error);
    }
  }

  async setDefaultPaymentMethod(req: Request, res: Response, next: NextFunction) {
    try {
      await customerService.setDefaultPaymentMethod(
        req.params.paymentMethodId,
        req.params.id,
        req.merchantId!
      );

      res.json({ message: 'Default payment method updated' });
    } catch (error) {
      next(error);
    }
  }

  async deletePaymentMethod(req: Request, res: Response, next: NextFunction) {
    try {
      await customerService.deletePaymentMethod(
        req.params.paymentMethodId,
        req.params.id,
        req.merchantId!
      );

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
}

export const customerController = new CustomerController();
