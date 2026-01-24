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
        // Update booking state and check if it was still pending in one query using RETURNING
        const updated = await db.get<BookingRow>(
          `UPDATE bookings 
           SET state = ?, updated_at = ? 
           WHERE id = ? AND state = ? 
           RETURNING *`,
          [STATES.EXPIRED, nowIso, booking.id, STATES.PENDING_PAYMENT]
        );

        // Only release seats if booking was actually updated (was still pending)
        if (updated) {
          // Release seats when booking expires
          await db.run(
            `UPDATE trips 
             SET available_seats = available_seats + ?, updated_at = ? 
             WHERE id = ?`,
            [updated.num_seats, nowIso, updated.trip_id]
          );

          logger.info('Booking auto-expired and seats released', {
            bookingId: booking.id,
            tripId: booking.trip_id,
            numSeats: booking.num_seats,
            expiredAt: booking.expires_at
          });
        }
      });
    } catch (err) {
      logger.error('Failed to expire booking', {
        bookingId: booking.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
}
