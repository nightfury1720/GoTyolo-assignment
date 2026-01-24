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
      'SELECT * FROM trips WHERE id = ? AND status = ? FOR UPDATE',
      [tripId, 'PUBLISHED']
    );

    const trip = Trip.fromRow(tripRow);
    if (!trip) {
      throw new HttpError(404, 'Trip not found or not published');
    }

    // Calculate seats to release from expired bookings BEFORE updating them
    const expiredSeatsResult = await db.get<{ expired_seats: number }>(
      `SELECT COALESCE(SUM(num_seats), 0) as expired_seats
       FROM bookings
       WHERE trip_id = ? AND state = ? AND expires_at < ?`,
      [tripId, STATES.PENDING_PAYMENT, now.toISOString()]
    );

    const expiredSeats = expiredSeatsResult?.expired_seats || 0;
    const nowIso = now.toISOString();
    const expiresIso = expiresAt.toISOString();
    const priceAtBooking = trip.price * numSeats;

    // Expire old pending bookings and update trip seats in one go
    // First expire bookings
    if (expiredSeats > 0) {
      await db.run(
        `UPDATE bookings
         SET state = ?, updated_at = ?
         WHERE trip_id = ? AND state = ? AND expires_at < ?`,
        [STATES.EXPIRED, nowIso, tripId, STATES.PENDING_PAYMENT, now.toISOString()]
      );
    }

    // Calculate available seats: current - expired seats (to be released) - new booking seats
    const currentAvailableSeats = trip.available_seats + expiredSeats;
    const finalAvailableSeats = currentAvailableSeats - numSeats;

    // Check if enough seats are available (prevent negative available_seats)
    if (finalAvailableSeats < 0) {
      throw new HttpError(409, `Not enough seats available. ${currentAvailableSeats} seats remaining, ${numSeats} requested`);
    }

    // Update trip: release expired seats and decrement for new booking in one UPDATE
    await db.run(
      `UPDATE trips 
       SET available_seats = available_seats + ? - ?, updated_at = ? 
       WHERE id = ?`,
      [expiredSeats, numSeats, nowIso, tripId]
    );

    // Insert booking and get it back using RETURNING
    const bookingRow = await db.get<BookingRow>(
      `INSERT INTO bookings
        (id, trip_id, user_id, num_seats, state, price_at_booking, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [bookingId, tripId, userId, numSeats, STATES.PENDING_PAYMENT, priceAtBooking, nowIso, expiresIso, nowIso]
    );

    logger.info('Booking created successfully and seats reserved', {
      bookingId,
      tripId,
      userId,
      numSeats,
      expiresAt: expiresIso,
      seatsReserved: numSeats,
      expiredSeatsReleased: expiredSeats
    });

    return Booking.fromRow(bookingRow)!;
  });
}

export async function confirmBooking(bookingId: string): Promise<Booking> {
  return db.transaction(async () => {
    const nowIso = new Date().toISOString();
    
    // Get booking with expiry check in one query
    const booking = await db.get<BookingRow>(
      'SELECT * FROM bookings WHERE id = ?',
      [bookingId]
    );

    if (!booking) {
      throw new HttpError(404, 'Booking not found');
    }

    if (booking.expires_at && new Date(booking.expires_at) <= new Date(nowIso)) {
      throw new HttpError(409, 'Booking has expired');
    }

    if (booking.state === STATES.CONFIRMED) {
      logger.info('Booking already confirmed', { bookingId });
      return Booking.fromRow(booking)!;
    }

    if (booking.state !== STATES.PENDING_PAYMENT) {
      throw new HttpError(409, `Cannot confirm booking in state: ${booking.state}`);
    }

    // Update and return in one query using RETURNING
    const updatedBooking = await db.get<BookingRow>(
      'UPDATE bookings SET state = ?, updated_at = ? WHERE id = ? RETURNING *',
      [STATES.CONFIRMED, nowIso, bookingId]
    );

    logger.info('Booking confirmed successfully', {
      bookingId,
      tripId: booking.trip_id,
      numSeats: booking.num_seats,
    });

    return Booking.fromRow(updatedBooking)!;
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
