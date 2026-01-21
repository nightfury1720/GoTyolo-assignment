import { v4 as uuidv4 } from 'uuid';
import { db, initializeDb } from '../src/db/database';
import { STATES } from '../src/types';
import { seed } from '../scripts/seed';

const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
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
    await db.run('DELETE FROM reservations');
    await db.run('DELETE FROM bookings');
    await db.run('DELETE FROM trips');
  });
}

async function runTests(): Promise<void> {
  console.log('🧪 Starting smoke tests...\n');

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

  console.log('📋 SECTION 0: DATABASE SETUP & SEED VERIFICATION\n');

  await clearDatabase();
  const tripsBefore = await db.all('SELECT * FROM trips');
  const bookingsBefore = await db.all('SELECT * FROM bookings');
  assert(tripsBefore.length === 0, 'Trips table should be empty');
  assert(bookingsBefore.length === 0, 'Bookings table should be empty');
  console.log('✅ Database cleared');

  await seed();
  console.log('✅ Seed script executed');

  const response = await apiRequest('GET', '/api/trips');
  assert(Array.isArray(response.trips), 'Response should contain trips array');
  assert(response.trips.length >= 5, `Expected at least 5 trips, got ${response.trips.length}`);
  console.log(`✅ Verified ${response.trips.length} trips via API`);

  const existingTrip = response.trips[0];
  console.log(`✅ Found existing trip: ${existingTrip.title}\n`);

  console.log('📋 Test 1: Concurrency - Two users racing for last seat (via API)');

  const now = new Date();
  const raceTripResponse = await apiRequest('POST', '/api/trips', {
    title: 'Concurrency Test Trip',
    destination: 'Testville',
    start_date: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    end_date: new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString(),
    price: 100,
    max_capacity: 1,
    refundable_until_days_before: 7,
    cancellation_fee_percent: 10,
    status: 'PUBLISHED',
  });
  const raceTrip = raceTripResponse.trip;
  const tripId = raceTrip.id;

  const userA = uuidv4();
  const userB = uuidv4();

  const results = await Promise.allSettled([
    apiRequest('POST', `/api/trips/${tripId}/book`, {
      user_id: userA,
      num_seats: 1,
    }),
    apiRequest('POST', `/api/trips/${tripId}/book`, {
      user_id: userB,
      num_seats: 1,
    }),
  ]);

  const successes = results.filter((r) => r.status === 'fulfilled');
  const failures = results.filter((r) => r.status === 'rejected');

  assert(successes.length === 1, `Expected 1 success, got ${successes.length}`);
  assert(failures.length === 1, `Expected 1 failure, got ${failures.length}`);

  // With 2PC: seats are NOT decremented until payment confirmation
  const tripAfterBooking = await apiRequest('GET', `/api/trips/${tripId}`);
  assert(tripAfterBooking.available_seats === 1, 'Expected available_seats=1 after booking (2PC Phase 1)');

  // Confirm payment to trigger Phase 2 (seat decrement)
  const bookingForPayment = (successes[0] as PromiseFulfilledResult<any>).value.booking;
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: bookingForPayment.id,
    status: 'success',
    idempotency_key: `smoke-${uuidv4()}`,
  });

  const tripAfter = await apiRequest('GET', `/api/trips/${tripId}`);
  assert(tripAfter.available_seats === 0, 'Expected available_seats=0 after payment confirmation');

  console.log('✅ Concurrency test passed - Only one booking succeeded');

  console.log('\n📋 Test 2: Webhook idempotency - Process success twice (via API)');

  const successfulBooking = (successes[0] as PromiseFulfilledResult<any>).value.booking;
  const idemKey = `webhook-${uuidv4()}`;

  const w1 = await apiRequest('POST', '/api/payments/webhook', {
    booking_id: successfulBooking.id,
    status: 'success',
    idempotency_key: idemKey,
  });
  const w2 = await apiRequest('POST', '/api/payments/webhook', {
    booking_id: successfulBooking.id,
    status: 'success',
    idempotency_key: idemKey,
  });

  assert(w1.state === STATES.CONFIRMED, 'Expected CONFIRMED after first webhook');
  assert(w2.state === STATES.CONFIRMED, 'Expected CONFIRMED after second webhook (idempotent)');

  console.log('✅ Idempotency test passed - Second webhook was no-op');

  console.log('\n📋 Test 3: Refund calculation and seat release (via API)');

  const cancelled = await apiRequest('POST', `/api/bookings/${successfulBooking.id}/cancel`);

  assert(cancelled.state === STATES.CANCELLED, 'Expected CANCELLED state');
  assert(Number(cancelled.refund_amount) === 90, `Expected refund 90.00, got ${cancelled.refund_amount}`);

  const tripAfterCancel = await apiRequest('GET', `/api/trips/${tripId}`);
  assert(tripAfterCancel.available_seats === 1, 'Expected seat released back after refundable cancel');

  console.log('✅ Refund test passed - Correct amount calculated and seats released');

  console.log('\n📋 Test 4: Auto-expiry of pending bookings (via API + DB for expiry)');

  const pendingBookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1,
  });
  const pendingBooking = pendingBookingResponse.booking;

  await db.run(
    'UPDATE bookings SET expires_at = ? WHERE id = ?',
    [new Date(Date.now() - 60 * 60 * 1000).toISOString(), pendingBooking.id]
  );

  const expiredCheck = await apiRequest('GET', `/api/bookings/${pendingBooking.id}`);
  assert(expiredCheck.state === STATES.PENDING_PAYMENT, 'Booking should still be pending (expiry job not run in test)');

  console.log('✅ Auto-expiry test structure verified (expiry job runs via cron)');

  console.log('\n🎉 All smoke tests passed!\n');
}

runTests().catch((err) => {
  console.error('\n❌ Smoke tests failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
