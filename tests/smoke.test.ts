import { v4 as uuidv4 } from 'uuid';
import { db, initializeDb } from '../src/db/database';
import { createBooking } from '../src/services/bookingService';
import { processWebhook } from '../src/services/paymentService';
import { cancelBookingWithRefund } from '../src/services/refundService';
import { expirePendingBookings } from '../src/services/expiryService';
import { STATES, TripRow, BookingRow } from '../src/types';
import { Booking } from '../src/models/Booking';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests(): Promise<void> {
  console.log('🧪 Starting smoke tests...\n');

  await initializeDb();
  const existingTrip = await db!.get<TripRow>(
    "SELECT * FROM trips WHERE status = 'PUBLISHED' ORDER BY start_date ASC LIMIT 1"
  );
  assert(!!existingTrip, 'Expected at least one PUBLISHED trip (run seed first)');
  console.log('✅ Found existing trip:', existingTrip!.title);

  console.log('\n📋 Test 1: Concurrency - Two users racing for last seat');

  const tripId = uuidv4();
  const now = new Date();
  const ts = now.toISOString();

  await db!.transaction(async () => {
    await db!.run(
      `INSERT INTO trips
       (id, title, destination, start_date, end_date, price, max_capacity, available_seats, status,
        refundable_until_days_before, cancellation_fee_percent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tripId, 'Concurrency Test Trip', 'Testville',
        new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString(),
        new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString(),
        100, 1, 1, 'PUBLISHED', 7, 10, ts, ts,
      ]
    );
  });

  const userA = uuidv4();
  const userB = uuidv4();

  const results = await Promise.allSettled([
    createBooking(tripId, userA, 1),
    createBooking(tripId, userB, 1),
  ]);

  const successes = results.filter((r) => r.status === 'fulfilled');
  const failures = results.filter((r) => r.status === 'rejected');

  assert(successes.length === 1, `Expected 1 success, got ${successes.length}`);
  assert(failures.length === 1, `Expected 1 failure, got ${failures.length}`);

  const tripAfter = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [tripId]);
  assert(tripAfter!.available_seats === 0, 'Expected available_seats=0 after one booking');

  console.log('✅ Concurrency test passed - Only one booking succeeded');

  console.log('\n📋 Test 2: Webhook idempotency - Process success twice');

  const successfulBooking = (successes[0] as PromiseFulfilledResult<Booking>).value;
  const idemKey = `webhook-${uuidv4()}`;

  const w1 = await processWebhook(successfulBooking.id, 'success', idemKey);
  const w2 = await processWebhook(successfulBooking.id, 'success', idemKey);

  assert((w1 as BookingRow).state === STATES.CONFIRMED, 'Expected CONFIRMED after first webhook');
  assert((w2 as BookingRow).state === STATES.CONFIRMED, 'Expected CONFIRMED after second webhook (idempotent)');

  console.log('✅ Idempotency test passed - Second webhook was no-op');

  console.log('\n📋 Test 3: Refund calculation and seat release');

  const cancelled = await cancelBookingWithRefund(successfulBooking.id);

  assert(cancelled.state === STATES.CANCELLED, 'Expected CANCELLED state');
  assert(Number(cancelled.refund_amount) === 90, `Expected refund 90.00, got ${cancelled.refund_amount}`);

  const tripAfterCancel = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [tripId]);
  assert(tripAfterCancel!.available_seats === 1, 'Expected seat released back after refundable cancel');

  console.log('✅ Refund test passed - Correct amount calculated and seats released');

  console.log('\n📋 Test 4: Auto-expiry of pending bookings');

  const pendingId = uuidv4();

  await db!.transaction(async () => {
    await db!.run('UPDATE trips SET available_seats = available_seats - 1, updated_at = ? WHERE id = ?', [
      new Date().toISOString(),
      tripId,
    ]);

    await database.run(
      `INSERT INTO bookings
       (id, trip_id, user_id, num_seats, state, price_at_booking, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pendingId, tripId, uuidv4(), 1, STATES.PENDING_PAYMENT, 100,
        new Date().toISOString(),
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        new Date().toISOString(),
      ]
    );
  });

  await expirePendingBookings();

  const expired = await db!.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [pendingId]);
  assert(expired!.state === STATES.EXPIRED, 'Expected booking EXPIRED after expiry job');

  const tripAfterExpire = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [tripId]);
  assert(tripAfterExpire!.available_seats === 1, 'Expected seat released after expiry');

  console.log('✅ Auto-expiry test passed - Booking expired and seat released');

  console.log('\n🎉 All smoke tests passed!\n');
}

runTests().catch((err) => {
  console.error('\n❌ Smoke tests failed:', err.message);
  process.exit(1);
});
