import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { transactionController } from '../controllers/transaction.controller';
import { customerController } from '../controllers/customer.controller';
import { balanceController } from '../controllers/balance.controller';
import { webhookController } from '../controllers/webhook.controller';
import { taxController } from '../controllers/tax.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { strictRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (public)
router.post('/auth/register', authController.register.bind(authController));
router.post('/auth/login', strictRateLimiter, authController.login.bind(authController));
router.post('/auth/refresh', authController.refresh.bind(authController));

// Protected routes
router.use(authMiddleware);

// Auth (protected)
router.get('/auth/me', authController.me.bind(authController));
router.post('/auth/change-password', authController.changePassword.bind(authController));
router.post('/auth/rotate-api-key', authController.rotateApiKey.bind(authController));

// Transactions
router.post('/transactions', transactionController.create.bind(transactionController));
router.get('/transactions', transactionController.list.bind(transactionController));
router.get('/transactions/stats', transactionController.getStats.bind(transactionController));
router.get('/transactions/:id', transactionController.get.bind(transactionController));
router.post('/transactions/:id/refund', transactionController.refund.bind(transactionController));

// Customers
router.post('/customers', customerController.create.bind(customerController));
router.get('/customers', customerController.list.bind(customerController));
router.get('/customers/:id', customerController.get.bind(customerController));
router.patch('/customers/:id', customerController.update.bind(customerController));
router.delete('/customers/:id', customerController.delete.bind(customerController));

// Payment Methods
router.post('/customers/:id/payment-methods', customerController.addPaymentMethod.bind(customerController));
router.get('/customers/:id/payment-methods', customerController.getPaymentMethods.bind(customerController));
router.post('/customers/:id/payment-methods/:paymentMethodId/default', customerController.setDefaultPaymentMethod.bind(customerController));
router.delete('/customers/:id/payment-methods/:paymentMethodId', customerController.deletePaymentMethod.bind(customerController));

// Balance & Payouts
router.get('/balance', balanceController.getBalance.bind(balanceController));
router.post('/payouts', balanceController.createPayout.bind(balanceController));
router.get('/payouts', balanceController.listPayouts.bind(balanceController));
router.get('/payouts/:id', balanceController.getPayout.bind(balanceController));

// Webhooks
router.get('/webhooks/events', webhookController.getEvents.bind(webhookController));
router.get('/webhooks/events/:id', webhookController.getEvent.bind(webhookController));
router.post('/webhooks/events/:id/retry', webhookController.retryEvent.bind(webhookController));
router.put('/webhooks/url', webhookController.updateWebhookUrl.bind(webhookController));
router.get('/webhooks/secret', webhookController.getWebhookSecret.bind(webhookController));

// Tax
router.post('/tax/calculate', taxController.calculate.bind(taxController));
router.get('/tax/rates/:country', taxController.getRates.bind(taxController));
router.post('/tax/validate-id', taxController.validateTaxId.bind(taxController));

export default router;
