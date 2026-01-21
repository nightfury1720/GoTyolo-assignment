import { v4 as uuidv4 } from 'uuid';
import { db, initializeDb } from '../src/db/database';
import { STATES, HttpError } from '../src/types';
import { seed } from '../scripts/seed';

const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

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

async function apiRequest(method: string, path: string, body?: any): Promise<any> {
  const url = `${API_BASE_URL}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data: any = await response.json();

  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    (error as any).status = response.status;
    throw error;
  }

  return data;
}

async function clearDatabase(): Promise<void> {
  await db.transaction(async () => {
    await db.run('DELETE FROM bookings');
    await db.run('DELETE FROM trips');
  });
}

async function runSeedScript(): Promise<void> {
  await seed();
}

async function runTests(): Promise<void> {
  console.log('🧪 Starting comprehensive tests for GoTyolo booking system...\n');
  console.log('='.repeat(80));

  try {
    const healthResponse = await fetch(`${API_BASE_URL}/health`);
    if (!healthResponse.ok) {
      throw new Error('Server health check failed');
    }
    console.log('✅ API server is running\n');
  } catch (err) {
    console.error('❌ API server is not running. Please start the server first:');
    console.error('   npm run dev');
    process.exit(1);
  }

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

  console.log('\n📋 SECTION 0: DATABASE SETUP & SEED VERIFICATION\n');

  await test('Clear database', async () => {
    await clearDatabase();
    const trips = await db.all('SELECT * FROM trips');
    const bookings = await db.all('SELECT * FROM bookings');
    assert(trips.length === 0, 'Trips table should be empty');
    assert(bookings.length === 0, 'Bookings table should be empty');
  });

  await test('Run seed script', async () => {
    await runSeedScript();
  });

  await test('Verify seed data via API', async () => {
    const response = await apiRequest('GET', '/api/trips');
    assert(Array.isArray(response.trips), 'Response should contain trips array');
    assert(response.trips.length >= 5, `Expected at least 5 trips, got ${response.trips.length}`);
    
    const allPublished = response.trips.every((t: any) => t.status === 'PUBLISHED');
    assert(allPublished, 'All seeded trips should be PUBLISHED');
    
    console.log(`   ✅ Found ${response.trips.length} trips in database`);
  });

  console.log('\n📋 SECTION 1: TRIP MANAGEMENT (via API)\n');

  let testTripId: string;
  let testTrip2Id: string;

  await test('Create new trip with DRAFT status via API', async () => {
    const tripData = {
      title: 'Test Trip - Barcelona',
      destination: 'Barcelona, Spain',
      start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString(),
      price: 750,
      max_capacity: 20,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 15,
      status: 'DRAFT',
    };

    const response = await apiRequest('POST', '/api/trips', tripData);
    const trip = response.trip;
    testTripId = trip.id;

    assert(trip.title === tripData.title, 'Trip title should match');
    assert(trip.status === 'DRAFT', 'Trip status should be DRAFT');
    assert(trip.available_seats === trip.max_capacity, 'Available seats should equal max capacity');
    assert(trip.price === tripData.price, 'Trip price should match');
  });

  await test('Create new trip with PUBLISHED status via API', async () => {
    const tripData = {
      title: 'Test Trip - Paris',
      destination: 'Paris, France',
      start_date: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
      price: 600,
      max_capacity: 15,
      refundable_until_days_before: 5,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED',
    };

    const response = await apiRequest('POST', '/api/trips', tripData);
    const trip = response.trip;
    testTrip2Id = trip.id;

    assert(trip.status === 'PUBLISHED', 'Trip status should be PUBLISHED');
    assert(trip.available_seats === trip.max_capacity, 'Available seats should equal max capacity');
  });

  await test('Get trip details by ID via API', async () => {
    const trip = await apiRequest('GET', `/api/trips/${testTripId}`);
    assert(!!trip, 'Trip should exist');
    assert(trip.title === 'Test Trip - Barcelona', 'Trip title should match');
  });

  await test('List only published trips via API', async () => {
    const response = await apiRequest('GET', '/api/trips?status=PUBLISHED');
    assert(Array.isArray(response.trips), 'Response should contain trips array');
    assert(response.trips.length > 0, 'Should have at least one published trip');
    assert(response.trips.every((t: any) => t.status === 'PUBLISHED'), 'All trips should be PUBLISHED');
  });

  await test('Reject trip creation with end_date before start_date via API', async () => {
    try {
      await apiRequest('POST', '/api/trips', {
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
      assert(err.status === 400, 'Should throw 400 Bad Request');
    }
  });

  await test('Reject trip creation with invalid price via API', async () => {
    try {
      await apiRequest('POST', '/api/trips', {
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
      assert(err.status === 400, 'Should throw 400 Bad Request');
    }
  });

  console.log('\n📋 SECTION 2: BOOKING MANAGEMENT (via API)\n');

  let bookingId1: string;
  let bookingId2: string;
  const userId1 = uuidv4();
  const userId2 = uuidv4();

  await test('Create booking for published trip via API', async () => {
    const response = await apiRequest('POST', `/api/trips/${testTrip2Id}/book`, {
      user_id: userId1,
      num_seats: 2,
    });
    const booking = response.booking;
    bookingId1 = booking.id;

    assert(booking.state === STATES.PENDING_PAYMENT, 'Booking should start in PENDING_PAYMENT state');
    assert(booking.num_seats === 2, 'Should book 2 seats');
    assert(booking.price_at_booking === 600 * 2, 'Price should be 600 * 2 = 1200');
    assert(!!booking.expires_at, 'Should have expires_at timestamp');

    const trip = await apiRequest('GET', `/api/trips/${testTrip2Id}`);
    assert(trip.available_seats === 13, 'Available seats should be 15 - 2 = 13');
  });

  await test('Get booking details by ID via API', async () => {
    const booking = await apiRequest('GET', `/api/bookings/${bookingId1}`);
    assert(!!booking, 'Booking should exist');
    assert(booking.state === STATES.PENDING_PAYMENT, 'Booking state should be PENDING_PAYMENT');
    assert(booking.num_seats === 2, 'Should have 2 seats');
  });

  await test('Reject booking when not enough seats available via API', async () => {
    try {
      await apiRequest('POST', `/api/trips/${testTrip2Id}/book`, {
        user_id: userId2,
        num_seats: 20,
      });
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err.status === 409, 'Should throw 409 Conflict');
    }
  });

  await test('Reject booking for DRAFT trip via API', async () => {
    try {
      await apiRequest('POST', `/api/trips/${testTripId}/book`, {
        user_id: userId1,
        num_seats: 1,
      });
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err.status === 404, 'Should throw 404 Not Found');
    }
  });

  console.log('\n📋 SECTION 3: PAYMENT PROCESSING & WEBHOOKS (via API)\n');

  await test('Process successful payment webhook via API', async () => {
    const idempotencyKey = `webhook-${uuidv4()}`;
    const result = await apiRequest('POST', '/api/payments/webhook', {
      booking_id: bookingId1,
      status: 'success',
      idempotency_key: idempotencyKey,
    });

    assert(result.state === STATES.CONFIRMED, 'Booking should be CONFIRMED');

    const booking = await apiRequest('GET', `/api/bookings/${bookingId1}`);
    assert(booking.state === STATES.CONFIRMED, 'Booking state should be CONFIRMED');
    assert(booking.idempotency_key === idempotencyKey, 'Idempotency key should be stored');
  });

  await test('Webhook idempotency - process same webhook twice via API', async () => {
    const bookingResponse = await apiRequest('POST', `/api/trips/${testTrip2Id}/book`, {
      user_id: userId2,
      num_seats: 1,
    });
    bookingId2 = bookingResponse.booking.id;
    const idempotencyKey = `webhook-${uuidv4()}`;

    const result1 = await apiRequest('POST', '/api/payments/webhook', {
      booking_id: bookingId2,
      status: 'success',
      idempotency_key: idempotencyKey,
    });
    const result2 = await apiRequest('POST', '/api/payments/webhook', {
      booking_id: bookingId2,
      status: 'success',
      idempotency_key: idempotencyKey,
    });

    assert(result1.state === STATES.CONFIRMED, 'First webhook should confirm');
    assert(result2.state === STATES.CONFIRMED, 'Second webhook should be idempotent');
    assert(result1.id === result2.id, 'Should return same booking');
  });

  await test('Process failed payment webhook via API', async () => {
    const tripBefore = await apiRequest('GET', `/api/trips/${testTrip2Id}`);
    const seatsBefore = tripBefore.available_seats;

    const bookingResponse = await apiRequest('POST', `/api/trips/${testTrip2Id}/book`, {
      user_id: userId1,
      num_seats: 1,
    });
    const booking = bookingResponse.booking;

    const tripAfterBooking = await apiRequest('GET', `/api/trips/${testTrip2Id}`);
    assert(tripAfterBooking.available_seats === seatsBefore - 1, 'Seat should be decremented on booking');

    const idempotencyKey = `webhook-fail-${uuidv4()}`;
    const result = await apiRequest('POST', '/api/payments/webhook', {
      booking_id: booking.id,
      status: 'failed',
      idempotency_key: idempotencyKey,
    });
    assert(result.state === STATES.EXPIRED, 'Booking should be EXPIRED on failure');

    const tripAfterFailure = await apiRequest('GET', `/api/trips/${testTrip2Id}`);
    assert(tripAfterFailure.available_seats === seatsBefore, 'Seats should be released on payment failure');
  });

  console.log('\n📋 SECTION 4: REFUND & CANCELLATION POLICY (via API)\n');

  await test('Cancel booking before cutoff - should refund with fee via API', async () => {
    const refundableTripResponse = await apiRequest('POST', '/api/trips', {
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
    const refundableTrip = refundableTripResponse.trip;

    const bookingResponse = await apiRequest('POST', `/api/trips/${refundableTrip.id}/book`, {
      user_id: userId1,
      num_seats: 2,
    });
    const booking = bookingResponse.booking;
    const idempotencyKey = `webhook-${uuidv4()}`;
    await apiRequest('POST', '/api/payments/webhook', {
      booking_id: booking.id,
      status: 'success',
      idempotency_key: idempotencyKey,
    });

    const cancelled = await apiRequest('POST', `/api/bookings/${booking.id}/cancel`);

    assert(cancelled.state === STATES.CANCELLED, 'Booking should be CANCELLED');
    assertApprox(Number(cancelled.refund_amount), 1600, 0.01, 'Refund should be 1600');

    const trip = await apiRequest('GET', `/api/trips/${refundableTrip.id}`);
    assert(trip.available_seats === 10, 'Seats should be released');
  });

  await test('Cancel booking after cutoff - no refund via API', async () => {
    const nonRefundableTripResponse = await apiRequest('POST', '/api/trips', {
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
    const nonRefundableTrip = nonRefundableTripResponse.trip;

    const bookingResponse = await apiRequest('POST', `/api/trips/${nonRefundableTrip.id}/book`, {
      user_id: userId1,
      num_seats: 1,
    });
    const booking = bookingResponse.booking;
    const idempotencyKey = `webhook-${uuidv4()}`;
    await apiRequest('POST', '/api/payments/webhook', {
      booking_id: booking.id,
      status: 'success',
      idempotency_key: idempotencyKey,
    });

    const cancelled = await apiRequest('POST', `/api/bookings/${booking.id}/cancel`);

    assert(cancelled.state === STATES.CANCELLED, 'Booking should be CANCELLED');
    assert(Number(cancelled.refund_amount) === 0, 'Refund should be 0 after cutoff');

    const trip = await apiRequest('GET', `/api/trips/${nonRefundableTrip.id}`);
    assert(trip.available_seats === 5, 'Seats are released after cancellation (even after cutoff)');
  });

  await test('Reject cancellation of expired booking via API', async () => {
    const bookingResponse = await apiRequest('POST', `/api/trips/${testTrip2Id}/book`, {
      user_id: userId1,
      num_seats: 1,
    });
    const booking = bookingResponse.booking;

    await db.run(
      'UPDATE bookings SET state = ?, expires_at = ? WHERE id = ?',
      [STATES.EXPIRED, new Date(Date.now() - 60 * 60 * 1000).toISOString(), booking.id]
    );

    try {
      await apiRequest('POST', `/api/bookings/${booking.id}/cancel`);
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err.status === 409, 'Should throw 409 Conflict');
    }
  });

  await test('Reject cancellation of already cancelled booking via API', async () => {
    const bookingResponse = await apiRequest('POST', `/api/trips/${testTrip2Id}/book`, {
      user_id: userId1,
      num_seats: 1,
    });
    const booking = bookingResponse.booking;
    const idempotencyKey = `webhook-${uuidv4()}`;
    await apiRequest('POST', '/api/payments/webhook', {
      booking_id: booking.id,
      status: 'success',
      idempotency_key: idempotencyKey,
    });

    await apiRequest('POST', `/api/bookings/${booking.id}/cancel`);

    try {
      await apiRequest('POST', `/api/bookings/${booking.id}/cancel`);
      assert(false, 'Should have thrown an error');
    } catch (err: any) {
      assert(err.status === 409, 'Should throw 409 Conflict');
    }
  });

  console.log('\n📋 SECTION 5: ADMIN APIs (via API)\n');

  await test('Get trip metrics - occupancy and financials via API', async () => {
    const metricsTripResponse = await apiRequest('POST', '/api/trips', {
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
    const metricsTrip = metricsTripResponse.trip;

    const b1 = await apiRequest('POST', `/api/trips/${metricsTrip.id}/book`, {
      user_id: userId1,
      num_seats: 3,
    });
    const b2 = await apiRequest('POST', `/api/trips/${metricsTrip.id}/book`, {
      user_id: userId2,
      num_seats: 2,
    });
    const b3 = await apiRequest('POST', `/api/trips/${metricsTrip.id}/book`, {
      user_id: userId1,
      num_seats: 1,
    });

    await apiRequest('POST', '/api/payments/webhook', {
      booking_id: b1.booking.id,
      status: 'success',
      idempotency_key: `key-${uuidv4()}`,
    });
    await apiRequest('POST', '/api/payments/webhook', {
      booking_id: b2.booking.id,
      status: 'success',
      idempotency_key: `key-${uuidv4()}`,
    });

    await apiRequest('POST', `/api/bookings/${b1.booking.id}/cancel`);

    const metrics = await apiRequest('GET', `/api/admin/trips/${metricsTrip.id}/metrics`);

    assert(metrics.occupancy_percent > 0, 'Occupancy should be calculated');
    assert(metrics.booking_summary.confirmed >= 0, 'Should have confirmed bookings count');
    assert(metrics.booking_summary.pending_payment >= 0, 'Should have pending bookings count');
    assert(metrics.booking_summary.cancelled >= 0, 'Should have cancelled bookings count');
    assert(metrics.financial.gross_revenue > 0, 'Gross revenue should be calculated');
  });

  await test('List at-risk trips - low occupancy and departing soon via API', async () => {
    const atRiskTripResponse = await apiRequest('POST', '/api/trips', {
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
    const atRiskTrip = atRiskTripResponse.trip;

    const bookingResponse = await apiRequest('POST', `/api/trips/${atRiskTrip.id}/book`, {
      user_id: userId1,
      num_seats: 2,
    });
    await apiRequest('POST', '/api/payments/webhook', {
      booking_id: bookingResponse.booking.id,
      status: 'success',
      idempotency_key: `key-${uuidv4()}`,
    });

    const response = await apiRequest('GET', '/api/admin/trips/at-risk');

    assert(Array.isArray(response.at_risk_trips), 'Should return at-risk trips array');
    assert(response.at_risk_trips.length > 0, 'Should find at-risk trips');
    assert(
      response.at_risk_trips.some((t: any) => t.trip_id === atRiskTrip.id),
      'Should include the at-risk trip'
    );
  });

  console.log('\n📋 SECTION 6: CONCURRENCY & RACE CONDITIONS (via API)\n');

  await test('Prevent overbooking - race condition on last seat via API', async () => {
    const raceTripResponse = await apiRequest('POST', '/api/trips', {
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
    const raceTrip = raceTripResponse.trip;

    const userA = uuidv4();
    const userB = uuidv4();

    const results = await Promise.allSettled([
      apiRequest('POST', `/api/trips/${raceTrip.id}/book`, {
        user_id: userA,
        num_seats: 1,
      }),
      apiRequest('POST', `/api/trips/${raceTrip.id}/book`, {
        user_id: userB,
        num_seats: 1,
      }),
    ]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    assert(successes.length === 1, `Expected 1 success, got ${successes.length}`);
    assert(failures.length === 1, `Expected 1 failure, got ${failures.length}`);

    const trip = await apiRequest('GET', `/api/trips/${raceTrip.id}`);
    assert(trip.available_seats === 0, 'Available seats should be 0');

    assert(failures.length === 1, 'Should have exactly one failure');
    const failedResult = failures[0];
    if (failedResult.status === 'rejected') {
      const error = failedResult.reason;
      const isHttpError409 = error && (error as any).status === 409;
      assert(isHttpError409, `Should throw 409 Conflict, got: ${error?.message || error}`);
    } else {
      assert(false, 'Failed result should be rejected');
    }
  });

  await test('Handle multiple bookings correctly without overbooking via API', async () => {
    const concurrentTripResponse = await apiRequest('POST', '/api/trips', {
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
    const concurrentTrip = concurrentTripResponse.trip;

    const users = Array.from({ length: 5 }, () => uuidv4());

    for (const userId of users) {
      await apiRequest('POST', `/api/trips/${concurrentTrip.id}/book`, {
        user_id: userId,
        num_seats: 1,
      });
    }

    const trip = await apiRequest('GET', `/api/trips/${concurrentTrip.id}`);
    assert(trip.available_seats === 5, 'Should have 5 seats remaining (10 - 5)');
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
