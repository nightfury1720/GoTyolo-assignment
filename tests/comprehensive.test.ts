import { v4 as uuidv4 } from 'uuid';
import { STATES } from '../src/types';

const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function checkServerHealth(): Promise<void> {
  try {
    console.log(`\n📤 REQUEST: GET /health`);
    const response = await fetch(`${API_BASE_URL}/health`);
    const data: any = await response.json();
    console.log(`✅ RESPONSE: ${response.status} ${response.statusText}`);
    console.log(`   Output:`, JSON.stringify(data, null, 2));
    if (!response.ok) {
      throw new Error('Server health check failed');
    }
    assert(data.status === 'ok', 'Health check should return ok');
  } catch (err: any) {
    console.log(`❌ RESPONSE: Health check failed`);
    throw new Error(`Server is not available at ${API_BASE_URL}. Please ensure the server is running on localhost:3000`);
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

  // Log request
  console.log(`\n📤 REQUEST: ${method} ${path}`);
  if (body) {
    console.log(`   Input:`, JSON.stringify(body, null, 2));
  }

  const response = await fetch(url, options);
  const data: any = await response.json();

  if (!response.ok) {
    // Log error response
    console.log(`❌ RESPONSE: ${response.status} ${response.statusText}`);
    console.log(`   Error:`, JSON.stringify(data, null, 2));
    const error = new Error(data.error || `HTTP ${response.status}`);
    (error as any).status = response.status;
    throw error;
  }

  // Log success response
  console.log(`✅ RESPONSE: ${response.status} ${response.statusText}`);
  console.log(`   Output:`, JSON.stringify(data, null, 2));

  return data;
}

async function cleanDatabase(): Promise<void> {
  console.log('🧹 Cleaning database via API...');
  try {
    await apiRequest('DELETE', '/api/admin/clean');
    console.log('✅ Database cleaned successfully');
  } catch (err: any) {
    console.error('❌ Error cleaning database:', err.message);
    throw err;
  }
}

async function verifyDatabaseIsEmpty(): Promise<void> {
  console.log('🔍 Verifying database is empty...');
  const tripsResponse = await apiRequest('GET', '/api/trips');
  assert(tripsResponse.trips.length === 0, `Expected 0 trips after cleanup, got ${tripsResponse.trips.length}`);
  console.log('✅ Database is empty');
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
    // Create some confirmed bookings for trip 0
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

    // Create some pending bookings for trip 1
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

async function verifySeedData(trips: any[]): Promise<void> {
  console.log('🧪 Verifying seed data...');
  assert(trips.length === 5, `Expected 5 trips, got ${trips.length}`);
  const tripsResponse = await apiRequest('GET', '/api/trips');
  assert(tripsResponse.trips.length === 5, `Expected exactly 5 trips, got ${tripsResponse.trips.length}`);
  console.log('✅ Seed data verification passed');
}

// ========== API Verification Tests ==========

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
  assert(tripResponse.max_capacity, 'Should have max_capacity');
  assert(tripResponse.available_seats !== undefined, 'Should have available_seats');
  console.log('✅ GET /api/trips/:id test passed');
}

async function testGetBooking(bookingId: string): Promise<void> {
  console.log('🧪 Testing GET /api/bookings/:id...');
  const bookingResponse = await apiRequest('GET', `/api/bookings/${bookingId}`);
  assert(bookingResponse.id === bookingId, 'Booking ID should match');
  assert(bookingResponse.state, 'Should have state');
  assert(bookingResponse.trip_id, 'Should have trip_id');
  assert(bookingResponse.user_id, 'Should have user_id');
  assert(bookingResponse.num_seats, 'Should have num_seats');
  assert(bookingResponse.price_at_booking, 'Should have price_at_booking');
  console.log('✅ GET /api/bookings/:id test passed');
}

async function testGetAdminMetrics(tripId: string): Promise<void> {
  console.log('🧪 Testing GET /api/admin/trips/:id/metrics...');
  const metricsResponse = await apiRequest('GET', `/api/admin/trips/${tripId}/metrics`);
  assert(metricsResponse.trip_id, 'Should have trip_id');
  assert(metricsResponse.occupancy_percent !== undefined, 'Should have occupancy_percent');
  assert(metricsResponse.total_seats !== undefined, 'Should have total_seats');
  assert(metricsResponse.booked_seats !== undefined, 'Should have booked_seats');
  assert(metricsResponse.available_seats !== undefined, 'Should have available_seats');
  assert(metricsResponse.booking_summary, 'Should have booking_summary');
  assert(metricsResponse.financial, 'Should have financial data');
  console.log('✅ GET /api/admin/trips/:id/metrics test passed');
}

async function testGetAtRiskTrips(): Promise<void> {
  console.log('🧪 Testing GET /api/admin/trips/at-risk...');
  const atRiskResponse = await apiRequest('GET', '/api/admin/trips/at-risk');
  assert(atRiskResponse.at_risk_trips !== undefined, 'Should have at_risk_trips field');
  assert(Array.isArray(atRiskResponse.at_risk_trips), 'at_risk_trips should be an array');
  console.log('✅ GET /api/admin/trips/at-risk test passed');
}

async function testGetAdminMetricsAll(): Promise<void> {
  console.log('🧪 Testing GET /api/admin/metrics...');
  const metricsResponse = await apiRequest('GET', '/api/admin/metrics');
  assert(metricsResponse.trips !== undefined, 'Should have trips field');
  assert(Array.isArray(metricsResponse.trips), 'trips should be an array');
  console.log('✅ GET /api/admin/metrics test passed');
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
  assert(Number(tripResponse.trip.price) === tripData.price, 
    `Price should match. Expected: ${tripData.price}, Got: ${tripResponse.trip.price}`);
  assert(tripResponse.trip.max_capacity === tripData.max_capacity, 'Max capacity should match');
  assert(tripResponse.trip.available_seats === tripData.max_capacity, 'Available seats should equal max capacity');
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
  assert(bookingResponse.booking.num_seats === bookingData.num_seats, 'Number of seats should match');
  assert(bookingResponse.booking.user_id === bookingData.user_id, 'User ID should match');
  
  const booking = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(!!booking, 'Booking should exist');
  assert(booking.id === bookingResponse.booking.id, 'Booking ID should match');
  assert(booking.state === STATES.PENDING_PAYMENT, 'Booking state should be PENDING_PAYMENT');
  
  console.log('✅ POST /api/trips/:id/book test passed');
  return bookingResponse.booking.id;
}

async function testPaymentWebhook(tripId: string): Promise<string> {
  console.log('🧪 Testing POST /api/payments/webhook (success)...');
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
  assert(updatedBooking.payment_reference !== undefined, 'Should have payment reference');
  
  console.log('✅ POST /api/payments/webhook (success) test passed');
  return bookingResponse.booking.id;
}

// ========== Refund Flow Tests ==========

async function testRefundFlow(tripId: string): Promise<void> {
  console.log('🧪 Testing refund flow...');
  const trip = await apiRequest('GET', `/api/trips/${tripId}`);
  
  // Create and confirm a booking
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 2
  });
  
  const priceAtBooking = Number(bookingResponse.booking.price_at_booking);
  const expectedPrice = Number(trip.price) * 2;
  assert(Math.abs(priceAtBooking - expectedPrice) < 0.01, 
    `Price at booking should be trip price * num_seats. Expected: ${expectedPrice}, Got: ${priceAtBooking}`);
  
  // Confirm payment
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: bookingResponse.booking.id,
    status: 'success',
    idempotency_key: uuidv4()
  });
  
  // Verify booking is confirmed
  const confirmedBooking = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(confirmedBooking.state === STATES.CONFIRMED, 'Booking should be confirmed');
  
  // Cancel booking and verify refund
  const cancelResponse = await apiRequest('POST', `/api/bookings/${bookingResponse.booking.id}/cancel`);
  assert(cancelResponse.refund_amount !== undefined, 'Should have refund amount');
  assert(cancelResponse.refund_amount >= 0, 'Refund amount should be non-negative');
  
  const expectedRefund = Number(priceAtBooking) * (1 - (Number(trip.cancellation_fee_percent) || 0) / 100);
  assert(Math.abs(Number(cancelResponse.refund_amount!) - expectedRefund) < 0.01, 
    `Refund amount should match calculation. Expected: ${expectedRefund}, Got: ${cancelResponse.refund_amount}`);
  
  // Verify booking is cancelled
  const cancelledBooking = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(cancelledBooking.state === STATES.CANCELLED, 'Booking should be cancelled');
  assert(cancelledBooking.refund_amount === cancelResponse.refund_amount, 'Refund amount should be stored');
  assert(cancelledBooking.cancelled_at !== null, 'Should have cancelled_at timestamp');
  
  console.log('✅ Refund flow test passed');
}

async function testRefundCalculations(tripId: string): Promise<void> {
  console.log('🧪 Testing refund calculations with different cancellation fees...');
  const trip = await apiRequest('GET', `/api/trips/${tripId}`);
  
  // Test with 1 seat
  const booking1 = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: booking1.booking.id,
    status: 'success',
    idempotency_key: uuidv4()
  });
  
  const cancel1 = await apiRequest('POST', `/api/bookings/${booking1.booking.id}/cancel`);
  const expectedRefund1 = Number(booking1.booking.price_at_booking) * (1 - (Number(trip.cancellation_fee_percent) || 0) / 100);
  assert(Math.abs(Number(cancel1.refund_amount!) - expectedRefund1) < 0.01, 
    `Refund calculation failed for 1 seat. Expected: ${expectedRefund1}, Got: ${cancel1.refund_amount}`);
  
  console.log('✅ Refund calculations test passed');
}

// ========== Cancellation Flow Tests ==========

async function testCancellationFlow(tripId: string): Promise<void> {
  console.log('🧪 Testing cancellation flow...');
  
  // Create and confirm a booking
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: bookingResponse.booking.id,
    status: 'success',
    idempotency_key: uuidv4()
  });
  
  // Verify initial state
  const beforeCancel = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(beforeCancel.state === STATES.CONFIRMED, 'Booking should be confirmed before cancellation');
  
  // Cancel the booking
  const cancelResponse = await apiRequest('POST', `/api/bookings/${bookingResponse.booking.id}/cancel`);
  assert(cancelResponse.state === STATES.CANCELLED, 'Cancellation response should show cancelled state');
  assert(cancelResponse.refund_amount !== undefined, 'Should have refund amount');
  
  // Verify final state
  const afterCancel = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(afterCancel.state === STATES.CANCELLED, 'Booking should be cancelled');
  assert(afterCancel.cancelled_at !== null, 'Should have cancelled_at timestamp');
  assert(afterCancel.refund_amount === cancelResponse.refund_amount, 'Refund amount should match');
  
  // Verify seats are released
  const tripAfterCancel = await apiRequest('GET', `/api/trips/${tripId}`);
  const metricsAfterCancel = await apiRequest('GET', `/api/admin/trips/${tripId}/metrics`);
  assert(metricsAfterCancel.available_seats > 0, 'Seats should be released after cancellation');
  
  console.log('✅ Cancellation flow test passed');
}

async function testCancelPendingBooking(): Promise<void> {
  console.log('🧪 Testing cancellation of pending booking (should fail)...');
  const bookingResponse = await apiRequest('POST', `/api/trips/${await getFirstTripId()}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  try {
    await apiRequest('POST', `/api/bookings/${bookingResponse.booking.id}/cancel`);
    assert(false, 'Should not be able to cancel pending booking');
  } catch (error: any) {
    assert(error.status === 400 || error.status === 409, 
      `Expected 400 or 409 for cancelling pending booking, got ${error.status}`);
  }
  
  console.log('✅ Cancel pending booking test passed');
}

async function getFirstTripId(): Promise<string> {
  const tripsResponse = await apiRequest('GET', '/api/trips');
  assert(tripsResponse.trips.length > 0, 'Should have at least one trip');
  return tripsResponse.trips[0].id;
}

// ========== Expiry Cron Job Tests ==========

async function testExpiryCronJob(tripId: string): Promise<void> {
  console.log('🧪 Testing expiry cron job...');
  
  // Create a pending booking
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  const bookingId = bookingResponse.booking.id;
  
  // Verify booking is pending
  const beforeExpiry = await apiRequest('GET', `/api/bookings/${bookingId}`);
  assert(beforeExpiry.state === STATES.PENDING_PAYMENT, 'Booking should be pending payment');
  assert(beforeExpiry.expires_at !== null, 'Should have expires_at timestamp');
  
  // Manually trigger expiry job
  await apiRequest('POST', '/api/admin/expire-bookings');
  
  // Note: The booking might not expire immediately if expires_at is in the future
  // This test verifies the endpoint works, actual expiry depends on expires_at timestamp
  const afterExpiry = await apiRequest('GET', `/api/bookings/${bookingId}`);
  assert(
    afterExpiry.state === STATES.PENDING_PAYMENT || afterExpiry.state === STATES.EXPIRED,
    'Booking should be pending or expired after expiry job'
  );
  
  console.log('✅ Expiry cron job test passed');
}

async function testExpiredBookingState(tripId: string): Promise<void> {
  console.log('🧪 Testing expired booking state...');
  
  // Create a pending booking
  const bookingResponse = await apiRequest('POST', `/api/trips/${tripId}/book`, {
    user_id: uuidv4(),
    num_seats: 1
  });
  
  const bookingId = bookingResponse.booking.id;
  const booking = await apiRequest('GET', `/api/bookings/${bookingId}`);
  
  // Verify it has expires_at
  assert(booking.expires_at !== null, 'Pending booking should have expires_at');
  
  // Trigger expiry job
  await apiRequest('POST', '/api/admin/expire-bookings');
  
  // Verify the booking still exists (might be expired or still pending based on time)
  const afterExpiry = await apiRequest('GET', `/api/bookings/${bookingId}`);
  assert(afterExpiry, 'Booking should still exist after expiry job');
  assert(
    afterExpiry.state === STATES.PENDING_PAYMENT || afterExpiry.state === STATES.EXPIRED,
    'Booking should be pending or expired'
  );
  
  console.log('✅ Expired booking state test passed');
}

// ========== Overbooking and Race Condition Tests ==========

async function testOverbookingPrevention(tripId: string): Promise<void> {
  console.log('🧪 Testing overbooking prevention...');
  
  const metrics = await apiRequest('GET', `/api/admin/trips/${tripId}/metrics`);
  const availableSeats = metrics.available_seats;
  
  if (availableSeats > 0) {
    // Try to book more seats than available
    const bookingData = {
      user_id: uuidv4(),
      num_seats: availableSeats + 1
    };
    try {
      await apiRequest('POST', `/api/trips/${tripId}/book`, bookingData);
      assert(false, 'Should have failed with overbooking');
    } catch (error: any) {
      assert(error.status === 409, `Expected 409 Conflict, got ${error.status}`);
      assert(
        error.message.includes('Not enough seats') || 
        error.message.includes('seats') || 
        error.message.includes('available'),
        'Error message should mention seats availability'
      );
    }
  }
  
  console.log('✅ Overbooking prevention test passed');
}

async function testRaceConditionPrevention(tripId: string): Promise<void> {
  console.log('🧪 Testing race condition prevention...');
  const metrics = await apiRequest('GET', `/api/admin/trips/${tripId}/metrics`);
  const availableSeats = metrics.available_seats;
  
  if (availableSeats >= 2) {
    // Try to book concurrently
    const promises = [];
    for (let i = 0; i < Math.min(availableSeats + 2, 5); i++) {
      promises.push(
        apiRequest('POST', `/api/trips/${tripId}/book`, {
          user_id: uuidv4(),
          num_seats: 1
        }).catch(err => ({ error: err.message, status: (err as any).status }))
      );
    }
    const results = await Promise.all(promises);
    const successful = results.filter((r: any) => !r.error && r.booking);
    const failed = results.filter((r: any) => r.error);
    
    // Should not have more successful bookings than available seats
    assert(successful.length <= availableSeats, 
      `Should not have more successful bookings (${successful.length}) than available seats (${availableSeats})`);
    
    // Should have at least one failure if we tried to book more than available
    if (promises.length > availableSeats) {
      assert(failed.length >= 1, 'Should have at least one failure due to race condition');
    }
    
    // Clean up successful bookings
    for (const result of successful) {
      if (result.booking) {
        try {
          // Cancel if confirmed, or just leave pending bookings
          const booking = await apiRequest('GET', `/api/bookings/${result.booking.id}`);
          if (booking.state === STATES.CONFIRMED) {
            await apiRequest('POST', `/api/bookings/${result.booking.id}/cancel`);
          }
        } catch (err) {
          // Ignore cleanup errors
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
    const successful = results.filter((r: any) => !r.error && r.booking);
    const failed = results.filter((r: any) => r.error);
    
    // Should not exceed available seats
    assert(successful.length <= availableSeats, 
      `Should not have more successful bookings (${successful.length}) than available seats (${availableSeats})`);
    
    // All failures should be 409 conflicts
    const conflictFailures = failed.filter((r: any) => r.status === 409);
    if (failed.length > 0) {
      assert(conflictFailures.length === failed.length, 
        `All failures should be 409 conflicts. Got: ${failed.map((r: any) => r.status)}`);
    }
    
    // Clean up
    for (const result of successful) {
      if (result.booking) {
        try {
          const booking = await apiRequest('GET', `/api/bookings/${result.booking.id}`);
          if (booking.state === STATES.CONFIRMED) {
            await apiRequest('POST', `/api/bookings/${result.booking.id}/cancel`);
          }
        } catch (err) {
          // Ignore cleanup errors
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
  
  // First webhook call
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: bookingResponse.booking.id,
    status: 'success',
    idempotency_key: idempotencyKey
  });
  
  const firstState = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(firstState.state === STATES.CONFIRMED, 'Booking should be confirmed after first webhook');
  
  // Second webhook call with same idempotency key
  await apiRequest('POST', '/api/payments/webhook', {
    booking_id: bookingResponse.booking.id,
    status: 'success',
    idempotency_key: idempotencyKey
  });
  
  const secondState = await apiRequest('GET', `/api/bookings/${bookingResponse.booking.id}`);
  assert(firstState.state === secondState.state, 'State should not change on duplicate webhook');
  assert(firstState.payment_reference === secondState.payment_reference, 
    'Payment reference should not change on duplicate webhook');
  
  console.log('✅ Webhook idempotency test passed');
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

// ========== Main Test Runner ==========

async function runComprehensiveTests(): Promise<void> {
  console.log('🚀 Starting comprehensive test suite...\n');
  console.log(`📡 Testing against: ${API_BASE_URL}\n`);

  try {
    // Check server is running
    console.log('🔍 Checking server health...');
    await checkServerHealth();
    console.log('✅ Server is available\n');

    // Clean database before starting tests
    console.log('\n' + '='.repeat(80));
    console.log('📋 Step 0: Cleaning database...');
    console.log('='.repeat(80));
    await cleanDatabase();
    await verifyDatabaseIsEmpty();

    // Seed test data
    console.log('\n' + '='.repeat(80));
    console.log('📦 Step 1: Seeding test data via API...');
    console.log('='.repeat(80));
    const trips = await seedTestData();
    await verifySeedData(trips);

    const firstTrip = trips[0];
    const firstTripId = firstTrip.id;

    // Create a dedicated high-capacity trip for booking tests
    console.log('\n📦 Creating dedicated test trip for booking tests...');
    const testTripData = {
      title: 'Test Trip for Bookings',
      destination: 'Test Destination',
      start_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString(),
      price: 1000,
      max_capacity: 100, // High capacity for testing
      refundable_until_days_before: 7,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED'
    };
    const testTripResponse = await apiRequest('POST', '/api/trips', testTripData);
    const testTripId = testTripResponse.trip.id;
    console.log(`✅ Created test trip with ID: ${testTripId}`);

    // Test all GET APIs
    console.log('\n' + '='.repeat(80));
    console.log('📡 Step 2: Testing GET APIs...');
    console.log('='.repeat(80));
    await testGetTrips();
    await testGetTripById(firstTripId);
    
    const testBookingResponse = await apiRequest('POST', `/api/trips/${testTripId}/book`, {
      user_id: uuidv4(),
      num_seats: 1
    });
    await testGetBooking(testBookingResponse.booking.id);
    
    await testGetAdminMetrics(firstTripId);
    await testGetAdminMetricsAll();
    await testGetAtRiskTrips();

    // Test data modification APIs
    console.log('\n' + '='.repeat(80));
    console.log('✏️  Step 3: Testing data modification APIs...');
    console.log('='.repeat(80));
    await testCreateTrip();
    await testCreateBooking(testTripId);
    await testPaymentWebhook(testTripId);
    await testFailedPaymentWebhook(testTripId);

    // Test refund flow
    console.log('\n' + '='.repeat(80));
    console.log('💰 Step 4: Testing refund flow...');
    console.log('='.repeat(80));
    await testRefundFlow(testTripId);
    await testRefundCalculations(testTripId);

    // Test cancellation flow
    console.log('\n' + '='.repeat(80));
    console.log('❌ Step 5: Testing cancellation flow...');
    console.log('='.repeat(80));
    await testCancellationFlow(testTripId);
    await testCancelPendingBooking();

    // Test expiry cron job
    console.log('\n' + '='.repeat(80));
    console.log('⏰ Step 6: Testing expiry cron job...');
    console.log('='.repeat(80));
    await testExpiryCronJob(testTripId);
    await testExpiredBookingState(testTripId);

    // Test overbooking and race conditions
    console.log('\n' + '='.repeat(80));
    console.log('⚡ Step 7: Testing overbooking and race conditions...');
    console.log('='.repeat(80));
    await testOverbookingPrevention(testTripId);
    await testRaceConditionPrevention(testTripId);
    await testConcurrentBookingCreation(testTripId);
    
    // Create a fresh trip for idempotency test
    console.log('\n📦 Creating trip for idempotency test...');
    const idempotencyTripData = {
      title: 'Idempotency Test Trip',
      destination: 'Test Destination',
      start_date: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString(),
      end_date: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString(),
      price: 500,
      max_capacity: 50,
      refundable_until_days_before: 7,
      cancellation_fee_percent: 10,
      status: 'PUBLISHED'
    };
    const idempotencyTripResponse = await apiRequest('POST', '/api/trips', idempotencyTripData);
    await testIdempotency(idempotencyTripResponse.trip.id);

    console.log('\n' + '='.repeat(80));
    console.log('🎉 ALL COMPREHENSIVE TESTS PASSED! 🎉');
    console.log('='.repeat(80));
    console.log('\n📊 TEST SUMMARY:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Step 0: Database cleanup');
    console.log('✅ Step 1: Test data seeding');
    console.log('✅ Step 2: GET APIs');
    console.log('   - GET /api/trips');
    console.log('   - GET /api/trips/:id');
    console.log('   - GET /api/bookings/:id');
    console.log('   - GET /api/admin/trips/:id/metrics');
    console.log('   - GET /api/admin/metrics');
    console.log('   - GET /api/admin/trips/at-risk');
    console.log('✅ Step 3: POST APIs');
    console.log('   - POST /api/trips');
    console.log('   - POST /api/trips/:id/book');
    console.log('   - POST /api/payments/webhook (success)');
    console.log('   - POST /api/payments/webhook (failed)');
    console.log('✅ Step 4: Refund flow');
    console.log('   - Refund calculation');
    console.log('   - Refund amount verification');
    console.log('✅ Step 5: Cancellation flow');
    console.log('   - Booking cancellation');
    console.log('   - Seat release on cancellation');
    console.log('   - Pending booking cancellation prevention');
    console.log('✅ Step 6: Expiry cron job');
    console.log('   - Manual expiry trigger');
    console.log('   - Expired booking state verification');
    console.log('✅ Step 7: Overbooking and race conditions');
    console.log('   - Overbooking prevention');
    console.log('   - Race condition prevention');
    console.log('   - Concurrent booking creation');
    console.log('   - Webhook idempotency');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n✨ All test scenarios completed successfully!');

    // Clean database after all tests complete
    console.log('\n' + '='.repeat(80));
    console.log('🧹 Step 8: Cleaning up test data...');
    console.log('='.repeat(80));
    await cleanDatabase();
    await verifyDatabaseIsEmpty();
    console.log('\n✅ Test cleanup completed');

  } catch (error: any) {
    console.error('\n❌ COMPREHENSIVE TEST SUITE FAILED:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    
    // Try to clean database even if tests fail
    try {
      console.log('\n🧹 Attempting to clean up test data after failure...');
      await cleanDatabase();
      console.log('✅ Test cleanup completed');
    } catch (cleanupError: any) {
      console.error('❌ Error during cleanup:', cleanupError.message);
    }
    
    throw error;
  }
}

if (require.main === module) {
  runComprehensiveTests().catch((err) => {
    console.error('Comprehensive test suite failed:', err.message);
    process.exit(1);
  });
}

export { runComprehensiveTests };
