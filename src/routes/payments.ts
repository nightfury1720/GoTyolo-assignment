import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { processWebhook } from '../services/paymentService';
import { logger } from '../utils/logger';

const router = Router();

/**
 * POST /payments/webhook
 * Process payment webhook from payment provider
 * 
 * Request body:
 * - booking_id: string - ID of the booking
 * - status: 'success' | 'failed' - Payment result
 * - idempotency_key: string - Unique key for idempotent processing
 * 
 * CRITICAL: Always returns 200 OK to the payment provider, even for invalid requests.
 * This prevents the payment provider from retrying unnecessarily.
 * Actual processing status is in the response body.
 */
router.post(
  '/payments/webhook',
  [
    body('booking_id').optional().isString(),
    body('status').optional().isString(),
    body('idempotency_key').optional().isString(),
  ],
  async (req: Request, res: Response, next: NextFunction) => {
    // Always return 200 OK to payment provider, even for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Invalid webhook payload', { errors: errors.array(), body: req.body });
      return res.status(200).json({ 
        error: 'Invalid webhook payload',
        errors: errors.array() 
      });
    }

    const { booking_id, status, idempotency_key } = req.body;

    // Validate required fields manually (but still return 200)
    if (!booking_id || !status || !idempotency_key) {
      logger.warn('Missing required webhook fields', { body: req.body });
      return res.status(200).json({ 
        error: 'Missing required fields: booking_id, status, and idempotency_key are required' 
      });
    }

    // Validate status value
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
      
      // Always return 200 OK to payment provider
      res.status(200).json(result);
    } catch (err) {
      // Log the error but still return 200 to payment provider
      logger.error('Webhook processing error', {
        error: err instanceof Error ? err.message : 'Unknown error',
        body: req.body,
      });

      // Always return 200 with error details to avoid unnecessary retries
      res.status(200).json({
        error: 'Processing error',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
);

export default router;
