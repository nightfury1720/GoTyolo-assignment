import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/database';
import { HttpError, TripRow, TripStatus } from '../types';
import { Trip } from '../models/Trip';

export interface CreateTripInput {
  title: string;
  destination: string;
  start_date: string;
  end_date: string;
  price: number;
  max_capacity: number;
  refundable_until_days_before: number;
  cancellation_fee_percent: number;
  status?: TripStatus;
}

export async function createTrip(input: CreateTripInput): Promise<Trip> {
  const startDate = new Date(input.start_date);
  const endDate = new Date(input.end_date);

  if (isNaN(startDate.getTime())) {
    throw new HttpError(400, 'Invalid start_date format. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)');
  }
  if (isNaN(endDate.getTime())) {
    throw new HttpError(400, 'Invalid end_date format. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)');
  }
  if (endDate <= startDate) {
    throw new HttpError(400, 'end_date must be after start_date');
  }
  if (input.price <= 0) {
    throw new HttpError(400, 'price must be greater than 0');
  }
  if (input.max_capacity <= 0) {
    throw new HttpError(400, 'max_capacity must be greater than 0');
  }
  if (input.refundable_until_days_before < 0) {
    throw new HttpError(400, 'refundable_until_days_before must be non-negative');
  }
  if (input.cancellation_fee_percent < 0 || input.cancellation_fee_percent > 100) {
    throw new HttpError(400, 'cancellation_fee_percent must be between 0 and 100');
  }

  const status: TripStatus = input.status || 'DRAFT';
  if (status !== 'DRAFT' && status !== 'PUBLISHED') {
    throw new HttpError(400, 'status must be either "DRAFT" or "PUBLISHED"');
  }

  const tripId = uuidv4();
  const nowIso = new Date().toISOString();

  return db.transaction(async () => {
    await db.run(
      `INSERT INTO trips
       (id, title, destination, start_date, end_date, price, max_capacity, available_seats, status,
        refundable_until_days_before, cancellation_fee_percent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tripId, input.title, input.destination, input.start_date, input.end_date,
        input.price, input.max_capacity, input.max_capacity, status,
        input.refundable_until_days_before, input.cancellation_fee_percent, nowIso, nowIso
      ]
    );

    const tripRow = await db.get<TripRow>('SELECT * FROM trips WHERE id = ?', [tripId]);
    if (!tripRow) {
      throw new HttpError(500, 'Failed to create trip');
    }
    return Trip.fromRow(tripRow)!;
  });
}

export async function getTrip(tripId: string): Promise<Trip | null> {
  const tripRow = await db.get<TripRow>('SELECT * FROM trips WHERE id = ?', [tripId]);
  return Trip.fromRow(tripRow);
}
