import { db } from '../db/database';
import { STATES, EVENTS, BookingRow } from '../types';
import { transition } from '../utils/stateMachine';
import { logger } from '../utils/logger';

export async function expirePendingBookings(): Promise<void> {
  const nowIso = new Date().toISOString();

  const expired = await db!.all<BookingRow>(
    `SELECT * FROM bookings WHERE state = ? AND expires_at IS NOT NULL AND expires_at < ?`,
    [STATES.PENDING_PAYMENT, nowIso]
  );

  if (expired.length === 0) return;

  logger.info('Found expired bookings to process', { count: expired.length });

  for (const booking of expired) {
    try {
      await db!.transaction(async () => {
        const fresh = await db!.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [booking.id]);

        if (!fresh || fresh.state !== STATES.PENDING_PAYMENT) return;

        transition(fresh.state, EVENTS.AUTO_EXPIRE);

        await db!.run(
          'UPDATE bookings SET state = ?, updated_at = ? WHERE id = ?',
          [STATES.EXPIRED, nowIso, booking.id]
        );

        await db!.run(
          'UPDATE trips SET available_seats = available_seats + ?, updated_at = ? WHERE id = ?',
          [fresh.num_seats, nowIso, fresh.trip_id]
        );

        logger.info('Booking expired and seats released', {
          bookingId: booking.id, tripId: fresh.trip_id, numSeats: fresh.num_seats,
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
