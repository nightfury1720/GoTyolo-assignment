import { db } from '../db/database';
import { STATES, EVENTS, HttpError, BookingRow, ReservationRow } from '../types';
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

    const daysLeft = daysUntil(booking.start_date);
    const refundable = daysLeft > booking.refundable_until_days_before;

    if (booking.state === STATES.PENDING_PAYMENT && !refundable) {
      throw new HttpError(409, 'Cannot cancel pending payment after refund cutoff');
    }

    const reservation = await db.get<ReservationRow>(
      'SELECT * FROM reservations WHERE booking_id = ?',
      [bookingId]
    );

    let refundAmount = 0;

    if (booking.state === STATES.PENDING_PAYMENT) {
      if (reservation) {
        await db.run('DELETE FROM reservations WHERE id = ?', [reservation.id]);
        logger.info('Reservation released on pending payment cancellation', {
          reservationId: reservation.id,
          bookingId,
          numSeats: reservation.num_seats
        });
      }

      if (refundable) {
        const feePercent = booking.cancellation_fee_percent || 0;
        refundAmount = Number((booking.price_at_booking * (1 - feePercent / 100)).toFixed(2));
      }

    } else if (booking.state === STATES.CONFIRMED) {
      const event = refundable ? EVENTS.CANCEL_BEFORE_CUTOFF : EVENTS.CANCEL_AFTER_CUTOFF;
      const nextState = transition(booking.state, event);

      if (refundable) {
        const feePercent = booking.cancellation_fee_percent || 0;
        refundAmount = Number((booking.price_at_booking * (1 - feePercent / 100)).toFixed(2));
      } else {
        refundAmount = 0;
      }

      await db.run(
        `UPDATE bookings SET state = ?, refund_amount = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`,
        [nextState, refundAmount, new Date().toISOString(), new Date().toISOString(), bookingId]
      );
    }

    const nowIso = new Date().toISOString();
    await db.run(
      `UPDATE bookings SET state = ?, refund_amount = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`,
      [STATES.CANCELLED, refundAmount, nowIso, nowIso, bookingId]
    );

    logger.info('Booking cancelled successfully', {
      bookingId,
      originalState: booking.state,
      refundable,
      refundAmount,
      daysUntilTrip: Math.round(daysLeft),
      hadReservation: !!reservation,
    });

    const updated = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return updated!;
  });
}
