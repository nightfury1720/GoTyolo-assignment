import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/database';
import { STATES, HttpError, TripRow, BookingRow } from '../types';
import { Trip } from '../models/Trip';
import { Booking } from '../models/Booking';
import { logger } from '../utils/logger';

export async function createBooking(tripId: string, userId: string, numSeats: number): Promise<Booking> {
  if (!numSeats || numSeats <= 0) {
    throw new HttpError(400, 'num_seats must be greater than 0');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
  const bookingId = uuidv4();

  return db.transaction(async () => {
    const tripRow = await db.get<TripRow>(
      'SELECT * FROM trips WHERE id = ? AND status = ?',
      [tripId, 'PUBLISHED']
    );

    const trip = Trip.fromRow(tripRow);
    if (!trip) {
      throw new HttpError(404, 'Trip not found or not published');
    }

    const priceAtBooking = trip.price * numSeats;
    const nowIso = now.toISOString();
    const expiresIso = expiresAt.toISOString();

    const updateResult = await db.run(
      'UPDATE trips SET available_seats = available_seats - ?, updated_at = ? WHERE id = ? AND available_seats >= ?',
      [numSeats, nowIso, tripId, numSeats]
    );

    if (updateResult.changes === 0) {
      throw new HttpError(409, 'Not enough seats available');
    }

    await db.run(
      `INSERT INTO bookings
        (id, trip_id, user_id, num_seats, state, price_at_booking, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookingId, tripId, userId, numSeats, STATES.PENDING_PAYMENT, priceAtBooking, nowIso, expiresIso, nowIso]
    );

    logger.info('Booking created', { bookingId, tripId, userId, numSeats });

    const bookingRow = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return Booking.fromRow(bookingRow)!;
  });
}

export async function getBooking(bookingId: string): Promise<BookingRow | null> {
  const row = await db.get<BookingRow & { title: string; destination: string }>(
    `SELECT b.*, t.title, t.destination, t.start_date, t.end_date
     FROM bookings b
     JOIN trips t ON b.trip_id = t.id
     WHERE b.id = ?`,
    [bookingId]
  );
  return row || null;
}
