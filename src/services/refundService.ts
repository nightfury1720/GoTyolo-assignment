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

    const event = refundable ? EVENTS.CANCEL_BEFORE_CUTOFF : EVENTS.CANCEL_AFTER_CUTOFF;
    const nextState = booking.state === STATES.PENDING_PAYMENT
      ? STATES.CANCELLED
      : transition(booking.state, event);

    const feePercent = booking.cancellation_fee_percent || 0;
    const refundAmount = refundable
      ? Number((booking.price_at_booking * (1 - feePercent / 100)).toFixed(2))
      : 0;

    const nowIso = new Date().toISOString();

    await db.run(
      `UPDATE bookings SET state = ?, refund_amount = ?, cancelled_at = ?, updated_at = ? WHERE id = ?`,
      [nextState, refundAmount, nowIso, nowIso, bookingId]
    );

    if (booking.state === STATES.PENDING_PAYMENT) {
      if (reservation) {
        await db.run('DELETE FROM reservations WHERE id = ?', [reservation.id]);
        logger.info('Reservation deleted on cancellation (never confirmed)', {
          reservationId: reservation.id,
          bookingId,
        });
      }
    } else if (booking.state === STATES.CONFIRMED) {
      await db.run(
        'UPDATE trips SET available_seats = available_seats + ?, updated_at = ? WHERE id = ?',
        [booking.num_seats, nowIso, booking.trip_id]
      );
      logger.info('Seats released on confirmed booking cancellation', {
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
      hadReservation: !!reservation,
      wasPending: booking.state === STATES.PENDING_PAYMENT,
    });

    const updated = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return updated!;
  });
}
