# TPT Payment Merchant Platform

A comprehensive, flexible Merchant of Record (MoR) and Payment Processor platform built with TypeScript. Designed for portability across Docker, DigitalOcean, and Railway.

## Features

### Core Payment Processing
- **Multi-gateway support** - Stripe integration with extensible gateway interface
- **Transaction management** - Charges, refunds, captures
- **Idempotency** - Prevent duplicate charges with idempotency keys
- **Webhook notifications** - Reliable event delivery with automatic retries

### Merchant of Record
- **Merchant onboarding** - Self-service registration with API keys
- **Fee calculation** - Configurable percentage + flat fees per merchant
- **Balance management** - Track available and pending balances
- **Automated payouts** - Scheduled payouts to merchant bank accounts

### Tax & Compliance
- **Tax calculation** - Built-in tax rates for US, CA, EU
- **Tax ID validation** - Validate EIN, VAT numbers
- **Extensible** - Integrate with TaxJar, Avalara

### Customer Management
- **Customer profiles** - Store customer information
- **Payment methods** - Tokenized card storage
- **Multiple payment methods** - Per customer

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 15+
- Redis 7+

### Local Development

1. **Clone and install**
   ```bash
   git clone <repository>
   cd tpt-payment-merchant
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

3. **Start dependencies**
   ```bash
   docker-compose up -d postgres redis
   ```

4. **Run migrations**
   ```bash
   npm run migrate
   ```

5. **Start development server**
   ```bash
   npm run dev
   ```

### Docker Deployment

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f app
```

## Deployment

### Railway

1. Connect your GitHub repository to Railway
2. Add PostgreSQL and Redis services
3. Set environment variables
4. Deploy automatically on push

Railway configuration is in `railway.json`.

### DigitalOcean App Platform

1. Create a new App from GitHub
2. Configure using `.do/app.yaml`
3. Add managed PostgreSQL and Redis
4. Deploy

### Docker (Any Host)

```bash
# Build image
docker build -t tpt-payment-merchant .

# Run with external services
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://... \
  -e REDIS_URL=redis://... \
  -e JWT_SECRET=your-secret \
  tpt-payment-merchant
```

## API Reference

### Authentication

#### Register Merchant
```bash
POST /api/v1/auth/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securepassword",
  "businessName": "Acme Inc",
  "businessType": "llc"
}
```

#### Login
```bash
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "securepassword"
}
```

### Transactions

#### Create Charge
```bash
POST /api/v1/transactions
Authorization: sk_live_your_api_key
Content-Type: application/json
Idempotency-Key: unique-key-123

{
  "amount": 5000,
  "currency": "USD",
  "description": "Order #123",
  "metadata": {
    "orderId": "123"
  }
}
```

#### List Transactions
```bash
GET /api/v1/transactions?page=1&limit=20&status=completed
Authorization: sk_live_your_api_key
```

#### Refund
```bash
POST /api/v1/transactions/:id/refund
Authorization: sk_live_your_api_key
Content-Type: application/json

{
  "amount": 2500,
  "reason": "Customer request"
}
```

### Customers

#### Create Customer
```bash
POST /api/v1/customers
Authorization: sk_live_your_api_key
Content-Type: application/json

{
  "email": "customer@example.com",
  "name": "Jane Smith"
}
```

#### Add Payment Method
```bash
POST /api/v1/customers/:id/payment-methods
Authorization: sk_live_your_api_key
Content-Type: application/json

{
  "token": "tok_visa"
}
```

### Balance & Payouts

#### Get Balance
```bash
GET /api/v1/balance
Authorization: sk_live_your_api_key
```

#### Create Payout
```bash
POST /api/v1/payouts
Authorization: sk_live_your_api_key
Content-Type: application/json

{
  "currency": "USD",
  "amount": 100000
}
```

### Webhooks

#### Update Webhook URL
```bash
PUT /api/v1/webhooks/url
Authorization: sk_live_your_api_key
Content-Type: application/json

{
  "webhookUrl": "https://your-server.com/webhooks"
}
```

#### Webhook Events
- `transaction.created`
- `transaction.completed`
- `transaction.failed`
- `transaction.refunded`
- `transaction.disputed`
- `payout.created`
- `payout.completed`
- `payout.failed`

### Tax Calculation

#### Calculate Tax
```bash
POST /api/v1/tax/calculate
Authorization: sk_live_your_api_key
Content-Type: application/json

{
  "amount": 10000,
  "currency": "USD",
  "customerAddress": {
    "country": "US",
    "state": "CA",
    "postalCode": "94105"
  }
}
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `REDIS_URL` | Redis connection string | Required |
| `JWT_SECRET` | JWT signing secret (min 32 chars) | Required |
| `JWT_REFRESH_SECRET` | Refresh token secret | Required |
| `ENCRYPTION_KEY` | Data encryption key (32 chars) | Required |
| `STRIPE_SECRET_KEY` | Stripe API key | Optional |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret | Optional |

### Merchant Settings

Each merchant can configure:
- `defaultCurrency` - Default transaction currency
- `supportedCurrencies` - Accepted currencies
- `payoutSchedule` - daily, weekly, monthly
- `minimumPayoutAmount` - Minimum payout threshold
- `feePercentage` - Platform fee percentage
- `flatFee` - Per-transaction flat fee
- `autoCapture` - Automatic payment capture

## Architecture

```
src/
├── config/         # Configuration management
├── controllers/    # API request handlers
├── database/       # Database connection & migrations
├── middleware/     # Express middleware
├── routes/         # API route definitions
├── services/       # Business logic
├── types/          # TypeScript types
└── utils/          # Utilities (logger, errors, encryption)
```

### Key Services

- **PaymentGatewayService** - Abstract gateway interface with Stripe implementation
- **MerchantService** - Merchant CRUD and settings
- **TransactionService** - Payment processing and refunds
- **WebhookService** - Event delivery with BullMQ
- **BalanceService** - Balance tracking and payouts
- **TaxService** - Tax calculation and validation
- **AuthService** - JWT and API key authentication

## Development

### Scripts

```bash
npm run dev          # Start development server
npm run build        # Build TypeScript
npm run start        # Start production server
npm run migrate      # Run database migrations
npm run test         # Run tests
npm run lint         # Lint code
npm run typecheck    # Type check
```

### Testing

```bash
# Run all tests
npm test

# With coverage
npm run test:coverage
```

## Security

- **API Key Authentication** - SHA-256 hashed keys
- **JWT Tokens** - Short-lived access tokens with refresh
- **Encryption** - AES encryption for sensitive data
- **Webhook Signatures** - HMAC-SHA256 signed payloads
- **Rate Limiting** - Configurable per-endpoint limits
- **Input Validation** - Zod schema validation
- **SQL Injection Protection** - Parameterized queries

## License

MIT
