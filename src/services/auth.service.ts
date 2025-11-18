import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { query } from '../database/connection';
import { merchantService } from './merchant.service';
import { logger } from '../utils/logger';
import { hashApiKey } from '../utils/encryption';
import {
  AuthenticationError,
  NotFoundError
} from '../utils/errors';
import {
  AuthTokenPayload,
  AuthTokens,
  LoginInput,
  Merchant
} from '../types';

export class AuthService {
  async login(input: LoginInput): Promise<AuthTokens & { merchant: Merchant }> {
    // Find merchant by email
    const result = await query<any>(
      'SELECT * FROM merchants WHERE email = $1',
      [input.email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      throw new AuthenticationError('Invalid credentials');
    }

    const merchantRow = result.rows[0];

    // Verify password
    const isValid = await bcrypt.compare(input.password, merchantRow.password_hash);
    if (!isValid) {
      throw new AuthenticationError('Invalid credentials');
    }

    // Check status
    if (merchantRow.status === 'suspended' || merchantRow.status === 'terminated') {
      throw new AuthenticationError('Account is not active');
    }

    // Generate tokens
    const tokens = this.generateTokens(merchantRow.id, merchantRow.email);

    // Map merchant
    const merchant = await merchantService.findById(merchantRow.id);

    logger.info('Merchant logged in', { merchantId: merchant.id });

    return { ...tokens, merchant };
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    try {
      const payload = jwt.verify(
        refreshToken,
        config.jwtRefreshSecret
      ) as AuthTokenPayload;

      if (payload.type !== 'refresh') {
        throw new AuthenticationError('Invalid token type');
      }

      // Verify merchant still exists and is active
      const merchant = await merchantService.findById(payload.merchantId);

      if (merchant.status === 'suspended' || merchant.status === 'terminated') {
        throw new AuthenticationError('Account is not active');
      }

      return this.generateTokens(payload.merchantId, payload.email);
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AuthenticationError('Invalid refresh token');
      }
      throw error;
    }
  }

  async validateAccessToken(token: string): Promise<AuthTokenPayload> {
    try {
      const payload = jwt.verify(
        token,
        config.jwtSecret
      ) as AuthTokenPayload;

      if (payload.type !== 'access') {
        throw new AuthenticationError('Invalid token type');
      }

      return payload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthenticationError('Token expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AuthenticationError('Invalid token');
      }
      throw error;
    }
  }

  async validateApiKey(apiKey: string): Promise<Merchant> {
    const keyHash = hashApiKey(apiKey);

    const merchant = await merchantService.findByApiKey(keyHash);

    if (!merchant) {
      throw new AuthenticationError('Invalid API key');
    }

    if (merchant.status === 'suspended' || merchant.status === 'terminated') {
      throw new AuthenticationError('Account is not active');
    }

    return merchant;
  }

  async changePassword(
    merchantId: string,
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    // Verify current password
    const isValid = await merchantService.verifyPassword(merchantId, currentPassword);

    if (!isValid) {
      throw new AuthenticationError('Current password is incorrect');
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await query(
      'UPDATE merchants SET password_hash = $1 WHERE id = $2',
      [passwordHash, merchantId]
    );

    logger.info('Password changed', { merchantId });
  }

  private generateTokens(merchantId: string, email: string): AuthTokens {
    const accessPayload: AuthTokenPayload = {
      merchantId,
      email,
      type: 'access',
    };

    const refreshPayload: AuthTokenPayload = {
      merchantId,
      email,
      type: 'refresh',
    };

    const accessToken = jwt.sign(accessPayload, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn,
    });

    const refreshToken = jwt.sign(refreshPayload, config.jwtRefreshSecret, {
      expiresIn: config.jwtRefreshExpiresIn,
    });

    // Parse expiry
    const expiresIn = this.parseExpiresIn(config.jwtExpiresIn);

    return {
      accessToken,
      refreshToken,
      expiresIn,
    };
  }

  private parseExpiresIn(duration: string): number {
    const unit = duration.slice(-1);
    const value = parseInt(duration.slice(0, -1));

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return 3600; // default 1 hour
    }
  }
}

export const authService = new AuthService();
