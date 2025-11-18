import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';

import { config, getCorsOrigins, getPlatform } from './config';
import { logger } from './utils/logger';
import { healthCheck as dbHealthCheck, closePool } from './database/connection';
import { redisHealthCheck, closeRedis } from './database/redis';
import { webhookService } from './services/webhook.service';
import routes from './routes';
import { errorMiddleware, notFoundMiddleware } from './middleware/error.middleware';
import { basicRateLimiter } from './middleware/rate-limit.middleware';

const app = express();

// Trust proxy for rate limiting behind reverse proxies
app.set('trust proxy', 1);

// Request ID middleware
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] as string || uuidv4();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for API
}));

// CORS
app.use(cors({
  origin: getCorsOrigins(),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'Idempotency-Key'],
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use(basicRateLimiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Request completed', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      requestId: req.requestId,
    });
  });

  next();
});

// Health check endpoint (before routes for unauthenticated access)
app.get('/health', async (req, res) => {
  const dbStatus = await dbHealthCheck();
  const redisStatus = await redisHealthCheck();

  const status = dbStatus && redisStatus ? 'healthy' : 'unhealthy';

  res.status(status === 'healthy' ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    platform: getPlatform(),
    services: {
      database: dbStatus ? 'up' : 'down',
      redis: redisStatus ? 'up' : 'down',
    },
  });
});

// API routes
app.use('/api/v1', routes);

// 404 handler
app.use(notFoundMiddleware);

// Error handler
app.use(errorMiddleware);

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully`);

  // Close webhook service
  await webhookService.shutdown();

  // Close database connections
  await closePool();
  await closeRedis();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

// Start server
async function start() {
  try {
    // Initialize webhook service
    await webhookService.initialize();

    const server = app.listen(config.port, config.host, () => {
      logger.info(`Server started`, {
        host: config.host,
        port: config.port,
        env: config.nodeEnv,
        platform: getPlatform(),
      });
    });

    // Handle server errors
    server.on('error', (error) => {
      logger.error('Server error', { error: error.message });
      process.exit(1);
    });

  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    process.exit(1);
  }
}

start();

export default app;
