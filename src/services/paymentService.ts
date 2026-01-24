import { db } from '../db/database';
import { STATES, HttpError, BookingRow } from '../types';
import { logger } from '../utils/logger';

interface WebhookResult {
  id: string;
  state: string;
  message?: string;
}

export async function processWebhook(
  bookingId: string,
  status: string,
  idempotencyKey: string
): Promise<BookingRow | WebhookResult> {
  if (!idempotencyKey) {
    throw new HttpError(400, 'idempotency_key is required');
  }

  const normalizedStatus = status?.toLowerCase();
  if (!['success', 'failed'].includes(normalizedStatus)) {
    throw new HttpError(400, 'Invalid status. Must be "success" or "failed"');
  }

  return db.transaction(async () => {
    // Check idempotency and get booking in one query using COALESCE
    const booking = await db.get<BookingRow & { existing_id?: string }>(
      `SELECT b.*, 
              (SELECT id FROM bookings WHERE idempotency_key = ? LIMIT 1) as existing_id
       FROM bookings b
       WHERE b.id = ?`,
      [idempotencyKey, bookingId]
    );

    if (!booking) {
      logger.warn('Webhook received for non-existent booking', { bookingId });
      return { id: bookingId, state: 'NOT_FOUND', message: 'booking not found' };
    }

    // Check if idempotency key exists for different booking
    if (booking.existing_id && booking.existing_id !== bookingId) {
      logger.warn('Duplicate idempotency key for different booking', {
        idempotencyKey,
        existingBookingId: booking.existing_id,
        requestedBookingId: bookingId,
      });
      return { id: bookingId, state: 'DUPLICATE_KEY', message: 'duplicate webhook' };
    }

    if (booking.idempotency_key === idempotencyKey) {
      logger.info('Duplicate webhook processed idempotently', { bookingId, idempotencyKey });
      return booking;
    }

    if (booking.state !== STATES.PENDING_PAYMENT) {
      logger.info('Webhook received for non-pending booking', {
        bookingId,
        currentState: booking.state,
        idempotencyKey
      });
      return booking;
    }

    const nowIso = new Date().toISOString();

    if (normalizedStatus === 'success') {
      // Update booking to CONFIRMED and set idempotency_key in one query, then release seats if needed
      const updated = await db.get<BookingRow>(
        `UPDATE bookings 
         SET state = ?, idempotency_key = ?, payment_reference = ?, updated_at = ? 
         WHERE id = ? 
         RETURNING *`,
        [STATES.CONFIRMED, idempotencyKey, idempotencyKey, nowIso, bookingId]
      );

      logger.info('Payment webhook processed successfully', {
        bookingId,
        newState: STATES.CONFIRMED,
        idempotencyKey
      });

      return updated!;
    } else {
      // Update booking to EXPIRED and release seats in one transaction
      const updated = await db.get<BookingRow>(
        `UPDATE bookings 
         SET state = ?, idempotency_key = ?, payment_reference = ?, updated_at = ? 
         WHERE id = ? 
         RETURNING *`,
        [STATES.EXPIRED, idempotencyKey, idempotencyKey, nowIso, bookingId]
      );

      // Release seats when payment fails
      await db.run(
        `UPDATE trips 
         SET available_seats = available_seats + ?, updated_at = ? 
         WHERE id = ?`,
        [booking.num_seats, nowIso, booking.trip_id]
      );

      logger.info('Payment webhook processed - payment failed, seats released', {
        bookingId,
        newState: STATES.EXPIRED,
        idempotencyKey,
        seatsReleased: booking.num_seats
      });

      return updated!;
    }
  });
}

