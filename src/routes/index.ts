import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { transactionController } from '../controllers/transaction.controller';
import { customerController } from '../controllers/customer.controller';
import { balanceController } from '../controllers/balance.controller';
import { webhookController } from '../controllers/webhook.controller';
import { taxController } from '../controllers/tax.controller';
import { cryptoController } from '../controllers/crypto.controller';
import { subscriptionController } from '../controllers/subscription.controller';
import { fraudController } from '../controllers/fraud.controller';
import { reportingController } from '../controllers/reporting.controller';
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

// Crypto Payments
router.post('/crypto/payments', cryptoController.createPayment.bind(cryptoController));
router.get('/crypto/payments', cryptoController.listPayments.bind(cryptoController));
router.get('/crypto/payments/:id', cryptoController.getPayment.bind(cryptoController));
router.get('/crypto/payments/:id/status', cryptoController.checkStatus.bind(cryptoController));
router.get('/crypto/rates/:crypto/:fiat', cryptoController.getExchangeRate.bind(cryptoController));
router.post('/crypto/wallets', cryptoController.addWallet.bind(cryptoController));
router.get('/crypto/wallets', cryptoController.getWallets.bind(cryptoController));

// Subscriptions - Plans
router.post('/plans', subscriptionController.createPlan.bind(subscriptionController));
router.get('/plans', subscriptionController.listPlans.bind(subscriptionController));
router.get('/plans/:id', subscriptionController.getPlan.bind(subscriptionController));

// Subscriptions
router.post('/subscriptions', subscriptionController.createSubscription.bind(subscriptionController));
router.get('/subscriptions', subscriptionController.listSubscriptions.bind(subscriptionController));
router.get('/subscriptions/:id', subscriptionController.getSubscription.bind(subscriptionController));
router.post('/subscriptions/:id/cancel', subscriptionController.cancelSubscription.bind(subscriptionController));

// Coupons
router.post('/coupons', subscriptionController.createCoupon.bind(subscriptionController));
router.get('/coupons/:code/validate', subscriptionController.validateCoupon.bind(subscriptionController));

// Fraud Prevention - Blocklist
router.post('/fraud/blocklist', fraudController.addToBlocklist.bind(fraudController));
router.get('/fraud/blocklist', fraudController.getBlocklist.bind(fraudController));
router.delete('/fraud/blocklist/:id', fraudController.removeFromBlocklist.bind(fraudController));

// Fraud Prevention - Rules
router.post('/fraud/rules', fraudController.createRule.bind(fraudController));
router.get('/fraud/rules', fraudController.getRules.bind(fraudController));
router.delete('/fraud/rules/:id', fraudController.deleteRule.bind(fraudController));

// Reporting & Analytics
router.get('/reports/dashboard', reportingController.getDashboard.bind(reportingController));
router.get('/reports/revenue', reportingController.getRevenueReport.bind(reportingController));
router.get('/reports/cohorts', reportingController.getCohortAnalysis.bind(reportingController));
router.get('/reports/export', reportingController.exportTransactions.bind(reportingController));

export default router;
