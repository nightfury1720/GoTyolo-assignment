import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/database';
import { STATES, HttpError, TripRow, BookingRow, ReservationRow } from '../types';
import { Trip } from '../models/Trip';
import { Booking } from '../models/Booking';
import { logger } from '../utils/logger';

export async function createReservation(tripId: string, userId: string, numSeats: number): Promise<{ reservationId: string; bookingId: string; expiresAt: string }> {
  if (!numSeats || numSeats <= 0) {
    throw new HttpError(400, 'num_seats must be greater than 0');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes as per requirements
  const reservationId = uuidv4();
  const bookingId = uuidv4();

  return db.transaction(async () => {
    // Clean up expired reservations first to free up seats
    await db.run(
      `DELETE FROM reservations
       WHERE trip_id = ? AND expires_at < ? AND booking_id IS NULL`,
      [tripId, now.toISOString()]
    );

    const tripRow = await db.get<TripRow>(
      'SELECT * FROM trips WHERE id = ? AND status = ?',
      [tripId, 'PUBLISHED']
    );

    const trip = Trip.fromRow(tripRow);
    if (!trip) {
      throw new HttpError(404, 'Trip not found or not published');
    }

    // Calculate available seats based on active reservations
    // This is the single source of truth for seat availability
    const reservedSeats = await db.get<{ total_seats: number }>(
      `SELECT COALESCE(SUM(num_seats), 0) as total_seats
       FROM reservations
       WHERE trip_id = ? AND expires_at > ?`,
      [tripId, now.toISOString()]
    );

    const availableSeats = trip.max_capacity - (reservedSeats?.total_seats || 0);

    if (availableSeats < numSeats) {
      throw new HttpError(409, 'Not enough seats available');
    }

    logger.info('Seat availability check passed', {
      tripId,
      maxCapacity: trip.max_capacity,
      reservedSeats: reservedSeats?.total_seats || 0,
      availableSeats,
      requestedSeats: numSeats
    });

    const priceAtReservation = trip.price * numSeats;
    const nowIso = now.toISOString();
    const expiresIso = expiresAt.toISOString();

    // Create reservation to hold the seats
    await db.run(
      `INSERT INTO reservations
        (id, trip_id, user_id, num_seats, price_at_reservation, booking_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [reservationId, tripId, userId, numSeats, priceAtReservation, expiresIso, nowIso, nowIso]
    );

    // Create the booking record in PENDING_PAYMENT state
    await db.run(
      `INSERT INTO bookings
        (id, trip_id, user_id, num_seats, state, price_at_booking, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookingId, tripId, userId, numSeats, STATES.PENDING_PAYMENT, priceAtReservation, nowIso, expiresIso, nowIso]
    );

    // Link reservation to booking
    await db.run(
      'UPDATE reservations SET booking_id = ? WHERE id = ?',
      [bookingId, reservationId]
    );

    logger.info('Reservation created successfully', {
      reservationId,
      bookingId,
      tripId,
      userId,
      numSeats,
      expiresAt: expiresIso
    });

    return { reservationId, bookingId, expiresAt: expiresIso };
  });
}

export async function confirmReservationInternal(reservationId: string): Promise<Booking> {
  return db.transaction(async () => {
    const reservation = await db.get<ReservationRow>(
      'SELECT * FROM reservations WHERE id = ?',
      [reservationId]
    );

    if (!reservation) {
      throw new HttpError(404, 'Reservation not found');
    }

    // Check if already confirmed
    if (reservation.booking_id) {
      const booking = await db.get<BookingRow>(
        'SELECT * FROM bookings WHERE id = ?',
        [reservation.booking_id]
      );
      if (booking && booking.state === STATES.CONFIRMED) {
        logger.info('Reservation already confirmed', { reservationId, bookingId: reservation.booking_id });
        return Booking.fromRow(booking)!;
      }
    }

    // Check if reservation has expired
    if (new Date(reservation.expires_at) < new Date()) {
      throw new HttpError(409, 'Reservation has expired');
    }

    const nowIso = new Date().toISOString();

    // Update booking to confirmed state (seats are already reserved)
    await db.run(
      'UPDATE bookings SET state = ?, updated_at = ? WHERE id = ?',
      [STATES.CONFIRMED, nowIso, reservation.booking_id!]
    );

    // Keep reservation for audit trail but mark as confirmed
    await db.run(
      'UPDATE reservations SET updated_at = ? WHERE id = ?',
      [nowIso, reservationId]
    );

    logger.info('Reservation confirmed successfully', {
      reservationId,
      bookingId: reservation.booking_id,
      tripId: reservation.trip_id,
      numSeats: reservation.num_seats,
    });

    const bookingRow = await db.get<BookingRow>(
      'SELECT * FROM bookings WHERE id = ?',
      [reservation.booking_id!]
    );

    return Booking.fromRow(bookingRow)!;
  });
}


export async function createBooking(tripId: string, userId: string, numSeats: number): Promise<Booking> {
  const { bookingId } = await createReservation(tripId, userId, numSeats);
  const bookingRow = await db.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  return Booking.fromRow(bookingRow)!;
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
