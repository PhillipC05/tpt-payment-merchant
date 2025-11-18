import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { webhookService } from '../services/webhook.service';
import { merchantService } from '../services/merchant.service';

const updateWebhookSchema = z.object({
  webhookUrl: z.string().url(),
});

export class WebhookController {
  async getEvents(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const events = await webhookService.getEvents(req.merchantId!, limit);

      res.json(events);
    } catch (error) {
      next(error);
    }
  }

  async getEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await webhookService.getEvent(
        req.params.id,
        req.merchantId!
      );

      res.json(event);
    } catch (error) {
      next(error);
    }
  }

  async retryEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const success = await webhookService.retry(
        req.params.id,
        req.merchantId!
      );

      res.json({ success });
    } catch (error) {
      next(error);
    }
  }

  async updateWebhookUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const data = updateWebhookSchema.parse(req.body);
      const merchant = await merchantService.update(req.merchantId!, {
        webhookUrl: data.webhookUrl,
      });

      res.json({
        webhookUrl: merchant.webhookUrl,
        message: 'Webhook URL updated',
      });
    } catch (error) {
      next(error);
    }
  }

  async getWebhookSecret(req: Request, res: Response, next: NextFunction) {
    try {
      const secret = await merchantService.getWebhookSecret(req.merchantId!);

      res.json({ webhookSecret: secret });
    } catch (error) {
      next(error);
    }
  }
}

export const webhookController = new WebhookController();
