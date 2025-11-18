import { config } from '../config';
import { logger } from '../utils/logger';
import { TaxCalculation, TaxCalculationInput, TaxBreakdown } from '../types';

// Comprehensive tax rates by jurisdiction for all developed countries
const TAX_RATES: Record<string, Record<string, number>> = {
  // ==================== NORTH AMERICA ====================

  // United States - State Sales Tax Rates (2024)
  US: {
    default: 0, // No federal sales tax
    AL: 4.0,    // Alabama
    AK: 0,      // Alaska (no state sales tax)
    AZ: 5.6,    // Arizona
    AR: 6.5,    // Arkansas
    CA: 7.25,   // California
    CO: 2.9,    // Colorado
    CT: 6.35,   // Connecticut
    DE: 0,      // Delaware (no sales tax)
    DC: 6.0,    // District of Columbia
    FL: 6.0,    // Florida
    GA: 4.0,    // Georgia
    HI: 4.0,    // Hawaii
    ID: 6.0,    // Idaho
    IL: 6.25,   // Illinois
    IN: 7.0,    // Indiana
    IA: 6.0,    // Iowa
    KS: 6.5,    // Kansas
    KY: 6.0,    // Kentucky
    LA: 4.45,   // Louisiana
    ME: 5.5,    // Maine
    MD: 6.0,    // Maryland
    MA: 6.25,   // Massachusetts
    MI: 6.0,    // Michigan
    MN: 6.875,  // Minnesota
    MS: 7.0,    // Mississippi
    MO: 4.225,  // Missouri
    MT: 0,      // Montana (no sales tax)
    NE: 5.5,    // Nebraska
    NV: 6.85,   // Nevada
    NH: 0,      // New Hampshire (no sales tax)
    NJ: 6.625,  // New Jersey
    NM: 4.875,  // New Mexico
    NY: 4.0,    // New York (state only, locals add more)
    NC: 4.75,   // North Carolina
    ND: 5.0,    // North Dakota
    OH: 5.75,   // Ohio
    OK: 4.5,    // Oklahoma
    OR: 0,      // Oregon (no sales tax)
    PA: 6.0,    // Pennsylvania
    RI: 7.0,    // Rhode Island
    SC: 6.0,    // South Carolina
    SD: 4.2,    // South Dakota
    TN: 7.0,    // Tennessee
    TX: 6.25,   // Texas
    UT: 6.1,    // Utah
    VT: 6.0,    // Vermont
    VA: 5.3,    // Virginia
    WA: 6.5,    // Washington
    WV: 6.0,    // West Virginia
    WI: 5.0,    // Wisconsin
    WY: 4.0,    // Wyoming
  },

  // Canada - GST/HST/PST Rates
  CA: {
    default: 5,     // GST only (federal)
    AB: 5,          // Alberta - GST only
    BC: 12,         // British Columbia - GST + PST
    MB: 12,         // Manitoba - GST + PST
    NB: 15,         // New Brunswick - HST
    NL: 15,         // Newfoundland and Labrador - HST
    NS: 15,         // Nova Scotia - HST
    NT: 5,          // Northwest Territories - GST only
    NU: 5,          // Nunavut - GST only
    ON: 13,         // Ontario - HST
    PE: 15,         // Prince Edward Island - HST
    QC: 14.975,     // Quebec - GST + QST
    SK: 11,         // Saskatchewan - GST + PST
    YT: 5,          // Yukon - GST only
  },

  // ==================== EUROPEAN UNION ====================

  // Austria
  AT: {
    default: 20,
    reduced: 10,    // Food, books, newspapers
    superReduced: 13, // Cultural events
  },

  // Belgium
  BE: {
    default: 21,
    reduced: 12,    // Some food, social housing
    superReduced: 6, // Basic necessities
  },

  // Bulgaria
  BG: {
    default: 20,
    reduced: 9,     // Hotels, books
  },

  // Croatia
  HR: {
    default: 25,
    reduced: 13,    // Hotels, newspapers
    superReduced: 5, // Bread, milk, books
  },

  // Cyprus
  CY: {
    default: 19,
    reduced: 9,     // Hotels, restaurants
    superReduced: 5, // Food, books
  },

  // Czech Republic
  CZ: {
    default: 21,
    reduced: 15,    // Food, books
    superReduced: 10, // Medicine, books
  },

  // Denmark
  DK: {
    default: 25,
    // No reduced rates
  },

  // Estonia
  EE: {
    default: 22,
    reduced: 9,     // Books, medicine, hotels
  },

  // Finland
  FI: {
    default: 24,
    reduced: 14,    // Food, restaurants
    superReduced: 10, // Books, medicine, transport
  },

  // France
  FR: {
    default: 20,
    reduced: 10,    // Restaurants, transport
    superReduced: 5.5, // Food, books
    superSuperReduced: 2.1, // Medicine, newspapers
  },

  // Germany
  DE: {
    default: 19,
    reduced: 7,     // Food, books, newspapers
  },

  // Greece
  GR: {
    default: 24,
    reduced: 13,    // Food, energy
    superReduced: 6, // Medicine, books
  },

  // Hungary
  HU: {
    default: 27,    // Highest in EU
    reduced: 18,    // Milk, dairy
    superReduced: 5, // Medicine, books
  },

  // Ireland
  IE: {
    default: 23,
    reduced: 13.5,  // Fuel, electricity
    secondReduced: 9, // Newspapers, e-books
    superReduced: 4.8, // Food, drinks
    zero: 0,        // Books, children's clothes
  },

  // Italy
  IT: {
    default: 22,
    reduced: 10,    // Hotels, restaurants
    superReduced: 5, // Food
    superSuperReduced: 4, // Food, books
  },

  // Latvia
  LV: {
    default: 21,
    reduced: 12,    // Medicine, books
    superReduced: 5, // Fruits, vegetables
  },

  // Lithuania
  LT: {
    default: 21,
    reduced: 9,     // Books, medicine
    superReduced: 5, // Medicine
  },

  // Luxembourg
  LU: {
    default: 17,    // Lowest standard rate in EU
    reduced: 14,    // Wine, heating
    secondReduced: 8, // Gas, electricity
    superReduced: 3, // Food, books
  },

  // Malta
  MT: {
    default: 18,
    reduced: 7,     // Hotels, sports
    superReduced: 5, // Medicine, food
  },

  // Netherlands
  NL: {
    default: 21,
    reduced: 9,     // Food, books, medicine
  },

  // Poland
  PL: {
    default: 23,
    reduced: 8,     // Food, restaurants
    superReduced: 5, // Books, newspapers
  },

  // Portugal
  PT: {
    default: 23,
    reduced: 13,    // Restaurants, wine
    superReduced: 6, // Food, books
  },

  // Romania
  RO: {
    default: 19,
    reduced: 9,     // Hotels, restaurants
    superReduced: 5, // Medicine, books
  },

  // Slovakia
  SK: {
    default: 20,
    reduced: 10,    // Food, medicine, books
  },

  // Slovenia
  SI: {
    default: 22,
    reduced: 9.5,   // Food, books
    superReduced: 5, // Medicine
  },

  // Spain
  ES: {
    default: 21,
    reduced: 10,    // Food, transport
    superReduced: 4, // Bread, milk, books
  },

  // Sweden
  SE: {
    default: 25,
    reduced: 12,    // Food, hotels
    superReduced: 6, // Newspapers, transport
  },

  // ==================== OTHER EUROPE ====================

  // United Kingdom
  GB: {
    default: 20,
    reduced: 5,     // Energy, children's car seats
    zero: 0,        // Food, books, children's clothes
  },

  // Switzerland
  CH: {
    default: 8.1,   // One of the lowest in Europe
    reduced: 2.6,   // Food, medicine, books
    hotels: 3.8,    // Accommodation
  },

  // Norway
  NO: {
    default: 25,
    reduced: 15,    // Food
    superReduced: 12, // Transport, hotels, cinema
  },

  // Iceland
  IS: {
    default: 24,
    reduced: 11,    // Food, hotels, books
  },

  // Liechtenstein
  LI: {
    default: 8.1,   // Same as Switzerland
    reduced: 2.6,
  },

  // ==================== ASIA-PACIFIC ====================

  // Japan
  JP: {
    default: 10,
    reduced: 8,     // Food, newspapers
  },

  // South Korea
  KR: {
    default: 10,
  },

  // Australia
  AU: {
    default: 10,    // GST
    // Many items GST-free (fresh food, healthcare, education)
  },

  // New Zealand
  NZ: {
    default: 15,    // GST
  },

  // Singapore
  SG: {
    default: 9,     // GST (increased from 8% in 2024)
  },

  // Hong Kong
  HK: {
    default: 0,     // No GST/VAT
  },

  // Taiwan
  TW: {
    default: 5,     // VAT
  },

  // Israel
  IL: {
    default: 17,    // VAT
    eilat: 0,       // Eilat Free Trade Zone
  },

  // United Arab Emirates
  AE: {
    default: 5,     // VAT
  },

  // Saudi Arabia
  SA: {
    default: 15,    // VAT
  },
};

// Reduced rates by product type for each country
const REDUCED_RATE_PRODUCTS: Record<string, Record<string, number>> = {
  // European countries with reduced rates for specific products
  DE: { food: 7, books: 7, medicine: 7 },
  FR: { food: 5.5, books: 5.5, medicine: 2.1, transport: 10 },
  GB: { energy: 5, food: 0, books: 0, childrenClothes: 0 },
  IT: { food: 4, books: 4, medicine: 10 },
  ES: { food: 10, books: 4, medicine: 4 },
  NL: { food: 9, books: 9, medicine: 9 },
  SE: { food: 12, books: 6, transport: 6 },
  NO: { food: 15, transport: 12, hotels: 12 },
  JP: { food: 8 },
  IE: { food: 0, books: 0 },
  CH: { food: 2.6, books: 2.6, medicine: 2.6, hotels: 3.8 },
};

// Product type specific exemptions
const PRODUCT_TAX_EXEMPTIONS: Record<string, string[]> = {
  US: ['food', 'medicine', 'clothing'], // Many states exempt these
  AU: ['freshFood', 'healthcare', 'education'],
  GB: ['food', 'books', 'childrenClothes'],
  IE: ['food', 'books', 'childrenClothes'],
  HK: ['all'], // No sales tax
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

      // Check for state/region specific rate (US, CA, etc.)
      if (state && countryRates[state] !== undefined) {
        rate = countryRates[state];
      }

      // Check for product-specific reduced rate
      if (productType) {
        const productRates = REDUCED_RATE_PRODUCTS[country];
        if (productRates && productRates[productType.toLowerCase()] !== undefined) {
          rate = productRates[productType.toLowerCase()];
        }
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
      // North America
      US: 'sales_tax',
      CA: 'gst_hst',

      // European Union - VAT
      AT: 'vat', BE: 'vat', BG: 'vat', HR: 'vat', CY: 'vat',
      CZ: 'vat', DK: 'vat', EE: 'vat', FI: 'vat', FR: 'vat',
      DE: 'vat', GR: 'vat', HU: 'vat', IE: 'vat', IT: 'vat',
      LV: 'vat', LT: 'vat', LU: 'vat', MT: 'vat', NL: 'vat',
      PL: 'vat', PT: 'vat', RO: 'vat', SK: 'vat', SI: 'vat',
      ES: 'vat', SE: 'vat',

      // Other Europe
      GB: 'vat',
      CH: 'vat',
      NO: 'vat',
      IS: 'vat',
      LI: 'vat',

      // Asia-Pacific
      JP: 'consumption_tax',
      KR: 'vat',
      AU: 'gst',
      NZ: 'gst',
      SG: 'gst',
      HK: 'none',
      TW: 'vat',

      // Middle East
      IL: 'vat',
      AE: 'vat',
      SA: 'vat',
    };
    return taxTypes[country] || 'tax';
  }

  // Validate tax ID format by country
  validateTaxId(country: string, taxId: string): boolean {
    const patterns: Record<string, RegExp> = {
      // North America
      US: /^\d{2}-\d{7}$/, // EIN format
      CA: /^\d{9}[A-Z]{2}\d{4}$/, // BN format

      // European Union VAT formats
      AT: /^ATU\d{8}$/, // Austria
      BE: /^BE[01]\d{9}$/, // Belgium
      BG: /^BG\d{9,10}$/, // Bulgaria
      HR: /^HR\d{11}$/, // Croatia
      CY: /^CY\d{8}[A-Z]$/, // Cyprus
      CZ: /^CZ\d{8,10}$/, // Czech Republic
      DK: /^DK\d{8}$/, // Denmark
      EE: /^EE\d{9}$/, // Estonia
      FI: /^FI\d{8}$/, // Finland
      FR: /^FR[A-Z0-9]{2}\d{9}$/, // France
      DE: /^DE\d{9}$/, // Germany
      GR: /^EL\d{9}$/, // Greece (uses EL prefix)
      HU: /^HU\d{8}$/, // Hungary
      IE: /^IE\d{7}[A-Z]{1,2}$|^IE\d[A-Z]\d{5}[A-Z]$/, // Ireland
      IT: /^IT\d{11}$/, // Italy
      LV: /^LV\d{11}$/, // Latvia
      LT: /^LT\d{9,12}$/, // Lithuania
      LU: /^LU\d{8}$/, // Luxembourg
      MT: /^MT\d{8}$/, // Malta
      NL: /^NL\d{9}B\d{2}$/, // Netherlands
      PL: /^PL\d{10}$/, // Poland
      PT: /^PT\d{9}$/, // Portugal
      RO: /^RO\d{2,10}$/, // Romania
      SK: /^SK\d{10}$/, // Slovakia
      SI: /^SI\d{8}$/, // Slovenia
      ES: /^ES[A-Z]\d{7}[A-Z]$|^ES\d{8}[A-Z]$|^ES[A-Z]\d{8}$/, // Spain
      SE: /^SE\d{12}$/, // Sweden

      // Other Europe
      GB: /^GB\d{9}$|^GB\d{12}$|^GBGD\d{3}$|^GBHA\d{3}$/, // UK
      CH: /^CHE\d{9}(MWST|TVA|IVA)$/, // Switzerland
      NO: /^NO\d{9}MVA$/, // Norway
      IS: /^\d{5,6}$/, // Iceland
      LI: /^\d{5}$/, // Liechtenstein

      // Asia-Pacific
      JP: /^\d{13}$/, // Japan Corporate Number
      KR: /^\d{3}-\d{2}-\d{5}$/, // South Korea Business Registration
      AU: /^\d{11}$/, // Australia ABN
      NZ: /^\d{8,9}$/, // New Zealand IRD
      SG: /^\d{9}[A-Z]$|^[STFG]\d{7}[A-Z]$/, // Singapore UEN
      TW: /^\d{8}$/, // Taiwan VAT number

      // Middle East
      IL: /^\d{9}$/, // Israel
      AE: /^\d{15}$/, // UAE TRN
      SA: /^\d{15}$/, // Saudi Arabia VAT
    };

    const pattern = patterns[country.toUpperCase()];
    if (!pattern) return true; // No validation for unknown countries

    return pattern.test(taxId);
  }

  // Get product-specific reduced rate if applicable
  getProductRate(country: string, productType?: string): number {
    if (!productType) {
      return TAX_RATES[country]?.default || 0;
    }

    const productRates = REDUCED_RATE_PRODUCTS[country];
    if (productRates && productRates[productType.toLowerCase()] !== undefined) {
      return productRates[productType.toLowerCase()];
    }

    return TAX_RATES[country]?.default || 0;
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
