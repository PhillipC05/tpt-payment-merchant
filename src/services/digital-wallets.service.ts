// Digital Wallets Service - Apple Pay, Google Pay
// Handles wallet registration, verification, and payment processing

import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

// Apple Pay types
export interface ApplePayConfig {
  merchantId: string;
  merchantIdentifier: string; // Apple merchant ID
  displayName: string;
  domainNames: string[];
  merchantCapabilities: ('supports3DS' | 'supportsCredit' | 'supportsDebit' | 'supportsEMV')[];
  supportedNetworks: ('visa' | 'masterCard' | 'amex' | 'discover' | 'jcb')[];
  countryCode: string;
}

export interface ApplePaySession {
  merchantId: string;
  validationUrl: string;
  displayName: string;
  domainName: string;
  merchantIdentifier: string;
}

export interface ApplePayPaymentRequest {
  countryCode: string;
  currencyCode: string;
  supportedNetworks: string[];
  merchantCapabilities: string[];
  total: {
    label: string;
    amount: string;
    type?: 'final' | 'pending';
  };
  lineItems?: {
    label: string;
    amount: string;
    type?: 'final' | 'pending';
  }[];
  requiredBillingContactFields?: string[];
  requiredShippingContactFields?: string[];
  shippingMethods?: {
    label: string;
    detail: string;
    amount: string;
    identifier: string;
  }[];
  shippingType?: 'shipping' | 'delivery' | 'storePickup' | 'servicePickup';
  applicationData?: string;
}

export interface ApplePayPaymentToken {
  paymentData: {
    version: string;
    data: string; // Encrypted payment data
    signature: string;
    header: {
      ephemeralPublicKey: string;
      publicKeyHash: string;
      transactionId: string;
    };
  };
  paymentMethod: {
    displayName: string;
    network: string;
    type: 'debit' | 'credit' | 'prepaid' | 'store';
  };
  transactionIdentifier: string;
}

// Google Pay types
export interface GooglePayConfig {
  merchantId: string;
  merchantName: string;
  environment: 'TEST' | 'PRODUCTION';
  allowedCardNetworks: ('AMEX' | 'DISCOVER' | 'JCB' | 'MASTERCARD' | 'VISA')[];
  allowedCardAuthMethods: ('PAN_ONLY' | 'CRYPTOGRAM_3DS')[];
  gatewayMerchantId: string;
  merchantOrigin?: string;
}

export interface GooglePayPaymentRequest {
  apiVersion: number;
  apiVersionMinor: number;
  merchantInfo: {
    merchantId: string;
    merchantName: string;
  };
  allowedPaymentMethods: {
    type: 'CARD';
    parameters: {
      allowedAuthMethods: string[];
      allowedCardNetworks: string[];
      billingAddressRequired?: boolean;
      billingAddressParameters?: {
        format?: 'MIN' | 'FULL';
        phoneNumberRequired?: boolean;
      };
    };
    tokenizationSpecification: {
      type: 'PAYMENT_GATEWAY';
      parameters: {
        gateway: string;
        gatewayMerchantId: string;
      };
    };
  }[];
  transactionInfo: {
    totalPriceStatus: 'FINAL' | 'ESTIMATED' | 'NOT_CURRENTLY_KNOWN';
    totalPrice: string;
    currencyCode: string;
    countryCode?: string;
    transactionId?: string;
    displayItems?: {
      label: string;
      type: 'LINE_ITEM' | 'SUBTOTAL' | 'TAX' | 'DISCOUNT' | 'SHIPPING_OPTION';
      price: string;
      status?: 'FINAL' | 'PENDING';
    }[];
    totalPriceLabel?: string;
    checkoutOption?: 'DEFAULT' | 'COMPLETE_IMMEDIATE_PURCHASE';
  };
  emailRequired?: boolean;
  shippingAddressRequired?: boolean;
  shippingAddressParameters?: {
    allowedCountryCodes?: string[];
    phoneNumberRequired?: boolean;
  };
  shippingOptionRequired?: boolean;
  shippingOptionParameters?: {
    defaultSelectedOptionId?: string;
    shippingOptions?: {
      id: string;
      label: string;
      description?: string;
    }[];
  };
  callbackIntents?: ('PAYMENT_AUTHORIZATION' | 'SHIPPING_ADDRESS' | 'SHIPPING_OPTION' | 'OFFER')[];
}

export interface GooglePayPaymentData {
  apiVersion: number;
  apiVersionMinor: number;
  paymentMethodData: {
    type: string;
    description: string;
    info: {
      cardNetwork: string;
      cardDetails: string;
      billingAddress?: {
        name: string;
        postalCode: string;
        countryCode: string;
        phoneNumber?: string;
        address1?: string;
        address2?: string;
        address3?: string;
        locality?: string;
        administrativeArea?: string;
        sortingCode?: string;
      };
    };
    tokenizationData: {
      type: string;
      token: string; // Encrypted payment token
    };
  };
  email?: string;
  shippingAddress?: {
    name: string;
    postalCode: string;
    countryCode: string;
    phoneNumber?: string;
    address1?: string;
    address2?: string;
    address3?: string;
    locality?: string;
    administrativeArea?: string;
    sortingCode?: string;
  };
}

export class DigitalWalletsService {
  // ==========================================
  // APPLE PAY
  // ==========================================

  // Register merchant for Apple Pay
  async registerApplePay(
    merchantId: string,
    config: Omit<ApplePayConfig, 'merchantId'>
  ): Promise<{ success: boolean; certificateSigningRequest?: string }> {
    // Generate merchant identity certificate CSR
    const { privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });

    // Store Apple Pay configuration
    await query(
      `INSERT INTO apple_pay_merchants (
        merchant_id, merchant_identifier, display_name, domain_names,
        merchant_capabilities, supported_networks, country_code,
        status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
      ON CONFLICT (merchant_id)
      DO UPDATE SET
        merchant_identifier = $2, display_name = $3, domain_names = $4,
        merchant_capabilities = $5, supported_networks = $6,
        country_code = $7, updated_at = NOW()`,
      [
        merchantId,
        config.merchantIdentifier,
        config.displayName,
        JSON.stringify(config.domainNames),
        JSON.stringify(config.merchantCapabilities),
        JSON.stringify(config.supportedNetworks),
        config.countryCode,
      ]
    );

    logger.info('Apple Pay merchant registered', { merchantId, merchantIdentifier: config.merchantIdentifier });

    // Return CSR for Apple to sign
    return {
      success: true,
      certificateSigningRequest: 'CSR_PLACEHOLDER', // Would be actual CSR
    };
  }

  // Verify domain for Apple Pay
  async verifyApplePayDomain(
    merchantId: string,
    domainName: string
  ): Promise<{ verificationFile: string; verificationUrl: string }> {
    // Apple requires hosting a verification file at:
    // https://domain/.well-known/apple-developer-merchantid-domain-association

    const verificationContent = `APPLE_PAY_VERIFICATION_${merchantId}_${Date.now()}`;

    await query(
      `INSERT INTO apple_pay_domain_verification (
        merchant_id, domain_name, verification_content, status, created_at
      ) VALUES ($1, $2, $3, 'pending', NOW())
      ON CONFLICT (merchant_id, domain_name)
      DO UPDATE SET verification_content = $3, status = 'pending', updated_at = NOW()`,
      [merchantId, domainName, verificationContent]
    );

    return {
      verificationFile: verificationContent,
      verificationUrl: `https://${domainName}/.well-known/apple-developer-merchantid-domain-association`,
    };
  }

  // Create Apple Pay session for payment sheet
  async createApplePaySession(
    merchantId: string,
    validationUrl: string,
    domainName: string
  ): Promise<any> {
    // Get merchant config
    const configResult = await query<any>(
      `SELECT * FROM apple_pay_merchants WHERE merchant_id = $1 AND status = 'active'`,
      [merchantId]
    );

    if (configResult.rows.length === 0) {
      throw new Error('Apple Pay not configured for this merchant');
    }

    const config = configResult.rows[0];

    // In production, would make request to Apple's validation URL
    // with merchant identity certificate
    const sessionData = {
      epochTimestamp: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
      merchantSessionIdentifier: uuidv4(),
      nonce: crypto.randomBytes(32).toString('hex'),
      merchantIdentifier: config.merchant_identifier,
      domainName,
      displayName: config.display_name,
      signature: 'APPLE_SESSION_SIGNATURE', // Would be signed by Apple
    };

    logger.info('Apple Pay session created', { merchantId, domainName });

    return sessionData;
  }

  // Process Apple Pay payment token
  async processApplePayToken(
    merchantId: string,
    token: ApplePayPaymentToken,
    amount: number,
    currency: string
  ): Promise<{ success: boolean; paymentId: string; error?: string }> {
    try {
      // Decrypt payment token using payment processing certificate
      // In production, would decrypt with merchant's payment processing private key
      const decryptedData = this.decryptApplePayToken(token);

      // Extract card details from decrypted data
      const cardDetails = {
        pan: decryptedData.applicationPrimaryAccountNumber,
        expiry: decryptedData.applicationExpirationDate,
        cryptogram: decryptedData.paymentDataType === '3DSecure'
          ? decryptedData.onlinePaymentCryptogram
          : null,
        eci: decryptedData.eciIndicator,
      };

      // Create payment with network token
      const paymentId = `pay_apple_${uuidv4().replace(/-/g, '')}`;

      await query(
        `INSERT INTO wallet_payments (
          id, merchant_id, wallet_type, amount, currency,
          card_network, card_last_four, token_transaction_id,
          status, created_at
        ) VALUES ($1, $2, 'apple_pay', $3, $4, $5, $6, $7, 'succeeded', NOW())`,
        [
          paymentId,
          merchantId,
          amount,
          currency,
          token.paymentMethod.network,
          cardDetails.pan.slice(-4),
          token.transactionIdentifier,
        ]
      );

      logger.info('Apple Pay payment processed', { merchantId, paymentId, amount });

      return { success: true, paymentId };
    } catch (error) {
      logger.error('Apple Pay payment failed', { merchantId, error });
      return {
        success: false,
        paymentId: '',
        error: error instanceof Error ? error.message : 'Payment failed'
      };
    }
  }

  private decryptApplePayToken(token: ApplePayPaymentToken): any {
    // In production, would:
    // 1. Extract ephemeral public key from header
    // 2. Generate shared secret using merchant private key
    // 3. Derive symmetric key
    // 4. Decrypt data using AES-256-GCM
    // 5. Verify signature

    // Placeholder return
    return {
      applicationPrimaryAccountNumber: '4111111111111111',
      applicationExpirationDate: '251231',
      currencyCode: '840',
      transactionAmount: 1000,
      paymentDataType: '3DSecure',
      onlinePaymentCryptogram: 'AAAAAAA=',
      eciIndicator: '05',
    };
  }

  // ==========================================
  // GOOGLE PAY
  // ==========================================

  // Register merchant for Google Pay
  async registerGooglePay(
    merchantId: string,
    config: Omit<GooglePayConfig, 'merchantId'>
  ): Promise<{ success: boolean }> {
    await query(
      `INSERT INTO google_pay_merchants (
        merchant_id, merchant_name, environment, allowed_card_networks,
        allowed_card_auth_methods, gateway_merchant_id, merchant_origin,
        status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW())
      ON CONFLICT (merchant_id)
      DO UPDATE SET
        merchant_name = $2, environment = $3, allowed_card_networks = $4,
        allowed_card_auth_methods = $5, gateway_merchant_id = $6,
        merchant_origin = $7, updated_at = NOW()`,
      [
        merchantId,
        config.merchantName,
        config.environment,
        JSON.stringify(config.allowedCardNetworks),
        JSON.stringify(config.allowedCardAuthMethods),
        config.gatewayMerchantId,
        config.merchantOrigin,
      ]
    );

    logger.info('Google Pay merchant registered', { merchantId, merchantName: config.merchantName });

    return { success: true };
  }

  // Generate Google Pay payment request
  async getGooglePayRequest(
    merchantId: string,
    transactionInfo: GooglePayPaymentRequest['transactionInfo'],
    options?: {
      emailRequired?: boolean;
      shippingAddressRequired?: boolean;
      shippingOptions?: any[];
    }
  ): Promise<GooglePayPaymentRequest> {
    // Get merchant config
    const configResult = await query<any>(
      `SELECT * FROM google_pay_merchants WHERE merchant_id = $1 AND status = 'active'`,
      [merchantId]
    );

    if (configResult.rows.length === 0) {
      throw new Error('Google Pay not configured for this merchant');
    }

    const config = configResult.rows[0];

    const request: GooglePayPaymentRequest = {
      apiVersion: 2,
      apiVersionMinor: 0,
      merchantInfo: {
        merchantId: config.gateway_merchant_id,
        merchantName: config.merchant_name,
      },
      allowedPaymentMethods: [
        {
          type: 'CARD',
          parameters: {
            allowedAuthMethods: config.allowed_card_auth_methods,
            allowedCardNetworks: config.allowed_card_networks,
            billingAddressRequired: true,
            billingAddressParameters: {
              format: 'FULL',
              phoneNumberRequired: false,
            },
          },
          tokenizationSpecification: {
            type: 'PAYMENT_GATEWAY',
            parameters: {
              gateway: 'example', // Your gateway identifier
              gatewayMerchantId: config.gateway_merchant_id,
            },
          },
        },
      ],
      transactionInfo,
      emailRequired: options?.emailRequired || false,
      shippingAddressRequired: options?.shippingAddressRequired || false,
    };

    if (options?.shippingOptions) {
      request.shippingOptionRequired = true;
      request.shippingOptionParameters = {
        shippingOptions: options.shippingOptions,
      };
    }

    return request;
  }

  // Process Google Pay payment data
  async processGooglePayData(
    merchantId: string,
    paymentData: GooglePayPaymentData,
    amount: number,
    currency: string
  ): Promise<{ success: boolean; paymentId: string; error?: string }> {
    try {
      // Decrypt payment token
      const tokenData = JSON.parse(paymentData.paymentMethodData.tokenizationData.token);

      // Token contains encrypted card data
      // In production, would decrypt using merchant's private key
      const decryptedData = this.decryptGooglePayToken(tokenData);

      const paymentId = `pay_google_${uuidv4().replace(/-/g, '')}`;

      await query(
        `INSERT INTO wallet_payments (
          id, merchant_id, wallet_type, amount, currency,
          card_network, card_last_four, email, billing_address,
          shipping_address, status, created_at
        ) VALUES ($1, $2, 'google_pay', $3, $4, $5, $6, $7, $8, $9, 'succeeded', NOW())`,
        [
          paymentId,
          merchantId,
          amount,
          currency,
          paymentData.paymentMethodData.info.cardNetwork,
          paymentData.paymentMethodData.info.cardDetails,
          paymentData.email,
          JSON.stringify(paymentData.paymentMethodData.info.billingAddress),
          JSON.stringify(paymentData.shippingAddress),
        ]
      );

      logger.info('Google Pay payment processed', { merchantId, paymentId, amount });

      return { success: true, paymentId };
    } catch (error) {
      logger.error('Google Pay payment failed', { merchantId, error });
      return {
        success: false,
        paymentId: '',
        error: error instanceof Error ? error.message : 'Payment failed'
      };
    }
  }

  private decryptGooglePayToken(tokenData: any): any {
    // In production, would:
    // 1. Verify signature
    // 2. Decrypt using merchant's private key
    // 3. Extract card details

    // Placeholder return
    return {
      pan: '4111111111111111',
      expirationMonth: 12,
      expirationYear: 2025,
      authMethod: 'CRYPTOGRAM_3DS',
      cryptogram: 'AAAAAAA=',
      eciIndicator: '05',
    };
  }

  // ==========================================
  // COMMON
  // ==========================================

  // Get wallet configuration for a merchant
  async getWalletConfig(merchantId: string): Promise<{
    applePay: boolean;
    googlePay: boolean;
    applePayConfig?: any;
    googlePayConfig?: any;
  }> {
    const [appleResult, googleResult] = await Promise.all([
      query<any>(
        `SELECT * FROM apple_pay_merchants WHERE merchant_id = $1 AND status = 'active'`,
        [merchantId]
      ),
      query<any>(
        `SELECT * FROM google_pay_merchants WHERE merchant_id = $1 AND status = 'active'`,
        [merchantId]
      ),
    ]);

    return {
      applePay: appleResult.rows.length > 0,
      googlePay: googleResult.rows.length > 0,
      applePayConfig: appleResult.rows[0] || undefined,
      googlePayConfig: googleResult.rows[0] || undefined,
    };
  }

  // List wallet payments
  async listWalletPayments(
    merchantId: string,
    options?: {
      walletType?: 'apple_pay' | 'google_pay';
      limit?: number;
      startingAfter?: string;
    }
  ): Promise<any[]> {
    let sql = `SELECT * FROM wallet_payments WHERE merchant_id = $1`;
    const params: any[] = [merchantId];
    let paramIndex = 2;

    if (options?.walletType) {
      sql += ` AND wallet_type = $${paramIndex++}`;
      params.push(options.walletType);
    }

    if (options?.startingAfter) {
      sql += ` AND created_at < (SELECT created_at FROM wallet_payments WHERE id = $${paramIndex++})`;
      params.push(options.startingAfter);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(options?.limit || 10);

    const result = await query<any>(sql, params);
    return result.rows;
  }
}

export const digitalWalletsService = new DigitalWalletsService();
