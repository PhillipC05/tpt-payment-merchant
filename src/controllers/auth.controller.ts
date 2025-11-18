import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';
import { merchantService } from '../services/merchant.service';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  businessName: z.string().min(1),
  businessType: z.string().min(1),
  taxId: z.string().optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

export class AuthController {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const data = registerSchema.parse(req.body);
      const { merchant, apiKey } = await merchantService.create(data);

      res.status(201).json({
        merchant: {
          id: merchant.id,
          name: merchant.name,
          email: merchant.email,
          businessName: merchant.businessName,
          status: merchant.status,
        },
        apiKey,
        message: 'Store this API key securely. It will not be shown again.',
      });
    } catch (error) {
      next(error);
    }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const data = loginSchema.parse(req.body);
      const result = await authService.login(data);

      res.json({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        merchant: {
          id: result.merchant.id,
          name: result.merchant.name,
          email: result.merchant.email,
          businessName: result.merchant.businessName,
          status: result.merchant.status,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const data = refreshSchema.parse(req.body);
      const tokens = await authService.refreshTokens(data.refreshToken);

      res.json(tokens);
    } catch (error) {
      next(error);
    }
  }

  async changePassword(req: Request, res: Response, next: NextFunction) {
    try {
      const data = changePasswordSchema.parse(req.body);
      await authService.changePassword(
        req.merchantId!,
        data.currentPassword,
        data.newPassword
      );

      res.json({ message: 'Password changed successfully' });
    } catch (error) {
      next(error);
    }
  }

  async rotateApiKey(req: Request, res: Response, next: NextFunction) {
    try {
      const apiKey = await merchantService.rotateApiKey(req.merchantId!);

      res.json({
        apiKey,
        message: 'Store this API key securely. It will not be shown again.',
      });
    } catch (error) {
      next(error);
    }
  }

  async me(req: Request, res: Response, next: NextFunction) {
    try {
      const merchant = await merchantService.findById(req.merchantId!);

      res.json({
        id: merchant.id,
        name: merchant.name,
        email: merchant.email,
        businessName: merchant.businessName,
        businessType: merchant.businessType,
        status: merchant.status,
        settings: merchant.settings,
        webhookUrl: merchant.webhookUrl,
        createdAt: merchant.createdAt,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const authController = new AuthController();
