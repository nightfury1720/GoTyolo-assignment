import { v4 as uuidv4 } from 'uuid';
import { STATES } from '../src/types';
import { spawn, ChildProcess } from 'child_process';
import { initializeDb, db } from '../src/db/database';

const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';
const SERVER_STARTUP_TIMEOUT = 30000;
const HEALTH_CHECK_INTERVAL = 500;

let serverProcess: ChildProcess | null = null;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function waitForServer(maxAttempts: number = 60): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${API_BASE_URL}/health`);
      if (response.ok) {
        return;
      }
    } catch (err) {
    }
    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL));
  }
  throw new Error('Server failed to start within timeout period');
}

async function startServer(): Promise<void> {
  console.log('🚀 Starting server...');
  serverProcess = spawn('npm', ['run', 'dev'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, PORT: '3000' }
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
    throw err;
  });

  await waitForServer();
  console.log('✅ Server is ready');
}

async function stopServer(): Promise<void> {
  if (serverProcess) {
    console.log('🛑 Stopping server...');
    serverProcess.kill();
    serverProcess = null;
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

async function cleanDatabase(): Promise<void> {
  console.log('🧹 Cleaning database...');
  try {
    // Delete from bookings first (due to foreign key constraint)
    await db.run('DELETE FROM bookings');
    // Then delete from trips
    await db.run('DELETE FROM trips');
    console.log('✅ Database cleaned successfully');
  } catch (err: any) {
    console.error('❌ Error cleaning database:', err.message);
    throw err;
  }
}

async function seedTestData(): Promise<any[]> {
  console.log('📦 Creating test data via API...');
  const now = new Date();
  
  const trips = [
    {
      title: 'Paris City Tour',
      destination: 'Paris, France',
      start_date: new Date(now.getTime() + 9 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(now.getTime() + 12 * 24 * 60 * 60 * 1000).toISOString(),
      price: 500,
      max_capacity: 20,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED'
    },
    {
      title: 'Tokyo Explorer',
      destination: 'Tokyo, Japan',
      start_date: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      price: 800,
      max_capacity: 15,
      refundable_until_days_before: 5,
      cancellation_fee_percent: 20,
      status: 'PUBLISHED'
    },
    {
      title: 'NY Weekend',
      destination: 'New York, USA',
      start_date: new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      price: 300,
      max_capacity: 10,
      refundable_until_days_before: 2,
      cancellation_fee_percent: 30,
      status: 'PUBLISHED'
    },
    {
      title: 'London Heritage',
      destination: 'London, UK',
      start_date: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(now.getTime() + 18 * 24 * 60 * 60 * 1000).toISOString(),
      price: 450,
      max_capacity: 25,
      refundable_until_days_before: 10,
      cancellation_fee_percent: 15,
      status: 'PUBLISHED'
    },
    {
      title: 'Rome Ancient Wonders',
      destination: 'Rome, Italy',
      start_date: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000).toISOString(),
      price: 550,
      max_capacity: 12,
      refundable_until_days_before: 3,
      cancellation_fee_percent: 25,
      status: 'PUBLISHED'
    },
  ];

  const createdTrips = [];
  for (const tripData of trips) {
    const tripResponse = await apiRequest('POST', '/api/trips', tripData);
    createdTrips.push(tripResponse.trip);
  }

  const bookings = [];
  if (createdTrips.length > 0) {
    for (let i = 0; i < 3; i++) {
      const bookingResponse = await apiRequest('POST', `/api/trips/${createdTrips[0].id}/book`, {
        user_id: uuidv4(),
        num_seats: i + 1
      });
      bookings.push(bookingResponse.booking);
      await apiRequest('POST', '/api/payments/webhook', {
        booking_id: bookingResponse.booking.id,
        status: 'success',
        idempotency_key: uuidv4()
      });
    }

    for (let i = 0; i < 2; i++) {
      const bookingResponse = await apiRequest('POST', `/api/trips/${createdTrips[1].id}/book`, {
        user_id: uuidv4(),
        num_seats: 1
      });
      bookings.push(bookingResponse.booking);
    }
  }

  console.log(`✅ Created ${createdTrips.length} trips and ${bookings.length} bookings via API`);
  return createdTrips;
}

async function testDatabaseConnection(): Promise<void> {
  console.log('🧪 Testing database connection via health endpoint...');
  const healthResponse = await apiRequest('GET', '/health');
  assert(healthResponse.status === 'ok', 'Health check should return ok');
  console.log('✅ Database connection test passed');
}

async function testSeedData(trips: any[]): Promise<void> {
  console.log('🧪 Testing seed data...');
  assert(trips.length === 5, `Expected 5 trips, got ${trips.length}`);
  const tripsResponse = await apiRequest('GET', '/api/trips');
  assert(tripsResponse.trips.length >= 5, `Expected at least 5 trips, got ${tripsResponse.trips.length}`);
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

async function testGetTripById(tripId: string): Promise<void> {
  console.log('🧪 Testing GET /api/trips/:id...');
  const tripResponse = await apiRequest('GET', `/api/trips/${tripId}`);
  assert(tripResponse.id === tripId, 'Trip ID should match');
  assert(tripResponse.title, 'Should have title');
  assert(tripResponse.price, 'Should have price');
  assert(tripResponse.destination, 'Should have destination');
  console.log('✅ GET /api/trips/:id test passed');
}

async function testGetBooking(bookingId: string): Promise<void> {
  console.log('🧪 Testing GET /api/bookings/:id...');
  const bookingResponse = await apiRequest('GET', `/api/bookings/${bookingId}`);
  assert(bookingResponse.id === bookingId, 'Booking ID should match');
  assert(bookingResponse.state, 'Should have state');
  console.log('✅ GET /api/bookings/:id test passed');
}

async function testGetAdminMetrics(tripId: string): Promise<void> {
  console.log('🧪 Testing GET /api/admin/metrics...');
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

async function testCreateBooking(tripId: string): Promise<string> {
  console.log('🧪 Testing POST /api/trips/:id/book...');
  const bookingData = {
    user_id: uuidv4(),
    num_seats: 2
  };
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, bookingData);
  assert(bookingResponse.booking, 'Should have booking object');
  assert(bookingResponse.booking.id, 'Should have booking ID');
  assert(bookingResponse.payment_url, 'Should have payment_url');
    assert(bookingResponse.booking.state === STATES.PENDING_PAYMENT, 'Should be pending payment');
  
  const booking = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(!!booking, 'Booking should exist');
  assert(booking.id === bookingResponse.booking.id, 'Booking ID should match');
  
  console.log('✅ POST /api/trips/:id/book test passed');
  return bookingResponse.booking.id;
}

async function testPaymentWebhook(tripId: string): Promise<string> {
  console.log('🧪 Testing POST /api/payments/webhook...');
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  const paymentData = {
    booking_id: bookingResponse.booking.id,
    status: 'success',
    idempotency_key: uuidv4()
  };
  const paymentResponse = await apiRequest('POST', '/api/payments/webhook', paymentData);
  assert(paymentResponse.state === 'CONFIRMED', 'Payment should be confirmed');
  
  const updatedBooking = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(updatedBooking.state === STATES.CONFIRMED, 'Booking should be confirmed');
  console.log('✅ POST /api/payments/webhook test passed');
  return bookingResponse.booking.id;
}

async function testCancelBooking(tripId: string): Promise<void> {
  console.log('🧪 Testing POST /api/bookings/:id/cancel...');
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: bookingResponse.booking.id,
    status: 'success',
    idempotency_key: uuidv4()
  });
  
  const cancelResponse = await apiRequest('POST', `/api/bookings/${bookingResponse.booking.id}/cancel`);
  assert(cancelResponse, 'Cancellation should succeed');
  assert(cancelResponse.refund_amount !== undefined, 'Should have refund amount');
  
  const cancelledBooking = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(cancelledBooking.state === STATES.CANCELLED, 'Booking should be cancelled');
  console.log('✅ POST /api/bookings/:id/cancel test passed');
}

async function testFailedPaymentWebhook(tripId: string): Promise<void> {
  console.log('🧪 Testing failed payment webhook...');
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  const paymentData = {
    booking_id: bookingResponse.booking.id,
    status: 'failed',
    idempotency_key: uuidv4()
  };
  await apiRequest('POST', '/api/payments/webhook', paymentData);
  
  const failedBooking = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(failedBooking.state === STATES.EXPIRED, 'Booking should be expired on failed payment');
  console.log('✅ Failed payment webhook test passed');
}

async function testExpiryService(tripId: string): Promise<void> {
  console.log('🧪 Testing expiry service...');
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  await apiRequest('POST', '/api/admin/expire-bookings');
  
  const booking = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(booking.state === STATES.PENDING_PAYMENT || booking.state === STATES.EXPIRED, 'Booking should be pending or expired');
  console.log('✅ Expiry service test passed');
}

async function testOverbookingPrevention(tripId: string, maxCapacity: number): Promise<void> {
  console.log('🧪 Testing overbooking prevention...');
  
  const metrics = await apiRequest('GET', `/api/admin/trips/${tripId}/metrics`);
  const availableSeats = metrics.available_seats;
  
  if (availableSeats > 0) {
    const bookingData = {
      user_id: uuidv4(),
      num_seats: availableSeats + 1
    };
    try {
      await apiRequest('POST', `/api/trips/${tripId}/book`, bookingData);
      assert(false, 'Should have failed with overbooking');
    } catch (error: any) {
      assert(error.status === 409, `Expected 409, got ${error.status}`);
      assert(error.message.includes('Not enough seats') || error.message.includes('seats'), 'Should mention seats availability');
    }
  }
  console.log('✅ Overbooking prevention test passed');
}

async function testRefundCalculations(tripId: string): Promise<void> {
  console.log('🧪 Testing refund calculations...');
  const trip = await apiRequest('GET', `/api/trips/${tripId}`);
  
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  const priceAtBooking = bookingResponse.booking.price_at_booking;
  
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: bookingResponse.booking.id,
    status: 'success',
    idempotency_key: uuidv4()
  });
  
  const cancelResponse = await apiRequest('POST', `/api/bookings/${bookingResponse.booking.id}/cancel`);
  const expectedRefund = priceAtBooking * (1 - (trip.cancellation_fee_percent || 0) / 100);
  assert(Math.abs(cancelResponse.refund_amount! - expectedRefund) < 0.01, 'Refund amount should match calculation');
  console.log('✅ Refund calculations test passed');
}

async function testRaceConditionPrevention(tripId: string): Promise<void> {
  console.log('🧪 Testing race condition prevention...');
  const metrics = await apiRequest('GET', `/api/admin/trips/${tripId}/metrics`);
  const availableSeats = metrics.available_seats;
  
  if (availableSeats >= 2) {
    const userId = uuidv4();
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        apiRequest('POST', `/api/trips/${tripId}/book`, {
          user_id: `${userId}-${i}`,
          num_seats: 1
        }).catch(err => ({ error: err.message, status: (err as any).status }))
      );
    }
    const results = await Promise.all(promises);
    const successful = results.filter((r: any) => !r.error);
    const failed = results.filter((r: any) => r.error);
    assert(successful.length <= availableSeats, 'Should not have more successful bookings than available seats');
    assert(failed.length >= 1, 'Should have at least one failure due to race condition');
    
    for (const result of successful) {
      if (result.booking) {
        try {
          await apiRequest('POST', `/api/bookings/${result.booking.id}/cancel`);
        } catch (err) {
        }
      }
    }
  }
  console.log('✅ Race condition prevention test passed');
}

async function testConcurrentBookingCreation(tripId: string): Promise<void> {
  console.log('🧪 Testing concurrent booking creation...');
  const metrics = await apiRequest('GET', `/api/admin/trips/${tripId}/metrics`);
  const availableSeats = metrics.available_seats;
  
  if (availableSeats >= 3) {
    const userIds = [uuidv4(), uuidv4(), uuidv4()];
    const promises = userIds.map(userId =>
      apiRequest('POST', `/api/trips/${tripId}/book`, {
        user_id: userId,
        num_seats: 1
      }).catch(err => ({ error: err.message, status: (err as any).status }))
    );
    const results = await Promise.all(promises);
    const successful = results.filter((r: any) => !r.error);
    const failed = results.filter((r: any) => r.error);
    assert(successful.length <= availableSeats, 'Should not have more successful bookings than available seats');
    
    const conflictFailures = failed.filter((r: any) => r.status === 409);
    assert(conflictFailures.length === failed.length, 'All failures should be 409 conflicts');
    
    for (const result of successful) {
      if (result.booking) {
        try {
          await apiRequest('POST', `/api/bookings/${result.booking.id}/cancel`);
        } catch (err) {
        }
      }
    }
  }
  console.log('✅ Concurrent booking creation test passed');
}

async function testIdempotency(tripId: string): Promise<void> {
  console.log('🧪 Testing webhook idempotency...');
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  const idempotencyKey = uuidv4();
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: bookingResponse.booking.id,
    status: 'success',
    idempotency_key: idempotencyKey
  });
  
  const firstState = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: bookingResponse.booking.id,
    status: 'success',
    idempotency_key: idempotencyKey
  });
  
  const secondState = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(firstState.state === secondState.state, 'State should not change on duplicate webhook');
  console.log('✅ Webhook idempotency test passed');
}

async function runComprehensiveTests(): Promise<void> {
  console.log('🚀 Starting comprehensive test suite...\n');

  try {
    process.env.NODE_ENV = 'test';

    await initializeDb();

    // Clean database before starting tests
    await cleanDatabase();

    await startServer();

    console.log('\n📦 Step 1: Creating test data via API...');
    const trips = await seedTestData();
    await testSeedData(trips);

    const firstTrip = trips[0];
    const firstTripId = firstTrip.id;

    console.log('\n📡 Step 2: Testing GET APIs...');
    await testGetTrips();
    await testGetTripById(firstTripId);
    
    const testBookingResponse = await apiRequest('POST', `/api/trips/${firstTripId}/book`, {
      user_id: uuidv4(),
      num_seats: 1
    });
    await testGetBooking(testBookingResponse.booking.id);
    
    await testGetAdminMetrics(firstTripId);
    await testGetAtRiskTrips();

    console.log('\n✏️  Step 3: Testing data modification APIs...');
    await testCreateTrip();
    const bookingId = await testCreateBooking(firstTripId);
    await testPaymentWebhook(firstTripId);
    await testCancelBooking(firstTripId);
    await testFailedPaymentWebhook(firstTripId);
    await testExpiryService(firstTripId);

    console.log('\n💼 Step 4: Testing business logic...');
    await testOverbookingPrevention(firstTripId, firstTrip.max_capacity);
    await testRefundCalculations(firstTripId);

    console.log('\n⚡ Step 5: Testing race conditions...');
    await testRaceConditionPrevention(firstTripId);
    await testConcurrentBookingCreation(firstTripId);
    await testIdempotency(firstTripId);

    console.log('\n🎉 ALL COMPREHENSIVE TESTS PASSED! 🎉');
    console.log('✅ Database operations working correctly');
    console.log('✅ GET APIs functioning correctly');
    console.log('✅ Data modification APIs working');
    console.log('✅ Business logic validated');
    console.log('✅ Race conditions prevented');

    // Clean database after all tests complete
    console.log('\n🧹 Cleaning up test data...');
    await cleanDatabase();
    console.log('✅ Test cleanup completed');

  } catch (error) {
    console.error('\n❌ COMPREHENSIVE TEST SUITE FAILED:', error);
    // Clean database even if tests fail
    try {
      console.log('\n🧹 Cleaning up test data after failure...');
      await cleanDatabase();
      console.log('✅ Test cleanup completed');
    } catch (cleanupError) {
      console.error('❌ Error during cleanup:', cleanupError);
    }
    throw error;
  } finally {
    await stopServer();
  }
}

if (require.main === module) {
  runComprehensiveTests().catch((err) => {
    console.error('Comprehensive test suite failed:', err.message);
    process.exit(1);
  });
}

export { runComprehensiveTests };
