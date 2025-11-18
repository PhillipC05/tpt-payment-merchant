import { query } from '../database/connection';
import { DashboardMetrics, RevenueReport, CohortAnalysis } from '../types';

export class ReportingService {
  async getDashboardMetrics(merchantId: string, startDate: Date, endDate: Date): Promise<DashboardMetrics> {
    // Main metrics
    const metricsResult = await query<any>(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'completed' AND type = 'charge' THEN amount ELSE 0 END), 0) as total_revenue,
        COUNT(CASE WHEN type = 'charge' THEN 1 END) as total_transactions,
        COUNT(CASE WHEN status = 'completed' AND type = 'charge' THEN 1 END) as successful,
        COALESCE(AVG(CASE WHEN status = 'completed' AND type = 'charge' THEN amount END), 0) as avg_value,
        COALESCE(SUM(CASE WHEN type = 'refund' THEN amount ELSE 0 END), 0) as refunds
      FROM transactions WHERE merchant_id = $1 AND created_at >= $2 AND created_at <= $3
    `, [merchantId, startDate, endDate]);

    // Disputes
    const disputeResult = await query<any>(`
      SELECT COUNT(*) as count FROM disputes
      WHERE merchant_id = $1 AND created_at >= $2 AND created_at <= $3
    `, [merchantId, startDate, endDate]);

    // Revenue by day
    const dailyResult = await query<any>(`
      SELECT DATE(created_at) as date, SUM(amount) as amount
      FROM transactions WHERE merchant_id = $1 AND type = 'charge' AND status = 'completed'
        AND created_at >= $2 AND created_at <= $3
      GROUP BY DATE(created_at) ORDER BY date
    `, [merchantId, startDate, endDate]);

    // Status breakdown
    const statusResult = await query<any>(`
      SELECT status, COUNT(*) as count FROM transactions
      WHERE merchant_id = $1 AND created_at >= $2 AND created_at <= $3
      GROUP BY status
    `, [merchantId, startDate, endDate]);

    // Top customers
    const customersResult = await query<any>(`
      SELECT customer_id, SUM(amount) as total_spent FROM transactions
      WHERE merchant_id = $1 AND type = 'charge' AND status = 'completed' AND customer_id IS NOT NULL
        AND created_at >= $2 AND created_at <= $3
      GROUP BY customer_id ORDER BY total_spent DESC LIMIT 10
    `, [merchantId, startDate, endDate]);

    const m = metricsResult.rows[0];
    const total = parseInt(m.total_transactions) || 1;
    const successful = parseInt(m.successful);

    return {
      totalRevenue: parseInt(m.total_revenue),
      totalTransactions: total,
      successRate: (successful / total) * 100,
      averageTransactionValue: Math.round(parseFloat(m.avg_value)),
      refundRate: total > 0 ? (parseInt(m.refunds) / parseInt(m.total_revenue) * 100) : 0,
      chargebackRate: total > 0 ? (parseInt(disputeResult.rows[0].count) / total * 100) : 0,
      revenueByDay: dailyResult.rows.map(r => ({ date: r.date.toISOString().split('T')[0], amount: parseInt(r.amount) })),
      transactionsByStatus: statusResult.rows.map(r => ({ status: r.status, count: parseInt(r.count) })),
      topCustomers: customersResult.rows.map(r => ({ customerId: r.customer_id, totalSpent: parseInt(r.total_spent) })),
      paymentMethodBreakdown: [], // Would need payment method tracking
    };
  }

  async getRevenueReport(merchantId: string, startDate: Date, endDate: Date, groupBy: 'day' | 'week' | 'month' = 'day'): Promise<RevenueReport[]> {
    const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : groupBy === 'week' ? 'IYYY-IW' : 'YYYY-MM';

    const result = await query<any>(`
      SELECT
        TO_CHAR(created_at, '${dateFormat}') as period,
        SUM(CASE WHEN type = 'charge' AND status = 'completed' THEN amount ELSE 0 END) as gross,
        SUM(CASE WHEN type = 'refund' THEN amount ELSE 0 END) as refunds,
        SUM(CASE WHEN type = 'charge' AND status = 'completed' THEN fee ELSE 0 END) as fees,
        COUNT(CASE WHEN type = 'charge' THEN 1 END) as count
      FROM transactions WHERE merchant_id = $1 AND created_at >= $2 AND created_at <= $3
      GROUP BY TO_CHAR(created_at, '${dateFormat}') ORDER BY period
    `, [merchantId, startDate, endDate]);

    return result.rows.map(r => ({
      period: r.period,
      grossRevenue: parseInt(r.gross),
      refunds: parseInt(r.refunds),
      fees: parseInt(r.fees),
      netRevenue: parseInt(r.gross) - parseInt(r.refunds) - parseInt(r.fees),
      transactionCount: parseInt(r.count),
    }));
  }

  async getCohortAnalysis(merchantId: string, months: number = 6): Promise<CohortAnalysis[]> {
    const result = await query<any>(`
      WITH cohorts AS (
        SELECT customer_id, DATE_TRUNC('month', MIN(created_at)) as cohort_month
        FROM transactions WHERE merchant_id = $1 AND type = 'charge' AND status = 'completed'
        GROUP BY customer_id
      ),
      retention AS (
        SELECT c.cohort_month, DATE_TRUNC('month', t.created_at) as activity_month,
          COUNT(DISTINCT t.customer_id) as customers
        FROM cohorts c
        JOIN transactions t ON c.customer_id = t.customer_id AND t.merchant_id = $1
        WHERE t.type = 'charge' AND t.status = 'completed'
        GROUP BY c.cohort_month, DATE_TRUNC('month', t.created_at)
      )
      SELECT cohort_month, array_agg(customers ORDER BY activity_month) as retention,
        (SELECT SUM(amount) FROM transactions WHERE customer_id IN
          (SELECT customer_id FROM cohorts WHERE cohort_month = r.cohort_month)
        ) as ltv
      FROM retention r GROUP BY cohort_month ORDER BY cohort_month DESC LIMIT $2
    `, [merchantId, months]);

    return result.rows.map(r => ({
      cohort: r.cohort_month.toISOString().substring(0, 7),
      customers: r.retention[0] || 0,
      retention: r.retention.map((v: number, i: number) => i === 0 ? 100 : (v / r.retention[0] * 100)),
      ltv: parseInt(r.ltv) / (r.retention[0] || 1),
    }));
  }

  async exportTransactions(merchantId: string, startDate: Date, endDate: Date, format: 'csv' | 'json' = 'csv'): Promise<string> {
    const result = await query<any>(`
      SELECT id, type, status, amount, currency, fee, net_amount, customer_id,
        gateway_reference, created_at FROM transactions
      WHERE merchant_id = $1 AND created_at >= $2 AND created_at <= $3
      ORDER BY created_at DESC
    `, [merchantId, startDate, endDate]);

    if (format === 'json') {
      return JSON.stringify(result.rows, null, 2);
    }

    // CSV format
    const headers = ['id', 'type', 'status', 'amount', 'currency', 'fee', 'net_amount', 'customer_id', 'gateway_reference', 'created_at'];
    const csv = [headers.join(',')];
    for (const row of result.rows) {
      csv.push(headers.map(h => `"${row[h] || ''}"`).join(','));
    }
    return csv.join('\n');
  }
}

export const reportingService = new ReportingService();
