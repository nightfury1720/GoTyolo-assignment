import { v4 as uuidv4 } from 'uuid';
import { db, initializeDb } from '../src/db/database';
import { STATES, HttpError, TripRow } from '../src/types';
import { seed } from '../scripts/seed';
import { expirePendingBookings } from '../src/services/expiryService';
import { createReservation } from '../src/services/bookingService';

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

async function testTripAPI(): Promise<void> {
  console.log('🧪 Testing trip API endpoints...');

  // Test GET /api/trips
  const tripsResponse = await apiRequest('GET', '/api/trips');
  assert(tripsResponse.trips, 'Should have trips property');
  assert(Array.isArray(tripsResponse.trips), 'Trips should be an array');
  assert(tripsResponse.trips.length > 0, 'Should have trips');

  // Test GET /api/trips/:id
  const tripId = tripsResponse.trips[0].id;
  const tripResponse = await apiRequest('GET', `/api/trips/${tripId}`);
  assert(tripResponse.id === tripId, 'Trip ID should match');

  console.log('✅ Trip API test passed');
}

async function testBookingCreation(): Promise<void> {
  console.log('🧪 Testing booking creation...');

  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;

  const bookingData = {
    user_id: uuidv4(),
    num_seats: 2
  };

  // Test POST /api/trips/:id/book
  const bookingResponse = await apiRequest('POST', `/api/trips/${trip.id}/book`, bookingData);
  assert(bookingResponse.booking, 'Should have booking object');
  assert(bookingResponse.payment_url, 'Should have payment_url');

  const bookingId = bookingResponse.booking.id;

  // Verify booking was created
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  assert(!!booking, 'Booking should exist');
  assert((booking as any).state === STATES.PENDING_PAYMENT, 'Booking should be pending payment');

  // Verify reservation was created (should be linked to the booking)
  const reservation = await db.get('SELECT * FROM reservations WHERE booking_id = ?', [bookingId]);
  assert(!!reservation, 'Reservation should exist');
  assert((reservation as any).num_seats === 2, 'Reservation should have 2 seats');

  console.log('✅ Booking creation test passed');
}

async function testOverbookingPrevention(): Promise<void> {
  console.log('🧪 Testing overbooking prevention...');

  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;

  // Calculate remaining capacity
  const reservedSeats = await db.get<{ total_seats: number }>(
    `SELECT COALESCE(SUM(num_seats), 0) as total_seats
     FROM reservations
     WHERE trip_id = ? AND expires_at > ?`,
    [trip.id, new Date().toISOString()]
  );

  const remainingSeats = trip.max_capacity - (reservedSeats?.total_seats || 0);

  if (remainingSeats > 0) {
    // Try to book more seats than available
    const bookingData = {
      user_id: uuidv4(),
      num_seats: remainingSeats + 1 // Request one more than available
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

async function testPaymentConfirmation(): Promise<void> {
  console.log('🧪 Testing payment confirmation...');

  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;

  // Create a reservation
  const bookingData = {
    user_id: uuidv4(),
    num_seats: 1
  };

  const bookingResponse = await apiRequest('POST', `/api/trips/${trip.id}/book`, bookingData);
  const bookingId = bookingResponse.booking.id;

  // Extend reservation expiry to avoid timing issues
  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours from now
  await db.run('UPDATE reservations SET expires_at = ? WHERE booking_id = ?', [futureExpiry, bookingId]);
  await db.run('UPDATE bookings SET expires_at = ? WHERE id = ?', [futureExpiry, bookingId]);

  // Confirm payment
  const paymentData = {
    booking_id: bookingId,
    status: 'success',
    idempotency_key: uuidv4()
  };

  const paymentResponse = await apiRequest('POST', '/api/payments/webhook', paymentData);
  assert((paymentResponse as any).state === 'CONFIRMED', 'Payment should be confirmed');

  // Verify booking is confirmed
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingResponse.booking.id]);
  assert((booking as any).state === STATES.CONFIRMED, 'Booking should be confirmed');

  console.log('✅ Payment confirmation test passed');
}

async function testCronJobExpiry(): Promise<void> {
  console.log('🧪 Testing cron job expiry...');

  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;

  // Create a reservation
  const bookingData = {
    user_id: uuidv4(),
    num_seats: 1
  };

  const bookingResponse = await apiRequest('POST', `/api/trips/${trip.id}/book`, bookingData);
  const bookingId = bookingResponse.booking.id;

  // Manually expire the reservation and booking by updating expires_at to past
  const pastTime = new Date(Date.now() - 1000).toISOString();
  await db.run('UPDATE reservations SET expires_at = ? WHERE booking_id = ?', [pastTime, bookingId]);
  await db.run('UPDATE bookings SET expires_at = ? WHERE id = ?', [pastTime, bookingId]);

  // Run expiry service
  await expirePendingBookings();

  // Verify booking was expired
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  assert((booking as any).state === STATES.EXPIRED, 'Booking should be expired');

  // Verify reservation was cleaned up
  const reservation = await db.get('SELECT * FROM reservations WHERE booking_id = ?', [bookingId]);
  assert(!reservation, 'Reservation should be cleaned up');

  console.log('✅ Cron job expiry test passed');
}

async function testRaceConditionPrevention(): Promise<void> {
  console.log('🧪 Testing race condition prevention...');

  const trips = await db.all('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const trip = trips[0] as any;

  // Calculate how many seats we can book
  const reservedSeats = await db.get<{ total_seats: number }>(
    `SELECT COALESCE(SUM(num_seats), 0) as total_seats
     FROM reservations
     WHERE trip_id = ? AND expires_at > ?`,
    [trip.id, new Date().toISOString()]
  );

  const availableSeats = trip.max_capacity - (reservedSeats?.total_seats || 0);

  if (availableSeats >= 2) {
    // Create multiple concurrent booking requests
    const userId = uuidv4();
    const promises = [];

    for (let i = 0; i < 3; i++) {
      promises.push(
        createReservation(trip.id, `${userId}-${i}`, 1).catch(err => ({ error: err.message }))
      );
    }

    const results = await Promise.all(promises);

    // Count successful reservations
    const successful = results.filter((r: any) => !r.error);
    const failed = results.filter((r: any) => r.error);

    assert(successful.length <= availableSeats, 'Should not have more successful reservations than available seats');
    assert(failed.length >= 1, 'Should have at least one failure due to race condition');

    // Clean up
    for (const result of successful) {
      await db.run('DELETE FROM reservations WHERE id = ?', [(result as any).reservationId]);
      await db.run('DELETE FROM bookings WHERE id = ?', [(result as any).bookingId]);
    }
  }

  console.log('✅ Race condition prevention test passed');
}

async function testAdminMetrics(): Promise<void> {
  console.log('🧪 Testing admin metrics...');

  // Get a trip ID for testing
  const trips = await db.all<TripRow>('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);
  const tripId = trips[0].id;

  // Test GET /api/admin/trips/:tripId/metrics
  const metricsResponse = await apiRequest('GET', `/api/admin/trips/${tripId}/metrics`);
  assert(metricsResponse.trip_id, 'Should have trip_id');
  assert(metricsResponse.occupancy_percent !== undefined, 'Should have occupancy_percent');

  // Test GET /api/admin/trips/at-risk
  const atRiskResponse = await apiRequest('GET', '/api/admin/trips/at-risk');
  assert(atRiskResponse.at_risk_trips !== undefined, 'Should have at_risk_trips field');

  console.log('✅ Admin metrics test passed');
}

async function runTests(): Promise<void> {
  console.log('🚀 Starting comprehensive PostgreSQL tests...\n');

  try {
    // Initialize database connection
    await initializeDb();

    // Clear and seed database
    await clearDatabase();
    await seed();

    // Run all tests
    await testDatabaseConnection();
    await testSeedData();
    await testTripAPI();
    await testBookingCreation();
    await testOverbookingPrevention();
    await testPaymentConfirmation();
    await testCronJobExpiry();
    await testRaceConditionPrevention();
    await testAdminMetrics();

    console.log('\n🎉 All tests passed! PostgreSQL migration successful.');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    throw error;
  } finally {
    db.close();
  }
}

// Run tests if called directly
if (require.main === module) {
  runTests().catch((err) => {
    console.error('Test suite failed:', err.message);
    process.exit(1);
  });
}

export { runTests };
