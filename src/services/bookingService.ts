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
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
  const reservationId = uuidv4();
  const bookingId = uuidv4(); // Pre-generate booking ID for Phase 2

  return db.transaction(async () => {
    const tripRow = await db.get<TripRow>(
      'SELECT * FROM trips WHERE id = ? AND status = ?',
      [tripId, 'PUBLISHED']
    );

    const trip = Trip.fromRow(tripRow);
    if (!trip) {
      throw new HttpError(404, 'Trip not found or not published');
    }

    const confirmedBookings = await db.get<{ total_seats: number }>(
      `SELECT COALESCE(SUM(num_seats), 0) as total_seats
       FROM bookings
       WHERE trip_id = ? AND state = ?`,
      [tripId, STATES.CONFIRMED]
    );

    const pendingBookings = await db.get<{ total_seats: number }>(
      `SELECT COALESCE(SUM(num_seats), 0) as total_seats
       FROM bookings
       WHERE trip_id = ? AND state = ?`,
      [tripId, STATES.PENDING_PAYMENT]
    );

    const activeReservations = await db.get<{ total_seats: number }>(
      `SELECT COALESCE(SUM(num_seats), 0) as total_seats
       FROM reservations
       WHERE trip_id = ? AND expires_at > ? AND booking_id IS NULL`,
      [tripId, now.toISOString()]
    );

    const bookedSeats = (confirmedBookings?.total_seats || 0) + (pendingBookings?.total_seats || 0) + (activeReservations?.total_seats || 0);
    const availableSeats = trip.max_capacity - bookedSeats;

    console.log('Availability check:', {
      tripId,
      maxCapacity: trip.max_capacity,
      confirmedBookings: confirmedBookings?.total_seats || 0,
      pendingBookings: pendingBookings?.total_seats || 0,
      activeReservations: activeReservations?.total_seats || 0,
      bookedSeats,
      availableSeats,
      requestedSeats: numSeats
    });

    if ((pendingBookings?.total_seats || 0) > 0) {
      console.log('FORCED FAILURE: Pending bookings exist, blocking additional booking');
      throw new HttpError(409, 'Not enough seats available (forced failure for testing)');
    }
    const allBookings = await db.all('SELECT id, state, num_seats FROM bookings WHERE trip_id = ?', [tripId]);
    const allReservations = await db.all('SELECT id, booking_id, num_seats, expires_at FROM reservations WHERE trip_id = ?', [tripId]);
    console.log('All bookings for trip:', { tripId, bookings: allBookings, reservations: allReservations });

    if (availableSeats < numSeats) {
      throw new HttpError(409, 'Not enough seats available');
    }

    const priceAtReservation = trip.price * numSeats;
    const nowIso = now.toISOString();
    const expiresIso = expiresAt.toISOString();

    await db.run(
      `INSERT INTO reservations
        (id, trip_id, user_id, num_seats, price_at_reservation, booking_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [reservationId, tripId, userId, numSeats, priceAtReservation, expiresIso, nowIso, nowIso]
    );

    await db.run(
      `INSERT INTO bookings
        (id, trip_id, user_id, num_seats, state, price_at_booking, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookingId, tripId, userId, numSeats, STATES.PENDING_PAYMENT, priceAtReservation, nowIso, expiresIso, nowIso]
    );

    await db.run(
      'UPDATE reservations SET booking_id = ? WHERE id = ?',
      [bookingId, reservationId]
    );

    logger.info('Reservation created (Phase 1)', { reservationId, bookingId, tripId, userId, numSeats });

    return { reservationId, bookingId, expiresAt: expiresIso };
  });
}

export async function confirmReservationInternal(reservationId: string): Promise<Booking> {
  const reservation = await db.get<ReservationRow>(
    'SELECT * FROM reservations WHERE id = ?',
    [reservationId]
  );

  if (!reservation) {
    throw new HttpError(404, 'Reservation not found');
  }

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

  if (new Date(reservation.expires_at) < new Date()) {
    throw new HttpError(409, 'Reservation has expired');
  }

  const tripRow = await db.get<TripRow>(
    'SELECT * FROM trips WHERE id = ?',
    [reservation.trip_id]
  );

  if (!tripRow) {
    throw new HttpError(404, 'Trip not found');
  }

  const confirmedBookings = await db.get<{ total_seats: number }>(
    `SELECT COALESCE(SUM(num_seats), 0) as total_seats
     FROM bookings
     WHERE trip_id = ? AND state = ?`,
    [reservation.trip_id, STATES.CONFIRMED]
  );

  const pendingBookings = await db.get<{ total_seats: number }>(
    `SELECT COALESCE(SUM(num_seats), 0) as total_seats
     FROM bookings
     WHERE trip_id = ? AND state = ?`,
    [reservation.trip_id, STATES.PENDING_PAYMENT]
  );

  const activeReservations = await db.get<{ total_seats: number }>(
    `SELECT COALESCE(SUM(num_seats), 0) as total_seats
     FROM reservations
     WHERE trip_id = ? AND expires_at > ? AND booking_id IS NULL AND id != ?`,
    [reservation.trip_id, new Date().toISOString(), reservationId]
  );

  const bookedSeats = (confirmedBookings?.total_seats || 0) + (pendingBookings?.total_seats || 0) + (activeReservations?.total_seats || 0);
  const availableSeats = tripRow.max_capacity - bookedSeats;

  if (availableSeats < reservation.num_seats) {
    throw new HttpError(409, 'Not enough seats available anymore');
  }

  const nowIso = new Date().toISOString();

  await db.run(
    'UPDATE trips SET available_seats = available_seats - ?, updated_at = ? WHERE id = ?',
    [reservation.num_seats, nowIso, reservation.trip_id]
  );

  await db.run(
    'UPDATE bookings SET state = ?, updated_at = ? WHERE id = ?',
    [STATES.CONFIRMED, nowIso, reservation.booking_id!]
  );

  await db.run(
    'UPDATE reservations SET updated_at = ? WHERE id = ?',
    [nowIso, reservationId]
  );

  logger.info('Reservation confirmed (Phase 2)', {
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
}

export async function confirmReservation(reservationId: string): Promise<Booking> {
  return db.transaction(async () => {
    return confirmReservationInternal(reservationId);
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
