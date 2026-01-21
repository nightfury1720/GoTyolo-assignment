import { v4 as uuidv4 } from 'uuid';
import { withTransaction, get, run } from './transaction';
import { STATES, HttpError, TripRow, BookingRow } from '../types';
import { Trip } from '../models/Trip';
import { Booking } from '../models/Booking';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

/**
 * Create a new booking for a trip.
 * Uses transaction with IMMEDIATE lock to prevent overbooking.
 * 
 * @param tripId - ID of the trip to book
 * @param userId - ID of the user making the booking
 * @param numSeats - Number of seats to book
 * @returns Created booking
 */
export async function createBooking(tripId: string, userId: string, numSeats: number): Promise<Booking> {
  if (!numSeats || numSeats <= 0) {
    throw new HttpError(400, 'num_seats must be greater than 0');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes
  const bookingId = uuidv4();

  return withTransaction(async (db) => {
    // 1. Fetch and lock the trip row
    const tripRow = await get<TripRow>(
      db,
      'SELECT * FROM trips WHERE id = ? AND status = ?',
      [tripId, 'PUBLISHED']
    );

    const trip = Trip.fromRow(tripRow);
    if (!trip) {
      throw new HttpError(404, 'Trip not found or not published');
    }

    // 2. Check seat availability within the transaction
    if (trip.available_seats < numSeats) {
      throw new HttpError(409, 'Not enough seats available');
    }

    const priceAtBooking = trip.price * numSeats;
    const nowIso = now.toISOString();
    const expiresIso = expiresAt.toISOString();

    // 3. Atomically decrement available seats
    await run(
      db,
      'UPDATE trips SET available_seats = available_seats - ?, updated_at = ? WHERE id = ?',
      [numSeats, nowIso, tripId]
    );

    // 4. Insert the booking record
    await run(
      db,
      `INSERT INTO bookings
        (id, trip_id, user_id, num_seats, state, price_at_booking, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bookingId,
        tripId,
        userId,
        numSeats,
        STATES.PENDING_PAYMENT,
        priceAtBooking,
        nowIso,
        expiresIso,
        nowIso,
      ]
    );

    logger.info('Booking created', { bookingId, tripId, userId, numSeats });

    // 5. Return the created booking
    const bookingRow = await get<BookingRow>(db, 'SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return Booking.fromRow(bookingRow)!;
  });
}

/**
 * Get a booking by ID with trip details
 */
export async function getBooking(bookingId: string): Promise<BookingRow | null> {
  const db = getDb();
  const row = await get<BookingRow & { title: string; destination: string }>(
    db,
    `SELECT b.*, t.title, t.destination, t.start_date, t.end_date
     FROM bookings b
     JOIN trips t ON b.trip_id = t.id
     WHERE b.id = ?`,
    [bookingId]
  );
  return row || null;
}

export { HttpError };
