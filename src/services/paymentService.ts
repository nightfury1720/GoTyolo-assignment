import { db } from '../db/database';
import { STATES, EVENTS, HttpError, BookingRow, ReservationRow } from '../types';
import { transition } from '../utils/stateMachine';
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
      return { id: bookingId, state: 'UNKNOWN', message: 'duplicate webhook' };
    }

    const booking = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);

    if (!booking) {
      logger.warn('Webhook received for non-existent booking', { bookingId });
      return { id: bookingId, state: 'NOT_FOUND' };
    }

    if (booking.idempotency_key === idempotencyKey) {
      logger.info('Duplicate webhook processed idempotently', { bookingId, idempotencyKey });
      return booking;
    }

    if (booking.state !== STATES.PENDING_PAYMENT) {
      logger.info('Webhook received for non-pending booking', { bookingId, currentState: booking.state });
      return booking;
    }

    const nowIso = new Date().toISOString();

    if (normalizedStatus === 'success') {
      try {
        const reservation = await db.get<ReservationRow>(
          'SELECT * FROM reservations WHERE booking_id = ?',
          [bookingId]
        );

        if (reservation) {
          await confirmReservationInternal(reservation.id);
        } else {
          await db.run(
            'UPDATE trips SET available_seats = available_seats - ?, updated_at = ? WHERE id = ? AND available_seats >= ?',
            [booking.num_seats, nowIso, booking.trip_id, booking.num_seats]
          );

          const event = EVENTS.PAYMENT_SUCCESS;
          const nextState = transition(booking.state, event);
          await db.run(
            `UPDATE bookings SET state = ?, idempotency_key = ?, updated_at = ?, payment_reference = ? WHERE id = ?`,
            [nextState, idempotencyKey, nowIso, booking.payment_reference || idempotencyKey, bookingId]
          );

          logger.info('Payment webhook processed (legacy path)', { bookingId, newState: nextState });
        }
      } catch (err) {
        logger.error('Failed to confirm reservation on payment success', {
          bookingId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        throw err;
      }
    } else {
      const event = EVENTS.PAYMENT_FAILED;
      const nextState = transition(booking.state, event);

      const reservation = await db.get<ReservationRow>(
        'SELECT * FROM reservations WHERE booking_id = ?',
        [bookingId]
      );

      if (reservation) {
        await db.run('DELETE FROM reservations WHERE id = ?', [reservation.id]);
        logger.info('Reservation released due to payment failure', { reservationId: reservation.id });
      }

      await db.run(
        `UPDATE bookings SET state = ?, idempotency_key = ?, updated_at = ?, payment_reference = ? WHERE id = ?`,
        [nextState, idempotencyKey, nowIso, booking.payment_reference || idempotencyKey, bookingId]
      );

      logger.info('Payment webhook processed - payment failed', { bookingId, newState: nextState });
    }

    const updated = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return updated!;
  });
}
