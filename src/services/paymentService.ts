import { withTransaction, get, run } from './transaction';
import { STATES, EVENTS, HttpError, BookingRow } from '../types';
import { transition } from '../utils/stateMachine';
import { logger } from '../utils/logger';

interface WebhookResult {
  id: string;
  state: string;
  message?: string;
}

/**
 * Process a payment webhook from the payment provider.
 * Handles idempotency to prevent duplicate processing.
 * 
 * @param bookingId - ID of the booking
 * @param status - Payment status ('success' or 'failed')
 * @param idempotencyKey - Unique key for idempotent processing
 * @returns Updated booking or result message
 */
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

  return withTransaction(async (db) => {
    // 1. Check if this idempotency_key was already used for a different booking
    const existingIdem = await get<{ id: string }>(
      db,
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

    // 2. Fetch the booking
    const booking = await get<BookingRow>(db, 'SELECT * FROM bookings WHERE id = ?', [bookingId]);

    if (!booking) {
      logger.warn('Webhook received for non-existent booking', { bookingId });
      return { id: bookingId, state: 'NOT_FOUND' };
    }

    // 3. If already processed with same key, return current state (idempotent)
    if (booking.idempotency_key === idempotencyKey) {
      logger.info('Duplicate webhook processed idempotently', { bookingId, idempotencyKey });
      return booking;
    }

    // 4. Only process if still in PENDING_PAYMENT state
    if (booking.state !== STATES.PENDING_PAYMENT) {
      logger.info('Webhook received for non-pending booking', {
        bookingId,
        currentState: booking.state,
      });
      return booking;
    }

    // 5. Determine the event and next state
    const event = normalizedStatus === 'success' ? EVENTS.PAYMENT_SUCCESS : EVENTS.PAYMENT_FAILED;
    const nextState = transition(booking.state, event);
    const nowIso = new Date().toISOString();

    // 6. If payment failed, release seats back to the trip
    if (nextState === STATES.EXPIRED) {
      await run(
        db,
        'UPDATE trips SET available_seats = available_seats + ?, updated_at = ? WHERE id = ?',
        [booking.num_seats, nowIso, booking.trip_id]
      );
      logger.info('Seats released due to payment failure', {
        bookingId,
        tripId: booking.trip_id,
        numSeats: booking.num_seats,
      });
    }

    // 7. Update booking with new state and idempotency key
    await run(
      db,
      `UPDATE bookings
       SET state = ?, idempotency_key = ?, updated_at = ?, payment_reference = ?
       WHERE id = ?`,
      [
        nextState,
        idempotencyKey,
        nowIso,
        booking.payment_reference || idempotencyKey,
        bookingId,
      ]
    );

    logger.info('Payment webhook processed', {
      bookingId,
      status: normalizedStatus,
      newState: nextState,
    });

    // 8. Return updated booking
    const updated = await get<BookingRow>(db, 'SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return updated!;
  });
}
