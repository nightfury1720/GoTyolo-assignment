import { db } from '../db/database';
import { STATES, EVENTS, HttpError, BookingRow } from '../types';
import { transition } from '../utils/stateMachine';
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

  return db!.transaction(async () => {
    const existingIdem = await db!.get<{ id: string }>(
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

    const booking = await db!.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);

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

    const event = normalizedStatus === 'success' ? EVENTS.PAYMENT_SUCCESS : EVENTS.PAYMENT_FAILED;
    const nextState = transition(booking.state, event);
    const nowIso = new Date().toISOString();

    if (nextState === STATES.EXPIRED) {
      await db!.run(
        'UPDATE trips SET available_seats = available_seats + ?, updated_at = ? WHERE id = ?',
        [booking.num_seats, nowIso, booking.trip_id]
      );
      logger.info('Seats released due to payment failure', {
        bookingId, tripId: booking.trip_id, numSeats: booking.num_seats,
      });
    }

    await db!.run(
      `UPDATE bookings SET state = ?, idempotency_key = ?, updated_at = ?, payment_reference = ? WHERE id = ?`,
      [nextState, idempotencyKey, nowIso, booking.payment_reference || idempotencyKey, bookingId]
    );

    logger.info('Payment webhook processed', { bookingId, status: normalizedStatus, newState: nextState });

    const updated = await db!.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return updated!;
  });
}
