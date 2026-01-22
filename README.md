# GoTyolo - Booking System with Refunds

A Node.js/TypeScript backend API for a travel booking platform that handles concurrent bookings, payment webhooks, and refund management.

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js
- **Database**: PostgreSQL
- **Framework**: Express.js
- **Containerization**: Docker + Docker Compose

## Architecture Overview

This system implements a two-phase booking process to handle concurrency safely:

1. **Phase 1**: Create a reservation (holds seats temporarily) and booking in PENDING_PAYMENT state
2. **Phase 2**: Convert reservation to confirmed booking upon successful payment

The key insight is using a `reservations` table as a seat buffer, where available seats are calculated dynamically by summing active reservations rather than relying on a denormalized counter.

## Concurrency Control Approach

### Database Concurrency Control

**We use PostgreSQL transactions with optimistic concurrency control.** The system avoids explicit row-level locking (`SELECT FOR UPDATE`) in favor of a reservation-based approach that naturally serializes concurrent requests through database transactions.

- **No explicit locks**: Instead of locking trip rows, we use transactions to ensure atomic seat availability checks and reservation creation
- **Serializable isolation**: PostgreSQL's default transaction isolation prevents dirty reads and ensures consistency
- **Reservation buffer**: The `reservations` table acts as a temporary seat hold, preventing overbooking through transaction serialization

### Preventing Overbooking

**How it works:**

1. When a booking request arrives, we calculate available seats dynamically:
   ```sql
   SELECT COALESCE(SUM(num_seats), 0) as total_seats
   FROM reservations
   WHERE trip_id = ? AND expires_at > NOW()
   ```

2. Available seats = `max_capacity - reserved_seats`

3. If seats are available, we create both:
   - A reservation record (holds the seats temporarily)
   - A booking record in PENDING_PAYMENT state

4. The transaction ensures that concurrent requests are serialized - only one can succeed when competing for the last seat.

**Why this prevents overbooking:**
- Single source of truth: Available seats calculated from reservations table, not a denormalized counter
- Transaction isolation: Concurrent requests can't see each other's uncommitted reservations
- Automatic cleanup: Expired reservations are cleaned up before availability checks

### Handling Duplicate Webhooks

**Idempotency through unique keys:**

1. Each webhook includes an `idempotency_key` parameter
2. The key is stored in the `bookings.idempotency_key` column (unique constraint)
3. On webhook receipt:
   - Check if `idempotency_key` already exists for a different booking → return duplicate error
   - Check if webhook was already processed for this booking → return current state
   - Otherwise process the webhook and store the key

**Benefits:**
- **Safe retries**: Payment providers can safely retry failed webhooks
- **No double processing**: Same webhook won't create duplicate state changes
- **Audit trail**: Can track which webhooks were processed when

### Auto-Expiration of Bookings

**Background cleanup process:**

When payment webhooks never arrive, bookings remain in PENDING_PAYMENT state indefinitely. The system uses a background job to automatically expire stale bookings:

1. **Expiry Service**: `expirePendingBookings()` runs periodically (via cron job)
2. **Expiration Logic**:
   - Find bookings where `state = PENDING_PAYMENT` and `expires_at < NOW()`
   - Find orphaned reservations where `expires_at < NOW()` and `booking_id IS NULL`
3. **Cleanup Actions**:
   - Update booking state to `EXPIRED`
   - Delete associated reservations to release seats back to availability
4. **Timing**: Bookings expire 15 minutes after creation

**Why 15 minutes?**
- Gives users enough time to complete payment
- Prevents seats from being held indefinitely
- Balances user experience with seat availability

### Refund Calculation

**Formula: `price_at_booking × (1 - cancellation_fee_percent/100)`**

**Business Rules:**

1. **Before Refund Cutoff** (trip starts > `refundable_until_days_before` days from now):
   - **Pending Payments**: Apply cancellation fee and refund remaining amount
   - **Confirmed Bookings**: Apply cancellation fee and refund remaining amount
   - **Seats**: Release seats back to availability (trip is far enough away)

2. **After Refund Cutoff** (trip starts ≤ `refundable_until_days_before` days from now):
   - **Pending Payments**: No refund (can't cancel confirmed payments after cutoff)
   - **Confirmed Bookings**: No refund ($0)
   - **Seats**: Keep seats reserved (trip is imminent, can't resell)

**Example:**
- Booking: $100, Cancellation fee: 10%
- Before cutoff: Refund = $100 × (1 - 0.10) = $90
- After cutoff: Refund = $0

### Testing for Race Conditions

**Concurrent booking test strategy:**

1. **Setup**: Create a trip with limited seats (e.g., 2 seats available)
2. **Concurrent Requests**: Launch 3+ simultaneous booking requests for 1 seat each
3. **Verification**:
   - Exactly 2 bookings should succeed
   - 1+ bookings should fail with `409 Conflict - Not enough seats available`
   - Database should remain consistent (no overbooking)

**Test Implementation:**
```typescript
// Create multiple concurrent requests
const promises = [];
for (let i = 0; i < 3; i++) {
  promises.push(createReservation(tripId, userId, 1));
}
const results = await Promise.all(promises);

// Verify results
const successful = results.filter(r => !r.error);
const failed = results.filter(r => r.error);
assert(successful.length <= availableSeats);
assert(failed.length >= 1);
```

**Why this works:**
- Tests real concurrency scenarios
- Verifies transaction isolation prevents overbooking
- Ensures error handling works correctly

## Setup Instructions

1. **Clone and install dependencies:**
   ```bash
   git clone <repository-url>
   cd gotyolo-assignment
   npm install
   ```

2. **Start PostgreSQL:**
   ```bash
   docker-compose up postgres -d
   ```

3. **Run database migrations:**
   ```bash
   npm run build
   node dist/scripts/seed.js
   ```

4. **Start the application:**
   ```bash
   npm run dev
   # or
   docker-compose up
   ```

5. **Run tests:**
   ```bash
   npm test
   ```

## API Endpoints

### Trips
- `GET /api/trips` - List published trips
- `GET /api/trips/:id` - Get trip details
- `POST /api/trips` - Create trip (admin)
- `PUT /api/trips/:id` - Update trip (admin)

### Bookings
- `POST /api/trips/:id/book` - Create booking
- `GET /api/bookings/:id` - Get booking details
- `POST /api/bookings/:id/cancel` - Cancel booking
- `GET /api/bookings` - List user bookings

### Payments
- `POST /api/payments/webhook` - Handle payment webhook

### Admin
- `GET /api/admin/trips/:id/metrics` - Trip metrics
- `GET /api/admin/trips/at-risk` - At-risk trips

## Database Schema

**Key Tables:**
- `trips`: Trip information and capacity
- `bookings`: Booking records with state machine
- `reservations`: Temporary seat holds for concurrency control

**Indexes:**
- `idx_bookings_trip_id`, `idx_bookings_state`, `idx_bookings_expires_at`
- `idx_reservations_trip_id`, `idx_reservations_expires_at`
- `idx_trips_status`

## State Machine

```
PENDING_PAYMENT → CONFIRMED (payment success)
    ↓
EXPIRED (payment failed or timeout)

CONFIRMED → CANCELLED (user cancellation)
EXPIRED → (terminal)
CANCELLED → (terminal)
```

## Bugs Found and Fixes

During development, several concurrency-related bugs were identified and fixed:

1. **Race Condition Overbooking**: Fixed by implementing reservation-based seat tracking
2. **Missing Seat Release**: Added reservation cleanup in expiry service
3. **Duplicate Webhook Processing**: Implemented idempotency key checking
4. **Inconsistent Refund Calculation**: Fixed formula to properly apply cancellation fees

## Performance Considerations

- **Connection Pooling**: PostgreSQL connection pool with 20 max connections
- **Transaction Scoping**: Keep transactions as short as possible
- **Background Cleanup**: Periodic job removes expired reservations
- **Optimistic Concurrency**: Avoids locks while maintaining consistency

## Monitoring and Debugging

- **Comprehensive Logging**: All state transitions and business logic logged
- **Transaction Tracing**: Database operations wrapped in transactions for consistency
- **Error Handling**: Detailed error responses with appropriate HTTP status codes
- **Audit Trail**: Full history of bookings, payments, and cancellations