import { db } from '../db/database';
import { STATES, BookingRow } from '../types';
import { logger } from '../utils/logger';

export async function expirePendingBookings(): Promise<void> {
  const nowIso = new Date().toISOString();

  const expiredBookings = await db.all<BookingRow>(
    `SELECT * FROM bookings WHERE state = ? AND expires_at IS NOT NULL AND expires_at < ?`,
    [STATES.PENDING_PAYMENT, nowIso]
  );

  if (expiredBookings.length === 0) return;

  logger.info('Found expired bookings to process', {
    expiredBookings: expiredBookings.length,
  });

  for (const booking of expiredBookings) {
    try {
      await db.transaction(async () => {
        const fresh = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [booking.id]);

        if (!fresh || fresh.state !== STATES.PENDING_PAYMENT) return;

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
}
