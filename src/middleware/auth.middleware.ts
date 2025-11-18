import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { AuthenticationError } from '../utils/errors';
import { logger } from '../utils/logger';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      merchantId?: string;
      merchant?: any;
      apiKeyId?: string;
      requestId?: string;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new AuthenticationError('No authorization header');
    }

    // Check for Bearer token (JWT)
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = await authService.validateAccessToken(token);
      req.merchantId = payload.merchantId;
      return next();
    }

    // Check for API key
    if (authHeader.startsWith('sk_')) {
      const merchant = await authService.validateApiKey(authHeader);
      req.merchantId = merchant.id;
      req.merchant = merchant;
      return next();
    }

    throw new AuthenticationError('Invalid authorization format');
  } catch (error) {
    next(error);
  }
}

export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return next();
    }

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = await authService.validateAccessToken(token);
      req.merchantId = payload.merchantId;
    } else if (authHeader.startsWith('sk_')) {
      const merchant = await authService.validateApiKey(authHeader);
      req.merchantId = merchant.id;
      req.merchant = merchant;
    }

    next();
  } catch (error) {
    // Ignore auth errors for optional auth
    logger.debug('Optional auth failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    next();
  }
}
