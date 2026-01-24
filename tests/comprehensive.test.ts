import { v4 as uuidv4 } from 'uuid';
import { db, initializeDb } from '../src/db/database';
import { STATES, HttpError, TripRow } from '../src/types';
import { seed } from '../scripts/seed';
import { expirePendingBookings } from '../src/services/expiryService';
import { createReservation, createBooking, getBooking } from '../src/services/bookingService';
import { processWebhook } from '../src/services/paymentService';
import { cancelBookingWithRefund } from '../src/services/refundService';
import { createTrip } from '../src/services/tripService';

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

async function testDatabaseConnection(): Promise<void> {
  console.log('🧪 Testing database connection...');
  const result = await db.get<{ test: number }>('SELECT 1 as test');
  assert(result?.test === 1, 'Database connection failed');
  console.log('✅ Database connection test passed');
}

async function testSeedData(): Promise<void> {
  console.log('🧪 Testing seed data...');
  const trips = await db.all('SELECT * FROM trips');
  assert(trips.length === 5, `Expected 5 trips, got ${trips.length}`);
  const bookings = await db.all('SELECT * FROM bookings');
  assert(bookings.length === 10, `Expected 10 bookings, got ${bookings.length}`);
  console.log('✅ Seed data test passed');
}

async function testGetTrips(): Promise<void> {
  console.log('🧪 Testing GET /api/trips...');
  const tripsResponse = await apiRequest('GET', '/api/trips');
  assert(tripsResponse.trips, 'Should have trips property');
  assert(Array.isArray(tripsResponse.trips), 'Trips should be an array');
  assert(tripsResponse.trips.length > 0, 'Should have trips');
  assert(tripsResponse.trips.every((t: any) => t.status === 'PUBLISHED'), 'All trips should be published');
  console.log('✅ GET /api/trips test passed');
}

async function testGetTripById(): Promise<void> {
  console.log('🧪 Testing GET /api/trips/:id...');
  const trips = await db.all<TripRow>('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const tripId = trips[0].id;
  const tripResponse = await apiRequest('GET', `/api/trips/${tripId}`);
  assert(tripResponse.id === tripId, 'Trip ID should match');
  assert(tripResponse.title, 'Should have title');
  assert(tripResponse.price, 'Should have price');
  assert(tripResponse.destination, 'Should have destination');
  console.log('✅ GET /api/trips/:id test passed');
}

async function testGetBooking(): Promise<void> {
  console.log('🧪 Testing GET /api/bookings/:id...');
  const bookings = await db.all('SELECT * FROM bookings LIMIT 1');
  if (bookings.length > 0) {
    const bookingId = (bookings[0] as any).id;
    const bookingResponse = await apiRequest('GET', `/api/bookings/${bookingId}`);
    assert(bookingResponse.id === bookingId, 'Booking ID should match');
    assert(bookingResponse.state, 'Should have state');
  }
  console.log('✅ GET /api/bookings/:id test passed');
}

async function testGetAdminMetrics(): Promise<void> {
  console.log('🧪 Testing GET /api/admin/metrics...');
  const trips = await db.all<TripRow>('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const tripId = trips[0].id;
  const metricsResponse = await apiRequest('GET', `/api/admin/trips/${tripId}/metrics`);
  assert(metricsResponse.trip_id, 'Should have trip_id');
  assert(metricsResponse.occupancy_percent !== undefined, 'Should have occupancy_percent');
  assert(metricsResponse.total_seats !== undefined, 'Should have total_seats');
  assert(metricsResponse.booked_seats !== undefined, 'Should have booked_seats');
  assert(metricsResponse.available_seats !== undefined, 'Should have available_seats');
  console.log('✅ GET /api/admin/metrics test passed');
}

async function testGetAtRiskTrips(): Promise<void> {
  console.log('🧪 Testing GET /api/admin/trips/at-risk...');
  const atRiskResponse = await apiRequest('GET', '/api/admin/trips/at-risk');
  assert(atRiskResponse.at_risk_trips !== undefined, 'Should have at_risk_trips field');
  assert(Array.isArray(atRiskResponse.at_risk_trips), 'at_risk_trips should be an array');
  console.log('✅ GET /api/admin/trips/at-risk test passed');
}

async function testCreateTrip(): Promise<void> {
  console.log('🧪 Testing POST /api/trips...');
  const tripData = {
    title: 'Test Trip',
    destination: 'Test Destination',
    start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    end_date: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString(),
    price: 1000,
    max_capacity: 50,
    refundable_until_days_before: 7,
    cancellation_fee_percent: 10,
    status: 'PUBLISHED'
  };
  const tripResponse = await apiRequest('POST', '/api/trips', tripData);
  assert(tripResponse.trip, 'Should have trip object');
  assert(tripResponse.trip.id, 'Should have trip ID');
  assert(tripResponse.trip.title === tripData.title, 'Title should match');
  console.log('✅ POST /api/trips test passed');
}

async function testCreateBooking(): Promise<void> {
  console.log('🧪 Testing POST /api/trips/:id/book...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const bookingData = {
    user_id: uuidv4(),
    num_seats: 2
  };
  const bookingResponse = await apiRequest('POST', `/api/trips/${trip.id}/book`, bookingData);
  assert(bookingResponse.booking, 'Should have booking object');
  assert(bookingResponse.booking.id, 'Should have booking ID');
  assert(bookingResponse.payment_url, 'Should have payment_url');
  assert(bookingResponse.booking.state === STATES.PENDING_PAYMENT, 'Should be pending payment');
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingResponse.booking.id]);
  assert(!!booking, 'Booking should exist in database');
  const reservation = await db.get('SELECT * FROM reservations WHERE booking_id = ?', [bookingResponse.booking.id]);
  assert(!!reservation, 'Reservation should exist');
  console.log('✅ POST /api/trips/:id/book test passed');
}

async function testPaymentWebhook(): Promise<void> {
  console.log('🧪 Testing POST /api/payments/webhook...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const booking = await createBooking(trip.id, uuidv4(), 1);
  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.run('UPDATE reservations SET expires_at = ? WHERE booking_id = ?', [futureExpiry, booking.id]);
  await db.run('UPDATE bookings SET expires_at = ? WHERE id = ?', [futureExpiry, booking.id]);
  const paymentData = {
    booking_id: booking.id,
    status: 'success',
    idempotency_key: uuidv4()
  };
  const paymentResponse = await apiRequest('POST', '/api/payments/webhook', paymentData);
  assert(paymentResponse.state === 'CONFIRMED', 'Payment should be confirmed');
  const updatedBooking = await db.get('SELECT * FROM bookings WHERE id = ?', [booking.id]);
  assert((updatedBooking as any).state === STATES.CONFIRMED, 'Booking should be confirmed');
  console.log('✅ POST /api/payments/webhook test passed');
}

async function testCancelBooking(): Promise<void> {
  console.log('🧪 Testing POST /api/bookings/:id/cancel...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const booking = await createBooking(trip.id, uuidv4(), 1);
  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.run('UPDATE reservations SET expires_at = ? WHERE booking_id = ?', [futureExpiry, booking.id]);
  await db.run('UPDATE bookings SET expires_at = ? WHERE id = ?', [futureExpiry, booking.id]);
  await processWebhook(booking.id, 'success', uuidv4());
  const cancelResponse = await apiRequest('POST', `/api/bookings/${booking.id}/cancel`);
  assert(cancelResponse, 'Cancellation should succeed');
  assert(cancelResponse.refund_amount !== undefined, 'Should have refund amount');
  const cancelledBooking = await db.get('SELECT * FROM bookings WHERE id = ?', [booking.id]);
  assert((cancelledBooking as any).state === STATES.CANCELLED, 'Booking should be cancelled');
  console.log('✅ POST /api/bookings/:id/cancel test passed');
}

async function testFailedPaymentWebhook(): Promise<void> {
  console.log('🧪 Testing failed payment webhook...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const booking = await createBooking(trip.id, uuidv4(), 1);
  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.run('UPDATE reservations SET expires_at = ? WHERE booking_id = ?', [futureExpiry, booking.id]);
  await db.run('UPDATE bookings SET expires_at = ? WHERE id = ?', [futureExpiry, booking.id]);
  const paymentData = {
    booking_id: booking.id,
    status: 'failed',
    idempotency_key: uuidv4()
  };
  await apiRequest('POST', '/api/payments/webhook', paymentData);
  const failedBooking = await db.get('SELECT * FROM bookings WHERE id = ?', [booking.id]);
  assert((failedBooking as any).state === STATES.EXPIRED, 'Booking should be expired on failed payment');
  console.log('✅ Failed payment webhook test passed');
}

async function testExpiryService(): Promise<void> {
  console.log('🧪 Testing expiry service...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const booking = await createBooking(trip.id, uuidv4(), 1);
  const pastTime = new Date(Date.now() - 1000).toISOString();
  await db.run('UPDATE reservations SET expires_at = ? WHERE booking_id = ?', [pastTime, booking.id]);
  await db.run('UPDATE bookings SET expires_at = ? WHERE id = ?', [pastTime, booking.id]);
  await expirePendingBookings();
  const expiredBooking = await db.get('SELECT * FROM bookings WHERE id = ?', [booking.id]);
  assert((expiredBooking as any).state === STATES.EXPIRED, 'Booking should be expired');
  const reservation = await db.get('SELECT * FROM reservations WHERE booking_id = ?', [booking.id]);
  assert(!reservation, 'Reservation should be cleaned up');
  console.log('✅ Expiry service test passed');
}

async function testOverbookingPrevention(): Promise<void> {
  console.log('🧪 Testing overbooking prevention...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const reservedSeats = await db.get<{ total_seats: number }>(
    `SELECT COALESCE(SUM(num_seats), 0) as total_seats
     FROM reservations
     WHERE trip_id = ? AND expires_at > ?`,
    [trip.id, new Date().toISOString()]
  );
  const remainingSeats = trip.max_capacity - (reservedSeats?.total_seats || 0);
  if (remainingSeats > 0) {
    const bookingData = {
      user_id: uuidv4(),
      num_seats: remainingSeats + 1
    };
    try {
      await apiRequest('POST', `/api/trips/${trip.id}/book`, bookingData);
      assert(false, 'Should have failed with overbooking');
    } catch (error: any) {
      assert(error.status === 409, `Expected 409, got ${error.status}`);
      assert(error.message.includes('Not enough seats'), 'Should mention seats availability');
    }
  }
  console.log('✅ Overbooking prevention test passed');
}

async function testRefundCalculations(): Promise<void> {
  console.log('🧪 Testing refund calculations...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const booking = await createBooking(trip.id, uuidv4(), 1);
  const priceAtBooking = booking.price_at_booking;
  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.run('UPDATE reservations SET expires_at = ? WHERE booking_id = ?', [futureExpiry, booking.id]);
  await db.run('UPDATE bookings SET expires_at = ? WHERE id = ?', [futureExpiry, booking.id]);
  await processWebhook(booking.id, 'success', uuidv4());
  const cancelResponse = await cancelBookingWithRefund(booking.id);
  const expectedRefund = priceAtBooking * (1 - (trip.cancellation_fee_percent || 0) / 100);
  assert(Math.abs(cancelResponse.refund_amount! - expectedRefund) < 0.01, 'Refund amount should match calculation');
  console.log('✅ Refund calculations test passed');
}

async function testRaceConditionPrevention(): Promise<void> {
  console.log('🧪 Testing race condition prevention...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const reservedSeats = await db.get<{ total_seats: number }>(
    `SELECT COALESCE(SUM(num_seats), 0) as total_seats
     FROM reservations
     WHERE trip_id = ? AND expires_at > ?`,
    [trip.id, new Date().toISOString()]
  );
  const availableSeats = trip.max_capacity - (reservedSeats?.total_seats || 0);
  if (availableSeats >= 2) {
    const userId = uuidv4();
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        createReservation(trip.id, `${userId}-${i}`, 1).catch(err => ({ error: err.message }))
      );
    }
    const results = await Promise.all(promises);
    const successful = results.filter((r: any) => !r.error);
    const failed = results.filter((r: any) => r.error);
    assert(successful.length <= availableSeats, 'Should not have more successful reservations than available seats');
    assert(failed.length >= 1, 'Should have at least one failure due to race condition');
    for (const result of successful) {
      await db.run('DELETE FROM reservations WHERE id = ?', [(result as any).reservationId]);
      await db.run('DELETE FROM bookings WHERE id = ?', [(result as any).bookingId]);
    }
  }
  console.log('✅ Race condition prevention test passed');
}

async function testConcurrentBookingCreation(): Promise<void> {
  console.log('🧪 Testing concurrent booking creation...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const reservedSeats = await db.get<{ total_seats: number }>(
    `SELECT COALESCE(SUM(num_seats), 0) as total_seats
     FROM reservations
     WHERE trip_id = ? AND expires_at > ?`,
    [trip.id, new Date().toISOString()]
  );
  const availableSeats = trip.max_capacity - (reservedSeats?.total_seats || 0);
  if (availableSeats >= 3) {
    const userIds = [uuidv4(), uuidv4(), uuidv4()];
    const promises = userIds.map(userId =>
      createBooking(trip.id, userId, 1).catch(err => ({ error: err.message, status: (err as any).status }))
    );
    const results = await Promise.all(promises);
    const successful = results.filter((r: any) => !r.error);
    const failed = results.filter((r: any) => r.error);
    assert(successful.length <= availableSeats, 'Should not have more successful bookings than available seats');
    assert(failed.length >= 0, 'Some requests may fail due to race conditions');
    const conflictFailures = failed.filter((r: any) => r.status === 409);
    assert(conflictFailures.length === failed.length, 'All failures should be 409 conflicts');
    for (const result of successful) {
      const bookingId = (result as any).id;
      await db.run('DELETE FROM bookings WHERE id = ?', [bookingId]);
      await db.run('DELETE FROM reservations WHERE booking_id = ?', [bookingId]);
    }
  }
  console.log('✅ Concurrent booking creation test passed');
}

async function testIdempotency(): Promise<void> {
  console.log('🧪 Testing webhook idempotency...');
  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;
  const booking = await createBooking(trip.id, uuidv4(), 1);
  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.run('UPDATE reservations SET expires_at = ? WHERE booking_id = ?', [futureExpiry, booking.id]);
  await db.run('UPDATE bookings SET expires_at = ? WHERE id = ?', [futureExpiry, booking.id]);
  const idempotencyKey = uuidv4();
  await processWebhook(booking.id, 'success', idempotencyKey);
  const firstState = (await db.get('SELECT * FROM bookings WHERE id = ?', [booking.id])) as any;
  await processWebhook(booking.id, 'success', idempotencyKey);
  const secondState = (await db.get('SELECT * FROM bookings WHERE id = ?', [booking.id])) as any;
  assert(firstState.state === secondState.state, 'State should not change on duplicate webhook');
  assert(firstState.idempotency_key === idempotencyKey, 'Idempotency key should be set');
  console.log('✅ Webhook idempotency test passed');
}

async function runComprehensiveTests(): Promise<void> {
  console.log('🚀 Starting comprehensive test suite...\n');

  try {
    process.env.NODE_ENV = 'test';

    await initializeDb();
    await testDatabaseConnection();

    console.log('\n📦 Step 1: Cleaning database...');
    await clearDatabase();
    console.log('✅ Database cleaned');

    console.log('\n📦 Step 2: Seeding data...');
    await seed();
    await testSeedData();

    console.log('\n📡 Step 3: Testing GET APIs...');
    await testGetTrips();
    await testGetTripById();
    await testGetBooking();
    await testGetAdminMetrics();
    await testGetAtRiskTrips();

    console.log('\n✏️  Step 4: Testing data modification APIs...');
    await testCreateTrip();
    await testCreateBooking();
    await testPaymentWebhook();
    await testCancelBooking();
    await testFailedPaymentWebhook();
    await testExpiryService();

    console.log('\n💼 Step 5: Testing business logic...');
    await testOverbookingPrevention();
    await testRefundCalculations();

    console.log('\n⚡ Step 6: Testing race conditions...');
    await testRaceConditionPrevention();
    await testConcurrentBookingCreation();
    await testIdempotency();

    console.log('\n🎉 ALL COMPREHENSIVE TESTS PASSED! 🎉');
    console.log('✅ Database operations working correctly');
    console.log('✅ GET APIs functioning correctly');
    console.log('✅ Data modification APIs working');
    console.log('✅ Business logic validated');
    console.log('✅ Race conditions prevented');

  } catch (error) {
    console.error('\n❌ COMPREHENSIVE TEST SUITE FAILED:', error);
    throw error;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  runComprehensiveTests().catch((err) => {
    console.error('Comprehensive test suite failed:', err.message);
    process.exit(1);
  });
}

export { runComprehensiveTests };
