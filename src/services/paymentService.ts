import { db } from '../db/database';
import { STATES, HttpError, BookingRow, ReservationRow } from '../types';
import { logger } from '../utils/logger';
import { confirmReservationInternal } from './bookingService';

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
    const existingIdem = await db.get<{ id: string }>(
      'SELECT id FROM bookings WHERE idempotency_key = ?',
      [idempotencyKey]
    );

    if (existingIdem && existingIdem.id !== bookingId) {
      logger.warn('Duplicate idempotency key for different booking', {
        idempotencyKey,
        existingBookingId: existingIdem.id,
        requestedBookingId: bookingId,
      });
      return { id: bookingId, state: 'DUPLICATE_KEY', message: 'duplicate webhook' };
    }

    const booking = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);

    if (!booking) {
      logger.warn('Webhook received for non-existent booking', { bookingId });
      return { id: bookingId, state: 'NOT_FOUND', message: 'booking not found' };
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
      try {
        const reservation = await db.get<ReservationRow>(
          'SELECT * FROM reservations WHERE booking_id = ?',
          [bookingId]
        );

        if (!reservation) {
          logger.error('No reservation found for successful payment', { bookingId });
          throw new Error('Reservation not found for booking');
        }

        await confirmReservationInternal(reservation.id);

        await db.run(
          `UPDATE bookings SET idempotency_key = ?, payment_reference = ?, updated_at = ? WHERE id = ?`,
          [idempotencyKey, idempotencyKey, nowIso, bookingId]
        );

        logger.info('Payment webhook processed successfully', {
          bookingId,
          newState: STATES.CONFIRMED,
          idempotencyKey
        });

      } catch (err) {
        logger.error('Failed to confirm reservation on payment success', {
          bookingId,
          idempotencyKey,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        throw err;
      }
    } else {
      const reservation = await db.get<ReservationRow>(
        'SELECT * FROM reservations WHERE booking_id = ?',
        [bookingId]
      );

      if (reservation) {
        await db.run('DELETE FROM reservations WHERE id = ?', [reservation.id]);
        logger.info('Reservation released due to payment failure', {
          reservationId: reservation.id,
          bookingId,
          numSeats: reservation.num_seats
        });
      }

      await db.run(
        `UPDATE bookings SET state = ?, idempotency_key = ?, payment_reference = ?, updated_at = ? WHERE id = ?`,
        [STATES.EXPIRED, idempotencyKey, idempotencyKey, nowIso, bookingId]
      );

      logger.info('Payment webhook processed - payment failed', {
        bookingId,
        newState: STATES.EXPIRED,
        idempotencyKey
      });
    }

    const updated = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return updated!;
  });
}
