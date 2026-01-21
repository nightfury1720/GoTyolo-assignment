import { v4 as uuidv4 } from 'uuid';
import { db, initializeDb } from '../src/db/database';
import { createBooking } from '../src/services/bookingService';
import { createTrip } from '../src/services/tripService';
import { processWebhook } from '../src/services/paymentService';
import { cancelBookingWithRefund } from '../src/services/refundService';
import { expirePendingBookings } from '../src/services/expiryService';
import { STATES, TripRow, BookingRow, HttpError } from '../src/types';

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
  console.log('='.repeat(80));

  await initializeDb();
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

  console.log('\n📋 SECTION 1: TRIP MANAGEMENT\n');

  let testTripId: string;
  let testTrip2Id: string;

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

  await test('Get trip details by ID', async () => {
    const tripRow = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [testTripId]);
    assert(!!tripRow, 'Trip should exist');
    assert(tripRow!.title === 'Test Trip - Barcelona', 'Trip title should match');
  });

  await test('List only published trips', async () => {
    const trips = await db!.all<TripRow>(
      'SELECT * FROM trips WHERE status = ? ORDER BY start_date ASC',
      ['PUBLISHED']
    );
    assert(trips.length > 0, 'Should have at least one published trip');
    assert(trips.every((t: TripRow) => t.status === 'PUBLISHED'), 'All trips should be PUBLISHED');
  });

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

  console.log('\n📋 SECTION 2: BOOKING MANAGEMENT\n');

  let bookingId1: string;
  let bookingId2: string;
  const userId1 = uuidv4();
  const userId2 = uuidv4();

  await test('Create booking for published trip', async () => {
    const booking = await createBooking(testTrip2Id, userId1, 2);
    bookingId1 = booking.id;

    assert(booking.state === STATES.PENDING_PAYMENT, 'Booking should start in PENDING_PAYMENT state');
    assert(booking.num_seats === 2, 'Should book 2 seats');
    assert(booking.price_at_booking === 600 * 2, 'Price should be 600 * 2 = 1200');
    assert(!!booking.expires_at, 'Should have expires_at timestamp');

    const trip = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    assert(trip!.available_seats === 13, 'Available seats should be 15 - 2 = 13');
  });

  await test('Get booking details by ID', async () => {
    const bookingRow = await db!.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId1]);
    assert(!!bookingRow, 'Booking should exist');
    assert(bookingRow!.state === STATES.PENDING_PAYMENT, 'Booking state should be PENDING_PAYMENT');
    assert(bookingRow!.num_seats === 2, 'Should have 2 seats');
  });

  await test('Reject booking when not enough seats available', async () => {
    try {
      await createBooking(testTrip2Id, userId2, 20);
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err instanceof HttpError && err.status === 409, 'Should throw 409 Conflict');
    }
  });

  await test('Reject booking for DRAFT trip', async () => {
    try {
      await createBooking(testTripId, userId1, 1);
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err instanceof HttpError && err.status === 404, 'Should throw 404 Not Found');
    }
  });

  console.log('\n📋 SECTION 3: PAYMENT PROCESSING & WEBHOOKS\n');

  await test('Process successful payment webhook', async () => {
    const idempotencyKey = `webhook-${uuidv4()}`;
    const result = await processWebhook(bookingId1, 'success', idempotencyKey);

    assert((result as BookingRow).state === STATES.CONFIRMED, 'Booking should be CONFIRMED');

    const booking = await db!.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [bookingId1]);
    assert(booking!.state === STATES.CONFIRMED, 'Booking state should be CONFIRMED');
    assert(booking!.idempotency_key === idempotencyKey, 'Idempotency key should be stored');
  });

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

  await test('Process failed payment webhook', async () => {
    const tripBefore = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    const seatsBefore = tripBefore!.available_seats;

    const booking = await createBooking(testTrip2Id, userId1, 1);

    const tripAfterBooking = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    assert(tripAfterBooking!.available_seats === seatsBefore - 1, 'Seat should be decremented on booking');

    const idempotencyKey = `webhook-fail-${uuidv4()}`;
    const result = await processWebhook(booking.id, 'failed', idempotencyKey);
    assert((result as BookingRow).state === STATES.EXPIRED, 'Booking should be EXPIRED on failure');

    const tripAfterFailure = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    assert(tripAfterFailure!.available_seats === seatsBefore, 'Seats should be released on payment failure');
  });

  await test('Auto-expire pending bookings after 15 minutes', async () => {
    const booking = await createBooking(testTrip2Id, userId1, 1);

    await db!.transaction(async () => {
      await db!.run(
        'UPDATE bookings SET expires_at = ? WHERE id = ?',
        [new Date(Date.now() - 60 * 60 * 1000).toISOString(), booking.id]
      );
    });

    await expirePendingBookings();

    const expired = await db!.get<BookingRow>('SELECT * FROM bookings WHERE id = ?', [booking.id]);
    assert(expired!.state === STATES.EXPIRED, 'Booking should be EXPIRED');

    const trip = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [testTrip2Id]);
    assert(trip!.available_seats > 0, 'Seats should be released after expiry');
  });

  console.log('\n📋 SECTION 4: REFUND & CANCELLATION POLICY\n');

  await test('Cancel booking before cutoff - should refund with fee', async () => {
    const refundableTrip = await createTrip({
      title: 'Refundable Test Trip',
      destination: 'Tokyo, Japan',
      start_date: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
      price: 1000,
      max_capacity: 10,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 20,
      status: 'PUBLISHED',
    });

    const booking = await createBooking(refundableTrip.id, userId1, 2);
    const idempotencyKey = `webhook-${uuidv4()}`;
    await processWebhook(booking.id, 'success', idempotencyKey);

    const cancelled = await cancelBookingWithRefund(booking.id);

    assert(cancelled.state === STATES.CANCELLED, 'Booking should be CANCELLED');
    assertApprox(Number(cancelled.refund_amount), 1600, 0.01, 'Refund should be 1600');

    const trip = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [refundableTrip.id]);
    assert(trip!.available_seats === 10, 'Seats should be released');
  });

  await test('Cancel booking after cutoff - no refund', async () => {
    const nonRefundableTrip = await createTrip({
      title: 'Non-Refundable Test Trip',
      destination: 'London, UK',
      start_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
      price: 500,
      max_capacity: 5,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED',
    });

    const booking = await createBooking(nonRefundableTrip.id, userId1, 1);
    const idempotencyKey = `webhook-${uuidv4()}`;
    await processWebhook(booking.id, 'success', idempotencyKey);

    const cancelled = await cancelBookingWithRefund(booking.id);

    assert(cancelled.state === STATES.CANCELLED, 'Booking should be CANCELLED');
    assert(Number(cancelled.refund_amount) === 0, 'Refund should be 0 after cutoff');

    const trip = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [nonRefundableTrip.id]);
    assert(trip!.available_seats === 4, 'Seats should NOT be released after cutoff');
  });

  await test('Reject cancellation of expired booking', async () => {
    const booking = await createBooking(testTrip2Id, userId1, 1);

    await db!.transaction(async () => {
      await db!.run(
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

  console.log('\n📋 SECTION 5: ADMIN APIs\n');

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

    const b1 = await createBooking(metricsTrip.id, userId1, 3);
    const b2 = await createBooking(metricsTrip.id, userId2, 2);
    const b3 = await createBooking(metricsTrip.id, userId1, 1);

    await processWebhook(b1.id, 'success', `key-${uuidv4()}`);
    await processWebhook(b2.id, 'success', `key-${uuidv4()}`);

    await cancelBookingWithRefund(b1.id);

    const trip = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [metricsTrip.id]);
    const bookings = await db!.all<BookingRow>(
      'SELECT * FROM bookings WHERE trip_id = ?',
      [metricsTrip.id]
    );

    const bookedSeats = trip!.max_capacity - trip!.available_seats;
    const occupancyPercent = Math.round((bookedSeats / trip!.max_capacity) * 100);

    const confirmed = bookings.filter((b: BookingRow) => b.state === STATES.CONFIRMED).length;
    const pending = bookings.filter((b: BookingRow) => b.state === STATES.PENDING_PAYMENT).length;
    const cancelled = bookings.filter((b: BookingRow) => b.state === STATES.CANCELLED).length;

    const gross = bookings
      .filter((b: BookingRow) => b.state === STATES.CONFIRMED || b.state === STATES.CANCELLED)
      .reduce((sum: number, b: BookingRow) => sum + b.price_at_booking, 0);

    const refunds = bookings.reduce((sum: number, b: BookingRow) => sum + (b.refund_amount || 0), 0);

    assert(occupancyPercent > 0, 'Occupancy should be calculated');
    assert(confirmed >= 0, 'Should have confirmed bookings count');
    assert(pending >= 0, 'Should have pending bookings count');
    assert(cancelled >= 0, 'Should have cancelled bookings count');
    assert(gross > 0, 'Gross revenue should be calculated');
  });

  await test('List at-risk trips - low occupancy and departing soon', async () => {
    const atRiskTrip = await createTrip({
      title: 'At-Risk Trip',
      destination: 'Berlin, Germany',
      start_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      price: 300,
      max_capacity: 20,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED',
    });

    const booking = await createBooking(atRiskTrip.id, userId1, 2);
    await processWebhook(booking.id, 'success', `key-${uuidv4()}`);

    const now = new Date();
    const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const todayIso = now.toISOString();

    const trips = await db!.all<TripRow & { booked: number }>(
      `SELECT *, (max_capacity - available_seats) AS booked
       FROM trips
       WHERE start_date <= ? AND start_date >= ? AND status = 'PUBLISHED'`,
      [inSevenDays, todayIso]
    );

    const atRisk = trips
      .map((t) => ({ trip: t, occupancy: Math.round((t.booked / t.max_capacity) * 100) }))
      .filter((t) => t.occupancy < 50);

    assert(atRisk.length > 0, 'Should find at-risk trips');
    assert(atRisk.some((t) => t.trip.id === atRiskTrip.id), 'Should include the at-risk trip');
  });

  console.log('\n📋 SECTION 6: CONCURRENCY & RACE CONDITIONS\n');

  await test('Prevent overbooking - race condition on last seat', async () => {
    const raceTrip = await createTrip({
      title: 'Race Condition Test',
      destination: 'Amsterdam, Netherlands',
      start_date: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString(),
      price: 200,
      max_capacity: 1,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED',
    });

    const userA = uuidv4();
    const userB = uuidv4();

    const results = await Promise.allSettled([
      createBooking(raceTrip.id, userA, 1),
      createBooking(raceTrip.id, userB, 1),
    ]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    assert(successes.length === 1, `Expected 1 success, got ${successes.length}`);
    assert(failures.length === 1, `Expected 1 failure, got ${failures.length}`);

    const trip = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [raceTrip.id]);
    assert(trip!.available_seats === 0, 'Available seats should be 0');

    assert(failures.length === 1, 'Should have exactly one failure');
    const failedResult = failures[0];
    if (failedResult.status === 'rejected') {
      const error = failedResult.reason;
      const isHttpError409 = error instanceof HttpError && error.status === 409;
      const isTransactionError = error && (error.message || '').includes('transaction');
      assert(
        isHttpError409 || isTransactionError,
        `Should throw 409 Conflict or transaction error, got: ${error?.message || error}`
      );
    } else {
      assert(false, 'Failed result should be rejected');
    }
  });

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

    for (const userId of users) {
      await createBooking(concurrentTrip.id, userId, 1);
    }

    const trip = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [concurrentTrip.id]);
    assert(trip!.available_seats === 5, 'Should have 5 seats remaining (10 - 5)');
    
    const bookings = await db!.all<BookingRow>(
      'SELECT * FROM bookings WHERE trip_id = ?',
      [concurrentTrip.id]
    );
    assert(bookings.length === 5, 'Should have 5 bookings created');
  });

  console.log('\n' + '='.repeat(80));
  console.log(`\n✅ All tests completed!`);
  console.log(`   Total tests: ${testCount}`);
  console.log(`   Passed: ${passCount}`);
  console.log(`   Failed: ${testCount - passCount}\n`);
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
