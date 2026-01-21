/**
 * Smoke tests for GoTyolo booking system.
 * 
 * Tests cover:
 * 1. Concurrency - Two users racing for the last seat
 * 2. Webhook idempotency - Same webhook processed twice
 * 3. Refund calculation - Correct amount with fee
 * 4. Seat release - Seats returned after cancellation
 * 5. Auto-expiry - Pending bookings expire and release seats
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../src/db/database';
import { withTransaction, run, get } from '../src/services/transaction';
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

  // Initialize database
  const db = getDb();

  // Verify there's at least one published trip
  const existingTrip = await get<TripRow>(
    db,
    "SELECT * FROM trips WHERE status = 'PUBLISHED' ORDER BY start_date ASC LIMIT 1"
  );
  assert(!!existingTrip, 'Expected at least one PUBLISHED trip (run seed first)');
  console.log('✅ Found existing trip:', existingTrip!.title);

  // =====================================================
  // TEST 1: Concurrency - Race for last seat
  // =====================================================
  console.log('\n📋 Test 1: Concurrency - Two users racing for last seat');

  const tripId = uuidv4();
  const now = new Date();
  const ts = now.toISOString();

  // Create a trip with only 1 seat
  await withTransaction(async (txDb) => {
    await run(
      txDb,
      `INSERT INTO trips
       (id, title, destination, start_date, end_date, price, max_capacity, available_seats, status,
        refundable_until_days_before, cancellation_fee_percent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tripId,
        'Concurrency Test Trip',
        'Testville',
        new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString(),
        new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString(),
        100,
        1, // max_capacity
        1, // available_seats
        'PUBLISHED',
        7,
        10,
        ts,
        ts,
      ]
    );
  });

  const userA = uuidv4();
  const userB = uuidv4();

  // Race two booking attempts
  const results = await Promise.allSettled([
    createBooking(tripId, userA, 1),
    createBooking(tripId, userB, 1),
  ]);

  const successes = results.filter((r) => r.status === 'fulfilled');
  const failures = results.filter((r) => r.status === 'rejected');

  assert(successes.length === 1, `Expected 1 success, got ${successes.length}`);
  assert(failures.length === 1, `Expected 1 failure, got ${failures.length}`);

  const tripAfter = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [tripId]);
  assert(tripAfter!.available_seats === 0, 'Expected available_seats=0 after one booking');

  console.log('✅ Concurrency test passed - Only one booking succeeded');

  // =====================================================
  // TEST 2: Webhook Idempotency
  // =====================================================
  console.log('\n📋 Test 2: Webhook idempotency - Process success twice');

  const successfulBooking = (successes[0] as PromiseFulfilledResult<Booking>).value;
  const idemKey = `webhook-${uuidv4()}`;

  const w1 = await processWebhook(successfulBooking.id, 'success', idemKey);
  const w2 = await processWebhook(successfulBooking.id, 'success', idemKey);

  assert((w1 as BookingRow).state === STATES.CONFIRMED, 'Expected CONFIRMED after first webhook');
  assert((w2 as BookingRow).state === STATES.CONFIRMED, 'Expected CONFIRMED after second webhook (idempotent)');

  console.log('✅ Idempotency test passed - Second webhook was no-op');

  // =====================================================
  // TEST 3: Refund Calculation + Seat Release
  // =====================================================
  console.log('\n📋 Test 3: Refund calculation and seat release');

  const cancelled = await cancelBookingWithRefund(successfulBooking.id);

  assert(cancelled.state === STATES.CANCELLED, 'Expected CANCELLED state');
  // Refund = 100 * (1 - 10/100) = 90
  assert(Number(cancelled.refund_amount) === 90, `Expected refund 90.00, got ${cancelled.refund_amount}`);

  const tripAfterCancel = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [tripId]);
  assert(tripAfterCancel!.available_seats === 1, 'Expected seat released back after refundable cancel');

  console.log('✅ Refund test passed - Correct amount calculated and seats released');

  // =====================================================
  // TEST 4: Auto-Expiry
  // =====================================================
  console.log('\n📋 Test 4: Auto-expiry of pending bookings');

  const pendingId = uuidv4();

  // Create a pending booking with expires_at in the past
  await withTransaction(async (txDb) => {
    // Reserve a seat
    await run(txDb, 'UPDATE trips SET available_seats = available_seats - 1, updated_at = ? WHERE id = ?', [
      new Date().toISOString(),
      tripId,
    ]);

    await run(
      txDb,
      `INSERT INTO bookings
       (id, trip_id, user_id, num_seats, state, price_at_booking, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pendingId,
        tripId,
        uuidv4(),
        1,
        STATES.PENDING_PAYMENT,
        100,
        new Date().toISOString(),
        new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
        new Date().toISOString(),
      ]
    );
  });

  // Run expiry job
  await expirePendingBookings();

  const expired = await get<BookingRow>(db, 'SELECT * FROM bookings WHERE id = ?', [pendingId]);
  assert(expired!.state === STATES.EXPIRED, 'Expected booking EXPIRED after expiry job');

  const tripAfterExpire = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [tripId]);
  assert(tripAfterExpire!.available_seats === 1, 'Expected seat released after expiry');

  console.log('✅ Auto-expiry test passed - Booking expired and seat released');

  // =====================================================
  // All tests passed
  // =====================================================
  console.log('\n🎉 All smoke tests passed!\n');
}

runTests().catch((err) => {
  console.error('\n❌ Smoke tests failed:', err.message);
  process.exit(1);
});
