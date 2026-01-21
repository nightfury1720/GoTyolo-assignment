import { db } from '../db/database';
import { STATES, EVENTS, BookingRow, ReservationRow } from '../types';
import { transition } from '../utils/stateMachine';
import { logger } from '../utils/logger';

export async function expirePendingBookings(): Promise<void> {
  const nowIso = new Date().toISOString();

  const expiredBookings = await db.all<BookingRow>(
    `SELECT * FROM bookings WHERE state = ? AND expires_at IS NOT NULL AND expires_at < ?`,
    [STATES.PENDING_PAYMENT, nowIso]
  );

  const expiredReservations = await db.all<ReservationRow>(
    `SELECT * FROM reservations WHERE expires_at < ? AND booking_id IS NOT NULL`,
    [nowIso]
  );

  const totalToProcess = expiredBookings.length + expiredReservations.length;
  if (totalToProcess === 0) return;

  logger.info('Found expired bookings and reservations to process', {
    bookings: expiredBookings.length,
    reservations: expiredReservations.length,
  });

  for (const booking of expiredBookings) {
    try {
      await db.transaction(async () => {
        const fresh = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [booking.id]);

        if (!fresh || fresh.state !== STATES.PENDING_PAYMENT) return;

        const reservation = await db.get<ReservationRow>(
          'SELECT * FROM reservations WHERE booking_id = ?',
          [booking.id]
        );

        if (reservation) {
          await db.run('DELETE FROM reservations WHERE id = ?', [reservation.id]);
          logger.info('Expired reservation deleted (never confirmed)', {
            reservationId: reservation.id,
            bookingId: booking.id,
          });
        } else {
          await db.run(
            'UPDATE trips SET available_seats = available_seats + ?, updated_at = ? WHERE id = ?',
            [fresh.num_seats, nowIso, fresh.trip_id]
          );
          logger.info('Booking expired and seats released (legacy)', {
            bookingId: booking.id,
            tripId: fresh.trip_id,
            numSeats: fresh.num_seats,
          });
        }

        transition(fresh.state, EVENTS.AUTO_EXPIRE);

        await db.run(
          'UPDATE bookings SET state = ?, updated_at = ? WHERE id = ?',
          [STATES.EXPIRED, nowIso, booking.id]
        );

        logger.info('Booking expired', {
          bookingId: booking.id,
          hadReservation: !!reservation,
        });
      });
    } catch (err) {
      logger.error('Failed to expire booking', {
        bookingId: booking.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  for (const reservation of expiredReservations) {
    try {
      await db.transaction(async () => {
        const fresh = await db.get<ReservationRow>(
          'SELECT * FROM reservations WHERE id = ?',
          [reservation.id]
        );

        if (!fresh || fresh.booking_id) return; // Already processed or has booking

        await db.run('DELETE FROM reservations WHERE id = ?', [reservation.id]);
        logger.info('Orphaned expired reservation deleted', {
          reservationId: reservation.id,
        });
      });
    } catch (err) {
      logger.error('Failed to expire reservation', {
        reservationId: reservation.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
}
