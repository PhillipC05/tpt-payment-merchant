import { config } from '../config';
import { logger } from '../utils/logger';
import { TaxCalculation, TaxCalculationInput, TaxBreakdown } from '../types';

// Tax rates by jurisdiction (simplified example)
const TAX_RATES: Record<string, Record<string, number>> = {
  US: {
    default: 0,
    CA: 7.25,
    NY: 8.0,
    TX: 6.25,
    FL: 6.0,
    WA: 6.5,
    // Add more states as needed
  },
  CA: {
    default: 5, // GST
    ON: 13, // HST
    BC: 12,
    AB: 5,
    QC: 14.975,
  },
  GB: {
    default: 20, // VAT
  },
  DE: {
    default: 19, // VAT
  },
  FR: {
    default: 20, // VAT
  },
  // Add more countries as needed
};

// Product type specific rates
const PRODUCT_TAX_EXEMPTIONS: Record<string, string[]> = {
  US: ['food', 'medicine', 'clothing'], // Many states exempt these
};

export class TaxService {
  async calculateTax(input: TaxCalculationInput): Promise<TaxCalculation> {
    const { amount, currency, customerAddress, productType } = input;

    // Use external provider if configured
    if (config.taxServiceProvider !== 'internal' && config.taxApiKey) {
      return this.calculateWithExternalProvider(input);
    }

    // Internal calculation
    const breakdown: TaxBreakdown[] = [];
    let totalTaxAmount = 0;

    const country = customerAddress.country.toUpperCase();
    const state = customerAddress.state?.toUpperCase();

    // Check for exemptions
    if (productType && this.isExempt(country, productType)) {
      return {
        subtotal: amount,
        taxAmount: 0,
        total: amount,
        breakdown: [],
      };
    }

    // Get applicable rate
    const countryRates = TAX_RATES[country];
    if (countryRates) {
      let rate = countryRates.default || 0;

      // Check for state/region specific rate
      if (state && countryRates[state]) {
        rate = countryRates[state];
      }

      if (rate > 0) {
        const taxAmount = Math.round(amount * (rate / 100));
        totalTaxAmount += taxAmount;

        breakdown.push({
          jurisdiction: state ? `${country}-${state}` : country,
          taxType: this.getTaxType(country),
          rate,
          amount: taxAmount,
        });
      }
    }

    logger.debug('Tax calculated', {
      country,
      state,
      amount,
      taxAmount: totalTaxAmount,
    });

    return {
      subtotal: amount,
      taxAmount: totalTaxAmount,
      total: amount + totalTaxAmount,
      breakdown,
    };
  }

  private async calculateWithExternalProvider(
    input: TaxCalculationInput
  ): Promise<TaxCalculation> {
    // Placeholder for external tax provider integration
    // (TaxJar, Avalara, etc.)
    logger.warn('External tax provider not implemented, using internal calculation');
    return this.calculateTax({ ...input });
  }

  private isExempt(country: string, productType: string): boolean {
    const exemptions = PRODUCT_TAX_EXEMPTIONS[country];
    if (!exemptions) return false;
    return exemptions.includes(productType.toLowerCase());
  }

  private getTaxType(country: string): string {
    const taxTypes: Record<string, string> = {
      US: 'sales_tax',
      CA: 'gst_hst',
      GB: 'vat',
      DE: 'vat',
      FR: 'vat',
      AU: 'gst',
    };
    return taxTypes[country] || 'tax';
  }

  // Validate tax ID format by country
  validateTaxId(country: string, taxId: string): boolean {
    const patterns: Record<string, RegExp> = {
      US: /^\d{2}-\d{7}$/, // EIN format
      CA: /^\d{9}[A-Z]{2}\d{4}$/, // BN format
      GB: /^GB\d{9}$|^GB\d{12}$|^GBGD\d{3}$|^GBHA\d{3}$/, // VAT format
      DE: /^DE\d{9}$/, // VAT format
      FR: /^FR[A-Z0-9]{2}\d{9}$/, // VAT format
    };

    const pattern = patterns[country.toUpperCase()];
    if (!pattern) return true; // No validation for unknown countries

    return pattern.test(taxId);
  }

  // Get tax rates for a jurisdiction (for display purposes)
  getTaxRates(country: string): { jurisdiction: string; rate: number }[] {
    const countryRates = TAX_RATES[country.toUpperCase()];
    if (!countryRates) return [];

    return Object.entries(countryRates).map(([key, rate]) => ({
      jurisdiction: key === 'default' ? country : `${country}-${key}`,
      rate,
    }));
  }
}

export const taxService = new TaxService();
