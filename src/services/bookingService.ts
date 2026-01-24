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

    await db.run(
      `UPDATE bookings
       SET state = ?, updated_at = ?
       WHERE trip_id = ? AND state = ? AND expires_at < ?`,
      [STATES.EXPIRED, now.toISOString(), tripId, STATES.PENDING_PAYMENT, now.toISOString()]
    );

    const reservedSeats = await db.get<{ total_seats: number }>(
      `SELECT COALESCE(SUM(num_seats), 0) as total_seats
       FROM bookings
       WHERE trip_id = ? AND state = ? AND expires_at > ?`,
      [tripId, STATES.PENDING_PAYMENT, now.toISOString()]
    );

    const confirmedSeats = await db.get<{ total_seats: number }>(
      `SELECT COALESCE(SUM(num_seats), 0) as total_seats
       FROM bookings
       WHERE trip_id = ? AND state = ?`,
      [tripId, STATES.CONFIRMED]
    );

    const totalOccupied = (reservedSeats?.total_seats || 0) + (confirmedSeats?.total_seats || 0);
    const availableSeats = trip.max_capacity - totalOccupied;

    if (availableSeats < numSeats) {
      throw new HttpError(409, 'Not enough seats available');
    }

    logger.info('Seat availability check passed', {
      tripId,
      maxCapacity: trip.max_capacity,
      reservedSeats: reservedSeats?.total_seats || 0,
      confirmedSeats: confirmedSeats?.total_seats || 0,
      totalOccupied,
      availableSeats,
      requestedSeats: numSeats
    });

    const priceAtBooking = trip.price * numSeats;
    const nowIso = now.toISOString();
    const expiresIso = expiresAt.toISOString();

    await db.run(
      `INSERT INTO bookings
        (id, trip_id, user_id, num_seats, state, price_at_booking, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookingId, tripId, userId, numSeats, STATES.PENDING_PAYMENT, priceAtBooking, nowIso, expiresIso, nowIso]
    );

    logger.info('Booking created successfully', {
      bookingId,
      tripId,
      userId,
      numSeats,
      expiresAt: expiresIso
    });

    const bookingRow = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    return Booking.fromRow(bookingRow)!;
  });
}

export async function confirmBooking(bookingId: string): Promise<Booking> {
  return db.transaction(async () => {
    const nowIso = new Date().toISOString();
    
    const booking = await db.get<BookingRow>(
      'SELECT * FROM bookings WHERE id = ? AND expires_at > ?',
      [bookingId, nowIso]
    );

    if (!booking) {
      const expiredBooking = await db.get<BookingRow>(
        'SELECT * FROM bookings WHERE id = ?',
        [bookingId]
      );
      if (expiredBooking) {
        throw new HttpError(409, 'Booking has expired');
      }
      throw new HttpError(404, 'Booking not found');
    }

    if (booking.state === STATES.CONFIRMED) {
      logger.info('Booking already confirmed', { bookingId });
      return Booking.fromRow(booking)!;
    }

    if (booking.state !== STATES.PENDING_PAYMENT) {
      throw new HttpError(409, `Cannot confirm booking in state: ${booking.state}`);
    }

    await db.run(
      'UPDATE bookings SET state = ?, updated_at = ? WHERE id = ?',
      [STATES.CONFIRMED, nowIso, bookingId]
    );

    logger.info('Booking confirmed successfully', {
      bookingId,
      tripId: booking.trip_id,
      numSeats: booking.num_seats,
    });

    const bookingRow = await db.get<BookingRow>(
      'SELECT * FROM bookings WHERE id = ?',
      [bookingId]
    );

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
