import { db } from '../db/database';
import { STATES, EVENTS, HttpError, BookingRow } from '../types';
import { transition } from '../utils/stateMachine';
import { logger } from '../utils/logger';

interface BookingWithTripDetails extends BookingRow {
  start_date: string;
  refundable_until_days_before: number;
  cancellation_fee_percent: number;
}

function daysUntil(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return (target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
}

export async function cancelBookingWithRefund(bookingId: string): Promise<BookingRow> {
  return db.transaction(async () => {
    const booking = await db.get<BookingWithTripDetails>(
      `SELECT b.*, t.start_date, t.refundable_until_days_before, t.cancellation_fee_percent
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       WHERE b.id = ?`,
      [bookingId]
    );

    if (!booking) {
      throw new HttpError(404, 'Booking not found');
    }

    if (booking.state === STATES.CANCELLED || booking.state === STATES.EXPIRED) {
      throw new HttpError(409, 'Booking already cancelled or expired');
    }

    // Prevent cancelling PENDING_PAYMENT bookings that have been processed by webhook
    if (booking.state === STATES.PENDING_PAYMENT && booking.idempotency_key) {
      throw new HttpError(409, 'Cannot cancel pending payment that has been processed by payment webhook');
    }

    const daysLeft = daysUntil(booking.start_date);
    const refundable = daysLeft > booking.refundable_until_days_before;

    if (booking.state === STATES.PENDING_PAYMENT && !refundable) {
      throw new HttpError(409, 'Cannot cancel pending payment after refund cutoff');
    }

    let refundAmount = 0;
    let shouldReleaseSeats = false;

    if (booking.state === STATES.PENDING_PAYMENT) {
      if (refundable) {
        const feePercent = booking.cancellation_fee_percent || 0;
        refundAmount = Number((booking.price_at_booking * (1 - feePercent / 100)).toFixed(2));
        shouldReleaseSeats = true; // Release seats immediately before cutoff
      }

    } else if (booking.state === STATES.CONFIRMED) {
      if (refundable) {
        const feePercent = booking.cancellation_fee_percent || 0;
        refundAmount = Number((booking.price_at_booking * (1 - feePercent / 100)).toFixed(2));
        shouldReleaseSeats = true; // Release seats immediately before cutoff
      } else {
        refundAmount = 0;
        // Don't release seats after cutoff (trip is imminent)
      }
    }

    const nowIso = new Date().toISOString();
    
    // Update booking state and get it back using RETURNING
    const updated = await db.get<BookingRow>(
      `UPDATE bookings SET state = ?, refund_amount = ?, cancelled_at = ?, updated_at = ? WHERE id = ? RETURNING *`,
      [STATES.CANCELLED, refundAmount, nowIso, nowIso, bookingId]
    );

    // Release seats if before cutoff
    if (shouldReleaseSeats) {
      await db.run(
        `UPDATE trips 
         SET available_seats = available_seats + ?, updated_at = ? 
         WHERE id = ?`,
        [booking.num_seats, nowIso, booking.trip_id]
      );
      
      logger.info('Seats released on cancellation', {
        tripId: booking.trip_id,
        seatsReleased: booking.num_seats,
        bookingId,
      });
    }

    logger.info('Booking cancelled successfully', {
      bookingId,
      originalState: booking.state,
      refundable,
      refundAmount,
      daysUntilTrip: Math.round(daysLeft),
    });

    return updated!;
  });
}
