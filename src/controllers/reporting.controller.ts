import { Request, Response, NextFunction } from 'express';
import { reportingService } from '../services/reporting.service';

export class ReportingController {
  async getDashboard(req: Request, res: Response, next: NextFunction) {
    try {
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
      const metrics = await reportingService.getDashboardMetrics(req.merchantId!, startDate, endDate);
      res.json(metrics);
    } catch (error) { next(error); }
  }

  async getRevenueReport(req: Request, res: Response, next: NextFunction) {
    try {
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
      const groupBy = (req.query.groupBy as 'day' | 'week' | 'month') || 'day';
      const report = await reportingService.getRevenueReport(req.merchantId!, startDate, endDate, groupBy);
      res.json(report);
    } catch (error) { next(error); }
  }

  async getCohortAnalysis(req: Request, res: Response, next: NextFunction) {
    try {
      const months = req.query.months ? parseInt(req.query.months as string) : 6;
      const analysis = await reportingService.getCohortAnalysis(req.merchantId!, months);
      res.json(analysis);
    } catch (error) { next(error); }
  }

  async exportTransactions(req: Request, res: Response, next: NextFunction) {
    try {
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
      const format = (req.query.format as 'csv' | 'json') || 'csv';
      const data = await reportingService.exportTransactions(req.merchantId!, startDate, endDate, format);

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
      }
      res.send(data);
    } catch (error) { next(error); }
  }
}

export const reportingController = new ReportingController();
