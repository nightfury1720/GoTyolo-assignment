import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { processWebhook } from '../services/paymentService';
import { logger } from '../utils/logger';

const router = Router();

router.post(
  '/payments/webhook',
  [
    body('booking_id').optional().isString(),
    body('status').optional().isString(),
    body('idempotency_key').optional().isString(),
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Invalid webhook payload', { errors: errors.array(), body: req.body });
      return res.status(200).json({ 
        error: 'Invalid webhook payload',
        errors: errors.array() 
      });
    }

    const { booking_id, status, idempotency_key } = req.body;

    if (!booking_id || !status || !idempotency_key) {
      logger.warn('Missing required webhook fields', { body: req.body });
      return res.status(200).json({ 
        error: 'Missing required fields: booking_id, status, and idempotency_key are required' 
      });
    }

    const normalizedStatus = status?.toLowerCase();
    if (!['success', 'failed'].includes(normalizedStatus)) {
      logger.warn('Invalid status value in webhook', { status, body: req.body });
      return res.status(200).json({ 
        error: 'Invalid status. Must be "success" or "failed"' 
      });
    }

    try {
      logger.info('Received payment webhook', { booking_id, status, idempotency_key });
      
      const result = await processWebhook(booking_id, status, idempotency_key);
      
      res.status(200).json(result);
    } catch (err) {
      logger.error('Webhook processing error', {
        error: err instanceof Error ? err.message : 'Unknown error',
        body: req.body,
      });

      res.status(200).json({
        error: 'Processing error',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
);

export default router;
