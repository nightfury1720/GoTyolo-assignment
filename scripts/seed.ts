import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../src/db/database';
import { withTransaction, run } from '../src/services/transaction';
import { STATES } from '../src/types';
import { logger } from '../src/utils/logger';

interface TripSeed {
  id: string;
  title: string;
  destination: string;
  start_date: string;
  end_date: string;
  price: number;
  max_capacity: number;
  available_seats: number;
  status: string;
  refundable_until_days_before: number;
  cancellation_fee_percent: number;
}

interface BookingSeed {
  trip: TripSeed;
  num_seats: number;
  state: string;
  refund_amount?: number;
  expires_at?: string;
  cancelled_at?: string;
}

async function seed(): Promise<void> {
  // Initialize database
  getDb();

  await withTransaction(async (db) => {
    // Clear existing data
    await run(db, 'DELETE FROM bookings');
    await run(db, 'DELETE FROM trips');

    const now = new Date();

    // Sample trips with various configurations
    const trips: TripSeed[] = [
      {
        id: uuidv4(),
        title: 'Paris City Tour',
        destination: 'Paris, France',
        start_date: new Date(now.getTime() + 9 * 24 * 60 * 60 * 1000).toISOString(),
        end_date: new Date(now.getTime() + 12 * 24 * 60 * 60 * 1000).toISOString(),
        price: 500,
        max_capacity: 20,
        available_seats: 20,
        status: 'PUBLISHED',
        refundable_until_days_before: 7,
        cancellation_fee_percent: 10,
      },
      {
        id: uuidv4(),
        title: 'Tokyo Explorer',
        destination: 'Tokyo, Japan',
        start_date: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        end_date: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        price: 800,
        max_capacity: 15,
        available_seats: 15,
        status: 'PUBLISHED',
        refundable_until_days_before: 5,
        cancellation_fee_percent: 20,
      },
      {
        id: uuidv4(),
        title: 'NY Weekend',
        destination: 'New York, USA',
        start_date: new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString(),
        end_date: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        price: 300,
        max_capacity: 10,
        available_seats: 10,
        status: 'PUBLISHED',
        refundable_until_days_before: 2,
        cancellation_fee_percent: 30,
      },
      {
        id: uuidv4(),
        title: 'London Heritage',
        destination: 'London, UK',
        start_date: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        end_date: new Date(now.getTime() + 18 * 24 * 60 * 60 * 1000).toISOString(),
        price: 450,
        max_capacity: 25,
        available_seats: 25,
        status: 'PUBLISHED',
        refundable_until_days_before: 10,
        cancellation_fee_percent: 15,
      },
      {
        id: uuidv4(),
        title: 'Rome Ancient Wonders',
        destination: 'Rome, Italy',
        start_date: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        end_date: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString(),
        price: 550,
        max_capacity: 12,
        available_seats: 12,
        status: 'PUBLISHED',
        refundable_until_days_before: 3,
        cancellation_fee_percent: 25,
      },
    ];

    // Insert trips
    for (const trip of trips) {
      const ts = new Date().toISOString();
      await run(
        db,
        `INSERT INTO trips
         (id, title, destination, start_date, end_date, price, max_capacity, available_seats, status,
          refundable_until_days_before, cancellation_fee_percent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          trip.id,
          trip.title,
          trip.destination,
          trip.start_date,
          trip.end_date,
          trip.price,
          trip.max_capacity,
          trip.available_seats,
          trip.status,
          trip.refundable_until_days_before,
          trip.cancellation_fee_percent,
          ts,
          ts,
        ]
      );
    }

    // Sample bookings with various states
    const sampleBookings: BookingSeed[] = [
      // Paris - 2 confirmed bookings
      {
        trip: trips[0],
        num_seats: 2,
        state: STATES.CONFIRMED,
        refund_amount: 0,
      },
      {
        trip: trips[0],
        num_seats: 3,
        state: STATES.CONFIRMED,
        refund_amount: 0,
      },
      // Paris - 1 pending payment
      {
        trip: trips[0],
        num_seats: 1,
        state: STATES.PENDING_PAYMENT,
        expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      },
      // Tokyo - 1 expired, 1 cancelled with refund
      {
        trip: trips[1],
        num_seats: 4,
        state: STATES.EXPIRED,
        expires_at: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      },
      {
        trip: trips[1],
        num_seats: 2,
        state: STATES.CANCELLED,
        refund_amount: 1280, // 800 * 2 * (1 - 0.20)
        cancelled_at: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
      // NY - 5 confirmed
      {
        trip: trips[2],
        num_seats: 5,
        state: STATES.CONFIRMED,
        refund_amount: 0,
      },
      // London - 3 confirmed, 2 pending
      {
        trip: trips[3],
        num_seats: 3,
        state: STATES.CONFIRMED,
        refund_amount: 0,
      },
      {
        trip: trips[3],
        num_seats: 2,
        state: STATES.PENDING_PAYMENT,
        expires_at: new Date(now.getTime() + 12 * 60 * 1000).toISOString(),
      },
      // Rome - 2 confirmed, 1 cancelled (no refund - after cutoff)
      {
        trip: trips[4],
        num_seats: 2,
        state: STATES.CONFIRMED,
        refund_amount: 0,
      },
      {
        trip: trips[4],
        num_seats: 1,
        state: STATES.CANCELLED,
        refund_amount: 0, // After cutoff, no refund
        cancelled_at: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];

    // Insert bookings
    for (const entry of sampleBookings) {
      const id = uuidv4();
      const created = new Date().toISOString();
      const priceAt = entry.trip.price * entry.num_seats;

      await run(
        db,
        `INSERT INTO bookings
          (id, trip_id, user_id, num_seats, state, price_at_booking, created_at, expires_at, cancelled_at, refund_amount, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          entry.trip.id,
          uuidv4(), // Random user ID
          entry.num_seats,
          entry.state,
          priceAt,
          created,
          entry.expires_at || null,
          entry.cancelled_at || null,
          entry.refund_amount || null,
          created,
        ]
      );

      // Update available seats for non-terminal bookings
      if (entry.state !== STATES.EXPIRED && entry.state !== STATES.CANCELLED) {
        await run(
          db,
          'UPDATE trips SET available_seats = available_seats - ?, updated_at = ? WHERE id = ?',
          [entry.num_seats, created, entry.trip.id]
        );
      }
    }

    logger.info('Database seeded successfully', {
      trips: trips.length,
      bookings: sampleBookings.length,
    });
  });

  console.log('✅ Database seeded successfully!');
  console.log(`   - ${5} trips created`);
  console.log(`   - ${10} bookings created`);
}

seed().catch((err) => {
  console.error('❌ Seeding failed:', err.message);
  process.exit(1);
});
