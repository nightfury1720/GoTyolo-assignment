import { db } from '../db/database';
import { STATES, EVENTS, BookingRow, ReservationRow } from '../types';
import { transition } from '../utils/stateMachine';
import { logger } from '../utils/logger';

export async function expirePendingBookings(): Promise<void> {
  const nowIso = new Date().toISOString();

  // Find expired bookings that are still in PENDING_PAYMENT state
  const expiredBookings = await db.all<BookingRow>(
    `SELECT * FROM bookings WHERE state = ? AND expires_at IS NOT NULL AND expires_at < ?`,
    [STATES.PENDING_PAYMENT, nowIso]
  );

  // Find expired reservations that haven't been confirmed (no booking_id or booking still pending)
  const expiredReservations = await db.all<ReservationRow>(
    `SELECT r.* FROM reservations r
     LEFT JOIN bookings b ON r.booking_id = b.id
     WHERE r.expires_at < ?
     AND (r.booking_id IS NULL OR b.state = ?)`,
    [nowIso, STATES.PENDING_PAYMENT]
  );

  const totalToProcess = expiredBookings.length + expiredReservations.length;
  if (totalToProcess === 0) return;

  logger.info('Found expired bookings and reservations to process', {
    expiredBookings: expiredBookings.length,
    expiredReservations: expiredReservations.length,
  });

  // Process expired bookings
  for (const booking of expiredBookings) {
    try {
      await db.transaction(async () => {
        const fresh = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [booking.id]);

        if (!fresh || fresh.state !== STATES.PENDING_PAYMENT) return;

        // Get and delete the associated reservation to release seats
        const reservation = await db.get<ReservationRow>(
          'SELECT * FROM reservations WHERE booking_id = ?',
          [booking.id]
        );

        if (reservation) {
          await db.run('DELETE FROM reservations WHERE id = ?', [reservation.id]);
          logger.info('Reservation released due to booking expiry', {
            reservationId: reservation.id,
            bookingId: booking.id,
            numSeats: reservation.num_seats,
            tripId: reservation.trip_id
          });
        }

        // Mark booking as expired
        await db.run(
          'UPDATE bookings SET state = ?, updated_at = ? WHERE id = ?',
          [STATES.EXPIRED, nowIso, booking.id]
        );

        logger.info('Booking auto-expired', {
          bookingId: booking.id,
          tripId: booking.trip_id,
          numSeats: booking.num_seats,
          expiredAt: booking.expires_at
        });
      });
    } catch (err) {
      logger.error('Failed to expire booking', {
        bookingId: booking.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Clean up expired reservations (orphaned reservations that never became bookings)
  for (const reservation of expiredReservations) {
    try {
      await db.transaction(async () => {
        const fresh = await db.get<ReservationRow>(
          'SELECT * FROM reservations WHERE id = ?',
          [reservation.id]
        );

        if (!fresh) return; // Already deleted

        await db.run('DELETE FROM reservations WHERE id = ?', [reservation.id]);
        logger.info('Expired reservation cleaned up', {
          reservationId: reservation.id,
          tripId: reservation.trip_id,
          numSeats: reservation.num_seats,
          userId: reservation.user_id,
          expiredAt: reservation.expires_at
        });
      });
    } catch (err) {
      logger.error('Failed to clean up expired reservation', {
        reservationId: reservation.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
}
