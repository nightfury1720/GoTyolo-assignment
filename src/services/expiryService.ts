import { withTransaction, get, run, all } from './transaction';
import { getDb } from '../db/database';
import { STATES, EVENTS, BookingRow } from '../types';
import { transition } from '../utils/stateMachine';
import { logger } from '../utils/logger';

/**
 * Expire all pending bookings that have passed their expires_at timestamp.
 * This function is called by a cron job every minute.
 * 
 * For each expired booking:
 * 1. Transition state from PENDING_PAYMENT to EXPIRED
 * 2. Release reserved seats back to the trip
 */
export async function expirePendingBookings(): Promise<void> {
  const db = getDb();
  const nowIso = new Date().toISOString();

  // Find all bookings that should be expired
  const expired = await all<BookingRow>(
    db,
    `SELECT * FROM bookings
     WHERE state = ? AND expires_at IS NOT NULL AND expires_at < ?`,
    [STATES.PENDING_PAYMENT, nowIso]
  );

  if (expired.length === 0) {
    return;
  }

  logger.info('Found expired bookings to process', { count: expired.length });

  // Process each booking in its own transaction for isolation
  for (const booking of expired) {
    try {
      await withTransaction(async (txDb) => {
        // Re-fetch within transaction to avoid race conditions
        const fresh = await get<BookingRow>(txDb, 'SELECT * FROM bookings WHERE id = ?', [booking.id]);

        // Skip if already processed or no longer in PENDING_PAYMENT
        if (!fresh || fresh.state !== STATES.PENDING_PAYMENT) {
          return;
        }

        // Validate state transition
        transition(fresh.state, EVENTS.AUTO_EXPIRE);

        // Update booking state to EXPIRED
        await run(
          txDb,
          'UPDATE bookings SET state = ?, updated_at = ? WHERE id = ?',
          [STATES.EXPIRED, nowIso, booking.id]
        );

        // Release seats back to the trip
        await run(
          txDb,
          'UPDATE trips SET available_seats = available_seats + ?, updated_at = ? WHERE id = ?',
          [fresh.num_seats, nowIso, fresh.trip_id]
        );

        logger.info('Booking expired and seats released', {
          bookingId: booking.id,
          tripId: fresh.trip_id,
          numSeats: fresh.num_seats,
        });
      });
    } catch (err) {
      // Log error but continue processing other bookings
      logger.error('Failed to expire booking', {
        bookingId: booking.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
}
