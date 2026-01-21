import { withTransaction, get, run } from './transaction';
import { STATES, EVENTS, HttpError, BookingRow } from '../types';
import { transition } from '../utils/stateMachine';
import { logger } from '../utils/logger';

interface BookingWithTripDetails extends BookingRow {
  start_date: string;
  refundable_until_days_before: number;
  cancellation_fee_percent: number;
}

/**
 * Calculate days until a given date
 */
function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return (target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Cancel a booking and process refund if applicable.
 * 
 * Refund Rules:
 * - Before cutoff: Full refund minus cancellation fee, seats released
 * - After cutoff: No refund, seats NOT released (trip is imminent)
 * 
 * @param bookingId - ID of the booking to cancel
 * @returns Updated booking with refund details
 */
export async function cancelBookingWithRefund(bookingId: string): Promise<BookingRow> {
  return withTransaction(async (db) => {
    // 1. Fetch booking with trip details for refund calculation
    const booking = await get<BookingWithTripDetails>(
      db,
      `SELECT b.*, t.start_date, t.refundable_until_days_before, t.cancellation_fee_percent
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       WHERE b.id = ?`,
      [bookingId]
    );

    if (!booking) {
      throw new HttpError(404, 'Booking not found');
    }

    // 2. Validate booking can be cancelled
    if (booking.state === STATES.CANCELLED || booking.state === STATES.EXPIRED) {
      throw new HttpError(409, 'Booking already cancelled or expired');
    }

    // 3. Calculate days until trip and determine if refundable
    const daysLeft = daysUntil(booking.start_date);
    const refundable = daysLeft > booking.refundable_until_days_before;

    // 4. Cannot cancel PENDING_PAYMENT after cutoff
    if (booking.state === STATES.PENDING_PAYMENT && !refundable) {
      throw new HttpError(409, 'Cannot cancel pending payment after refund cutoff');
    }

    // 5. Validate state transition
    const event = refundable ? EVENTS.CANCEL_BEFORE_CUTOFF : EVENTS.CANCEL_AFTER_CUTOFF;
    
    // For PENDING_PAYMENT, we need to handle differently since it's not in the transition map
    if (booking.state === STATES.PENDING_PAYMENT) {
      // Allow cancellation of pending payment before cutoff
      if (!refundable) {
        throw new HttpError(409, 'Cannot cancel pending payment after cutoff');
      }
    } else {
      // For CONFIRMED bookings, use the state machine
      transition(booking.state, event);
    }

    // 6. Calculate refund amount
    // Formula: price_at_booking × (1 - cancellation_fee_percent / 100)
    const feePercent = booking.cancellation_fee_percent || 0;
    const refundAmount = refundable
      ? Number((booking.price_at_booking * (1 - feePercent / 100)).toFixed(2))
      : 0;

    const nowIso = new Date().toISOString();

    // 7. Update booking state
    await run(
      db,
      `UPDATE bookings
       SET state = ?, refund_amount = ?, cancelled_at = ?, updated_at = ?
       WHERE id = ?`,
      [STATES.CANCELLED, refundAmount, nowIso, nowIso, bookingId]
    );

    // 8. Release seats if refundable (before cutoff)
    // Per requirements: "After cutoff... Don't release seats (trip is imminent)"
    if (refundable) {
      await run(
        db,
        'UPDATE trips SET available_seats = available_seats + ?, updated_at = ? WHERE id = ?',
        [booking.num_seats, nowIso, booking.trip_id]
      );
      logger.info('Seats released after refundable cancellation', {
        bookingId,
        tripId: booking.trip_id,
        numSeats: booking.num_seats,
      });
    }

    logger.info('Booking cancelled', {
      bookingId,
      refundable,
      refundAmount,
      daysUntilTrip: Math.round(daysLeft),
    });

    // 9. Return updated booking
    const updated = await get<BookingRow>(db, 'SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return updated!;
  });
}
