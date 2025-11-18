import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { taxService } from '../services/tax.service';

const calculateTaxSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  customerAddress: z.object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().length(2),
  }),
  merchantAddress: z.object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().length(2),
  }).optional(),
  productType: z.string().optional(),
});

export class TaxController {
  async calculate(req: Request, res: Response, next: NextFunction) {
    try {
      const data = calculateTaxSchema.parse(req.body);
      const result = await taxService.calculateTax(data);

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  async getRates(req: Request, res: Response, next: NextFunction) {
    try {
      const country = req.params.country?.toUpperCase();
      const rates = taxService.getTaxRates(country);

      res.json({ country, rates });
    } catch (error) {
      next(error);
    }
  }

  async validateTaxId(req: Request, res: Response, next: NextFunction) {
    try {
      const { country, taxId } = req.body;
      const isValid = taxService.validateTaxId(country, taxId);

      res.json({ valid: isValid });
    } catch (error) {
      next(error);
    }
  }
}

export const taxController = new TaxController();
