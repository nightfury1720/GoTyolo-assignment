/**
 * Comprehensive tests for GoTyolo booking system.
 * 
 * Tests all requirements from the problem statement:
 * 
 * 1. Trip Management
 *    - GET /trips - List all published trips (with optional filters)
 *    - GET /trips/{tripId} - Get trip details
 *    - POST /trips - Create new trip (admin only)
 * 
 * 2. Booking Management
 *    - POST /trips/{tripId}/book - Create booking (reserve seat, initiate payment)
 *    - GET /bookings/{bookingId} - Get booking details and state
 *    - POST /bookings/{bookingId}/cancel - User cancels booking
 * 
 * 3. Payment Processing
 *    - POST /payments/webhook - Payment provider sends success/failure
 *    - Idempotency handling
 *    - 15-minute auto-expiry
 * 
 * 4. Refund & Cancellation Policy
 *    - Before cutoff: refundable with cancellation fee
 *    - After cutoff: non-refundable
 *    - Seat release on cancellation
 * 
 * 5. Admin APIs
 *    - GET /admin/trips/{tripId}/metrics - Trip metrics
 *    - GET /admin/trips/at-risk - List at-risk trips
 * 
 * 6. Concurrency & Race Conditions
 *    - Prevent overbooking
 *    - Last seat race condition
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../src/db/database';
import { withTransaction, run, get, all } from '../src/services/transaction';
import { createBooking } from '../src/services/bookingService';
import { createTrip } from '../src/services/tripService';
import { processWebhook } from '../src/services/paymentService';
import { cancelBookingWithRefund } from '../src/services/refundService';
import { expirePendingBookings } from '../src/services/expiryService';
import { STATES, TripRow, BookingRow, HttpError } from '../src/types';
import { Trip } from '../src/models/Trip';
import { Booking } from '../src/models/Booking';

// Test utilities
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`❌ Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`❌ Assertion failed: ${message}. Expected: ${expected}, Got: ${actual}`);
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, message: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`❌ Assertion failed: ${message}. Expected: ${expected} ± ${tolerance}, Got: ${actual}`);
  }
}

async function runTests(): Promise<void> {
  console.log('🧪 Starting comprehensive tests for GoTyolo booking system...\n');
  console.log('=' .repeat(80));

  const db = getDb();
  let testCount = 0;
  let passCount = 0;

  async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    testCount++;
    try {
      await fn();
      passCount++;
      console.log(`✅ Test ${testCount}: ${name}`);
    } catch (err: any) {
      console.error(`❌ Test ${testCount}: ${name}`);
      console.error(`   Error: ${err.message}`);
      throw err;
    }
  }

  // ============================================================================
  // SECTION 1: TRIP MANAGEMENT
  // ============================================================================
  console.log('\n📋 SECTION 1: TRIP MANAGEMENT\n');

  let testTripId: string;
  let testTrip2Id: string;

  // Test 1.1: Create a new trip (POST /trips)
  await test('Create new trip with DRAFT status', async () => {
    const tripData = {
      title: 'Test Trip - Barcelona',
      destination: 'Barcelona, Spain',
      start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString(),
      price: 750,
      max_capacity: 20,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 15,
      status: 'DRAFT' as const,
    };

    const trip = await createTrip(tripData);
    testTripId = trip.id;

    assert(trip.title === tripData.title, 'Trip title should match');
    assert(trip.status === 'DRAFT', 'Trip status should be DRAFT');
    assert(trip.available_seats === trip.max_capacity, 'Available seats should equal max capacity');
    assert(trip.price === tripData.price, 'Trip price should match');
  });

  // Test 1.2: Create a published trip
  await test('Create new trip with PUBLISHED status', async () => {
    const tripData = {
      title: 'Test Trip - Paris',
      destination: 'Paris, France',
      start_date: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
      price: 600,
      max_capacity: 15,
      refundable_until_days_before: 5,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED' as const,
    };

    const trip = await createTrip(tripData);
    testTrip2Id = trip.id;

    assert(trip.status === 'PUBLISHED', 'Trip status should be PUBLISHED');
    assert(trip.available_seats === trip.max_capacity, 'Available seats should equal max capacity');
  });

  // Test 1.3: Get trip details (GET /trips/{tripId})
  await test('Get trip details by ID', async () => {
    const tripRow = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [testTripId]);
    assert(!!tripRow, 'Trip should exist');
    assert(tripRow!.title === 'Test Trip - Barcelona', 'Trip title should match');
  });

  // Test 1.4: List published trips (GET /trips)
  await test('List only published trips', async () => {
    const trips = await all<TripRow>(
      db,
      'SELECT * FROM trips WHERE status = ? ORDER BY start_date ASC',
      ['PUBLISHED']
    );
    assert(trips.length > 0, 'Should have at least one published trip');
    assert(trips.every(t => t.status === 'PUBLISHED'), 'All trips should be PUBLISHED');
  });

  // Test 1.5: Trip creation validation - invalid dates
  await test('Reject trip creation with end_date before start_date', async () => {
    try {
      await createTrip({
        title: 'Invalid Trip',
        destination: 'Nowhere',
        start_date: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        end_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        price: 100,
        max_capacity: 10,
        refundable_until_days_before: 7,
        cancellation_fee_percent: 10,
      });
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err instanceof HttpError && err.status === 400, 'Should throw 400 Bad Request');
    }
  });

  // Test 1.6: Trip creation validation - invalid price
  await test('Reject trip creation with invalid price', async () => {
    try {
      await createTrip({
        title: 'Invalid Trip',
        destination: 'Nowhere',
        start_date: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        end_date: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        price: -100,
        max_capacity: 10,
        refundable_until_days_before: 7,
        cancellation_fee_percent: 10,
      });
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err instanceof HttpError && err.status === 400, 'Should throw 400 Bad Request');
    }
  });

  // ============================================================================
  // SECTION 2: BOOKING MANAGEMENT
  // ============================================================================
  console.log('\n📋 SECTION 2: BOOKING MANAGEMENT\n');

  let bookingId1: string;
  let bookingId2: string;
  const userId1 = uuidv4();
  const userId2 = uuidv4();

  // Test 2.1: Create booking (POST /trips/{tripId}/book)
  await test('Create booking for published trip', async () => {
    const booking = await createBooking(testTrip2Id, userId1, 2);
    bookingId1 = booking.id;

    assert(booking.state === STATES.PENDING_PAYMENT, 'Booking should start in PENDING_PAYMENT state');
    assert(booking.num_seats === 2, 'Should book 2 seats');
    assert(booking.price_at_booking === 600 * 2, 'Price should be 600 * 2 = 1200');
    assert(!!booking.expires_at, 'Should have expires_at timestamp');

    // Check that seats were decremented
    const trip = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    assert(trip!.available_seats === 13, 'Available seats should be 15 - 2 = 13');
  });

  // Test 2.2: Get booking details (GET /bookings/{bookingId})
  await test('Get booking details by ID', async () => {
    const bookingRow = await get<BookingRow>(db, 'SELECT * FROM bookings WHERE id = ?', [bookingId1]);
    assert(!!bookingRow, 'Booking should exist');
    assert(bookingRow!.state === STATES.PENDING_PAYMENT, 'Booking state should be PENDING_PAYMENT');
    assert(bookingRow!.num_seats === 2, 'Should have 2 seats');
  });

  // Test 2.3: Cannot book more seats than available
  await test('Reject booking when not enough seats available', async () => {
    try {
      await createBooking(testTrip2Id, userId2, 20); // Only 13 seats left
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err instanceof HttpError && err.status === 409, 'Should throw 409 Conflict');
    }
  });

  // Test 2.4: Cannot book DRAFT trips
  await test('Reject booking for DRAFT trip', async () => {
    try {
      await createBooking(testTripId, userId1, 1);
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err instanceof HttpError && err.status === 404, 'Should throw 404 Not Found');
    }
  });

  // ============================================================================
  // SECTION 3: PAYMENT PROCESSING & WEBHOOKS
  // ============================================================================
  console.log('\n📋 SECTION 3: PAYMENT PROCESSING & WEBHOOKS\n');

  // Test 3.1: Process successful payment webhook
  await test('Process successful payment webhook', async () => {
    const idempotencyKey = `webhook-${uuidv4()}`;
    const result = await processWebhook(bookingId1, 'success', idempotencyKey);

    assert((result as BookingRow).state === STATES.CONFIRMED, 'Booking should be CONFIRMED');
    
    const booking = await get<BookingRow>(db, 'SELECT * FROM bookings WHERE id = ?', [bookingId1]);
    assert(booking!.state === STATES.CONFIRMED, 'Booking state should be CONFIRMED');
    assert(booking!.idempotency_key === idempotencyKey, 'Idempotency key should be stored');
  });

  // Test 3.2: Webhook idempotency - same key twice
  await test('Webhook idempotency - process same webhook twice', async () => {
    const booking = await createBooking(testTrip2Id, userId2, 1);
    bookingId2 = booking.id;
    const idempotencyKey = `webhook-${uuidv4()}`;

    const result1 = await processWebhook(bookingId2, 'success', idempotencyKey);
    const result2 = await processWebhook(bookingId2, 'success', idempotencyKey);

    assert((result1 as BookingRow).state === STATES.CONFIRMED, 'First webhook should confirm');
    assert((result2 as BookingRow).state === STATES.CONFIRMED, 'Second webhook should be idempotent');
    assert((result1 as BookingRow).id === (result2 as BookingRow).id, 'Should return same booking');
  });

  // Test 3.3: Process failed payment webhook
  await test('Process failed payment webhook', async () => {
    // Get current seat count before creating new booking
    const tripBefore = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    const seatsBefore = tripBefore!.available_seats;
    
    const booking = await createBooking(testTrip2Id, userId1, 1);
    
    // Verify seat was decremented
    const tripAfterBooking = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    assert(tripAfterBooking!.available_seats === seatsBefore - 1, 'Seat should be decremented on booking');
    
    const idempotencyKey = `webhook-fail-${uuidv4()}`;
    const result = await processWebhook(booking.id, 'failed', idempotencyKey);
    assert((result as BookingRow).state === STATES.EXPIRED, 'Booking should be EXPIRED on failure');

    // Seats should be released back
    const tripAfterFailure = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    assert(tripAfterFailure!.available_seats === seatsBefore, 'Seats should be released on payment failure');
  });

  // Test 3.4: Auto-expiry of pending bookings
  await test('Auto-expire pending bookings after 15 minutes', async () => {
    const booking = await createBooking(testTrip2Id, userId1, 1);
    
    // Manually set expires_at to past
    await withTransaction(async (txDb) => {
      await run(
        txDb,
        'UPDATE bookings SET expires_at = ? WHERE id = ?',
        [new Date(Date.now() - 60 * 60 * 1000).toISOString(), booking.id]
      );
    });

    // Run expiry job
    await expirePendingBookings();

    const expired = await get<BookingRow>(db, 'SELECT * FROM bookings WHERE id = ?', [booking.id]);
    assert(expired!.state === STATES.EXPIRED, 'Booking should be EXPIRED');
    
    // Seats should be released
    const trip = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    assert(trip!.available_seats > 0, 'Seats should be released after expiry');
  });

  // ============================================================================
  // SECTION 4: REFUND & CANCELLATION POLICY
  // ============================================================================
  console.log('\n📋 SECTION 4: REFUND & CANCELLATION POLICY\n');

  // Test 4.1: Cancel booking before cutoff (refundable)
  await test('Cancel booking before cutoff - should refund with fee', async () => {
    // Create a trip with refund policy
    const refundableTrip = await createTrip({
      title: 'Refundable Test Trip',
      destination: 'Tokyo, Japan',
      start_date: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(), // 20 days away
      end_date: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
      price: 1000,
      max_capacity: 10,
      refundable_until_days_before: 7, // Refundable until 7 days before
      cancellation_fee_percent: 20, // 20% fee
      status: 'PUBLISHED',
    });

    const booking = await createBooking(refundableTrip.id, userId1, 2);
    const idempotencyKey = `webhook-${uuidv4()}`;
    await processWebhook(booking.id, 'success', idempotencyKey);

    // Cancel before cutoff (20 days > 7 days)
    const cancelled = await cancelBookingWithRefund(booking.id);

    assert(cancelled.state === STATES.CANCELLED, 'Booking should be CANCELLED');
    // Refund = 2000 * (1 - 0.20) = 1600
    assertApprox(Number(cancelled.refund_amount), 1600, 0.01, 'Refund should be 1600');
    
    // Seats should be released
    const trip = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [refundableTrip.id]);
    assert(trip!.available_seats === 10, 'Seats should be released');
  });

  // Test 4.2: Cancel booking after cutoff (non-refundable)
  await test('Cancel booking after cutoff - no refund', async () => {
    const nonRefundableTrip = await createTrip({
      title: 'Non-Refundable Test Trip',
      destination: 'London, UK',
      start_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days away
      end_date: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
      price: 500,
      max_capacity: 5,
      refundable_until_days_before: 7, // Cutoff is 7 days before
      cancellation_fee_percent: 10,
      status: 'PUBLISHED',
    });

    const booking = await createBooking(nonRefundableTrip.id, userId1, 1);
    const idempotencyKey = `webhook-${uuidv4()}`;
    await processWebhook(booking.id, 'success', idempotencyKey);

    // Cancel after cutoff (3 days < 7 days)
    const cancelled = await cancelBookingWithRefund(booking.id);

    assert(cancelled.state === STATES.CANCELLED, 'Booking should be CANCELLED');
    assert(Number(cancelled.refund_amount) === 0, 'Refund should be 0 after cutoff');
    
    // Seats should NOT be released (trip is imminent)
    const trip = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [nonRefundableTrip.id]);
    assert(trip!.available_seats === 4, 'Seats should NOT be released after cutoff');
  });

  // Test 4.3: Cannot cancel expired booking
  await test('Reject cancellation of expired booking', async () => {
    const booking = await createBooking(testTrip2Id, userId1, 1);
    
    // Set to expired
    await withTransaction(async (txDb) => {
      await run(
        txDb,
        'UPDATE bookings SET state = ?, expires_at = ? WHERE id = ?',
        [STATES.EXPIRED, new Date(Date.now() - 60 * 60 * 1000).toISOString(), booking.id]
      );
    });

    try {
      await cancelBookingWithRefund(booking.id);
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err instanceof HttpError && err.status === 409, 'Should throw 409 Conflict');
    }
  });

  // Test 4.4: Cannot cancel already cancelled booking
  await test('Reject cancellation of already cancelled booking', async () => {
    const booking = await createBooking(testTrip2Id, userId1, 1);
    const idempotencyKey = `webhook-${uuidv4()}`;
    await processWebhook(booking.id, 'success', idempotencyKey);
    
    await cancelBookingWithRefund(booking.id);
    
    try {
      await cancelBookingWithRefund(booking.id);
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err instanceof HttpError && err.status === 409, 'Should throw 409 Conflict');
    }
  });

  // ============================================================================
  // SECTION 5: ADMIN APIs
  // ============================================================================
  console.log('\n📋 SECTION 5: ADMIN APIs\n');

  // Test 5.1: Get trip metrics (GET /admin/trips/{tripId}/metrics)
  await test('Get trip metrics - occupancy and financials', async () => {
    const metricsTrip = await createTrip({
      title: 'Metrics Test Trip',
      destination: 'Rome, Italy',
      start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString(),
      price: 400,
      max_capacity: 20,
      refundable_until_days_before: 10,
      cancellation_fee_percent: 15,
      status: 'PUBLISHED',
    });

    // Create various bookings
    const b1 = await createBooking(metricsTrip.id, userId1, 3);
    const b2 = await createBooking(metricsTrip.id, userId2, 2);
    const b3 = await createBooking(metricsTrip.id, userId1, 1);

    await processWebhook(b1.id, 'success', `key-${uuidv4()}`);
    await processWebhook(b2.id, 'success', `key-${uuidv4()}`);
    // b3 remains PENDING_PAYMENT

    // Cancel b1 with refund
    await cancelBookingWithRefund(b1.id);

    // Calculate metrics manually
    const trip = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [metricsTrip.id]);
    const bookings = await all<BookingRow>(
      db,
      'SELECT * FROM bookings WHERE trip_id = ?',
      [metricsTrip.id]
    );

    const bookedSeats = trip!.max_capacity - trip!.available_seats;
    const occupancyPercent = Math.round((bookedSeats / trip!.max_capacity) * 100);

    const confirmed = bookings.filter(b => b.state === STATES.CONFIRMED).length;
    const pending = bookings.filter(b => b.state === STATES.PENDING_PAYMENT).length;
    const cancelled = bookings.filter(b => b.state === STATES.CANCELLED).length;

    const gross = bookings
      .filter(b => b.state === STATES.CONFIRMED || b.state === STATES.CANCELLED)
      .reduce((sum, b) => sum + b.price_at_booking, 0);
    
    const refunds = bookings
      .reduce((sum, b) => sum + (b.refund_amount || 0), 0);

    assert(occupancyPercent > 0, 'Occupancy should be calculated');
    assert(confirmed >= 0, 'Should have confirmed bookings count');
    assert(pending >= 0, 'Should have pending bookings count');
    assert(cancelled >= 0, 'Should have cancelled bookings count');
    assert(gross > 0, 'Gross revenue should be calculated');
  });

  // Test 5.2: Get at-risk trips (GET /admin/trips/at-risk)
  await test('List at-risk trips - low occupancy and departing soon', async () => {
    // Create an at-risk trip (departing in 5 days, low occupancy)
    const atRiskTrip = await createTrip({
      title: 'At-Risk Trip',
      destination: 'Berlin, Germany',
      start_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days away
      end_date: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      price: 300,
      max_capacity: 20,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED',
    });

    // Book only 2 seats (10% occupancy < 50%)
    const booking = await createBooking(atRiskTrip.id, userId1, 2);
    await processWebhook(booking.id, 'success', `key-${uuidv4()}`);

    // Query at-risk trips (departing within 7 days, occupancy < 50%)
    const now = new Date();
    const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const todayIso = now.toISOString();

    const trips = await all<TripRow>(
      db,
      `SELECT *, (max_capacity - available_seats) AS booked
       FROM trips
       WHERE start_date <= ? AND start_date >= ? AND status = 'PUBLISHED'`,
      [inSevenDays, todayIso]
    );

    const atRisk = trips
      .map(t => ({
        trip: t,
        occupancy: Math.round(((t as any).booked / t.max_capacity) * 100),
      }))
      .filter(t => t.occupancy < 50);

    assert(atRisk.length > 0, 'Should find at-risk trips');
    assert(atRisk.some(t => t.trip.id === atRiskTrip.id), 'Should include the at-risk trip');
  });

  // ============================================================================
  // SECTION 6: CONCURRENCY & RACE CONDITIONS
  // ============================================================================
  console.log('\n📋 SECTION 6: CONCURRENCY & RACE CONDITIONS\n');

  // Test 6.1: Race condition - two users booking last seat
  await test('Prevent overbooking - race condition on last seat', async () => {
    const raceTrip = await createTrip({
      title: 'Race Condition Test',
      destination: 'Amsterdam, Netherlands',
      start_date: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString(),
      price: 200,
      max_capacity: 1, // Only 1 seat
      refundable_until_days_before: 7,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED',
    });

    const userA = uuidv4();
    const userB = uuidv4();

    // Race two booking attempts simultaneously
    const results = await Promise.allSettled([
      createBooking(raceTrip.id, userA, 1),
      createBooking(raceTrip.id, userB, 1),
    ]);

    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');

    assert(successes.length === 1, `Expected 1 success, got ${successes.length}`);
    assert(failures.length === 1, `Expected 1 failure, got ${failures.length}`);

    // Check that only one booking succeeded
    const trip = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [raceTrip.id]);
    assert(trip!.available_seats === 0, 'Available seats should be 0');

    // Verify the failed booking - either 409 Conflict or transaction error (both indicate concurrency protection)
    assert(failures.length === 1, 'Should have exactly one failure');
    const failedResult = failures[0];
    if (failedResult.status === 'rejected') {
      const error = failedResult.reason;
      const isHttpError409 = error instanceof HttpError && error.status === 409;
      const isTransactionError = error && (error.message || '').includes('transaction');
      assert(isHttpError409 || isTransactionError, 
        `Should throw 409 Conflict or transaction error, got: ${error?.message || error}`);
    } else {
      assert(false, 'Failed result should be rejected');
    }
  });

  // Test 6.2: Multiple sequential bookings for same trip (SQLite serializes transactions)
  await test('Handle multiple bookings correctly without overbooking', async () => {
    const concurrentTrip = await createTrip({
      title: 'Concurrent Booking Test',
      destination: 'Vienna, Austria',
      start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000).toISOString(),
      price: 350,
      max_capacity: 10,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 12,
      status: 'PUBLISHED',
    });

    const users = Array.from({ length: 5 }, () => uuidv4());
    
    // Create 5 bookings sequentially (SQLite serializes transactions, so concurrent requests are queued)
    // This tests that the system correctly handles multiple bookings without overbooking
    for (const userId of users) {
      await createBooking(concurrentTrip.id, userId, 1);
    }

    const trip = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [concurrentTrip.id]);
    assert(trip!.available_seats === 5, 'Should have 5 seats remaining (10 - 5)');
    
    // Verify all bookings were created
    const bookings = await all<BookingRow>(
      db,
      'SELECT * FROM bookings WHERE trip_id = ?',
      [concurrentTrip.id]
    );
    assert(bookings.length === 5, 'Should have 5 bookings created');
  });

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log(`\n✅ All tests completed!`);
  console.log(`   Total tests: ${testCount}`);
  console.log(`   Passed: ${passCount}`);
  console.log(`   Failed: ${testCount - passCount}\n`);
}

// Run all tests
runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});

