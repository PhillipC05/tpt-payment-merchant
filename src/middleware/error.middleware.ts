import { Request, Response, NextFunction } from 'express';
import { AppError, isOperationalError } from '../utils/errors';
import { logger } from '../utils/logger';
import { config } from '../config';

export function errorMiddleware(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Log error
  logger.error('Request error', {
    error: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method,
    requestId: req.requestId,
  });

  // Handle known operational errors
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  // Handle validation errors from Zod
  if (error.name === 'ZodError') {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: (error as any).errors,
      },
    });
    return;
  }

  // Handle JWT errors
  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    res.status(401).json({
      error: {
        code: 'AUTHENTICATION_ERROR',
        message: error.message,
      },
    });
    return;
  }

  // Handle unknown errors
  const isProduction = config.nodeEnv === 'production';

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'An unexpected error occurred' : error.message,
      ...(isProduction ? {} : { stack: error.stack }),
    },
  });
}

export function notFoundMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
}
