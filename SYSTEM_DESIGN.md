# GoTyolo Booking System - Technical Design Document

This document discusses the key technical decisions and implementations in the GoTyolo travel booking system, focusing on concurrency control, webhook handling, booking expiration, refund calculations, and testing strategies.

---

## 1. How Do You Prevent Overbooking?

### Problem
When multiple users attempt to book the last available seats simultaneously, there's a risk of overbooking if the seat availability check and decrement are not atomic.

### Solution
**Database-level concurrency control using `BEGIN IMMEDIATE` transactions** with atomic check-and-update operations.

### Implementation Details

The booking creation process uses SQLite's `BEGIN IMMEDIATE` transaction mode, which:
- **Acquires an exclusive lock** on the database before the transaction begins
- **Serializes concurrent transactions** - only one transaction can proceed at a time
- **Ensures atomic operations** - seat check and decrement happen atomically

**Key Code (from `src/services/bookingService.ts`):**

```typescript
return db.transaction(async () => {
  // ... trip validation ...
  
  // Atomic check and update in a single operation
  const updateResult = await db.run(
    'UPDATE trips SET available_seats = available_seats - ?, updated_at = ? 
     WHERE id = ? AND available_seats >= ?',
    [numSeats, nowIso, tripId, numSeats]
  );

  if (updateResult.changes === 0) {
    throw new HttpError(409, 'Not enough seats available');
  }
  
  // ... create booking record ...
});
```

**How It Works:**
1. The `WHERE` clause `available_seats >= ?` ensures we only update if enough seats exist
2. The `UPDATE` statement atomically decrements the seat count
3. If `changes === 0`, no rows were updated, meaning insufficient seats (returns 409 Conflict)
4. The transaction wrapper (`BEGIN IMMEDIATE` → operations → `COMMIT`/`ROLLBACK`) ensures isolation

**Why This Prevents Overbooking:**
- Concurrent requests are serialized by the database lock
- The check (`available_seats >= ?`) and update happen in a single atomic SQL statement
- If two users request the last seat simultaneously, only one `UPDATE` will succeed (the other gets 0 changes)

### Alternative Approaches to Preventing Overbooking

While `BEGIN IMMEDIATE` with atomic check-and-update works well for single-instance deployments, there are several alternative approaches that may be better suited for different scenarios. Let's explore the trade-offs:

---

#### Approach 1: Pessimistic Locking with `SELECT FOR UPDATE` (PostgreSQL/MySQL)

**How it works:**
```sql
BEGIN;
SELECT * FROM trips WHERE id = ? FOR UPDATE;  -- Lock the row
-- Check availability, then update
UPDATE trips SET available_seats = available_seats - ? WHERE id = ?;
COMMIT;
```

**Pros:**
- Explicit row-level locking - more granular than database-level locks
- Works well in PostgreSQL/MySQL (SQLite doesn't support `FOR UPDATE` effectively)
- Allows concurrent operations on different trips
- Standard SQL pattern, well-understood

**Cons:**
- Requires database engine support (SQLite limited)
- Still uses pessimistic locking (blocks concurrent readers)
- Potential for deadlocks if not careful with lock ordering
- Lock held for entire transaction duration

**Best for:** Multi-row updates, PostgreSQL/MySQL databases, scenarios where you need explicit row-level control

---

#### Approach 2: Optimistic Locking (Version Numbers/Timestamps)

**How it works:**
```typescript
// Add version column to trips table
// trips: { id, available_seats, version, ... }

const trip = await db.get('SELECT * FROM trips WHERE id = ?', [tripId]);
const currentVersion = trip.version;

if (trip.available_seats < numSeats) {
  throw new HttpError(409, 'Not enough seats');
}

const result = await db.run(
  'UPDATE trips SET available_seats = available_seats - ?, version = version + 1 
   WHERE id = ? AND version = ?',
  [numSeats, tripId, currentVersion]
);

if (result.changes === 0) {
  // Version changed - concurrent update occurred, retry
  throw new HttpError(409, 'Concurrent update detected, please retry');
}
```

**Pros:**
- No locks - better for read-heavy workloads
- Scales well - allows concurrent reads
- Detects conflicts through version mismatch
- Can implement retry logic with exponential backoff

**Cons:**
- **Retry logic required** - conflicts must be handled in application code
- Can lead to retry storms under high contention
- More complex code - need version tracking in schema
- Not truly "optimistic" if retries are frequent (becomes pessimistic)

**Best for:** High-read/low-write workloads, systems with retry infrastructure, eventual consistency acceptable

---

#### Approach 3: Application-Level Distributed Locking (Redis/Redlock)

**How it works:**
```typescript
import { Redlock } from 'redlock';

const lock = await redlock.acquire([`trip:${tripId}:lock`], 5000); // 5s TTL
try {
  const trip = await db.get('SELECT * FROM trips WHERE id = ?', [tripId]);
  if (trip.available_seats < numSeats) {
    throw new HttpError(409, 'Not enough seats');
  }
  
  await db.run('UPDATE trips SET available_seats = available_seats - ? WHERE id = ?', 
    [numSeats, tripId]);
  // Create booking...
} finally {
  await lock.release();
}
```

**Pros:**
- Works across multiple application instances (distributed systems)
- Fine-grained locking (per trip ID)
- Non-blocking - waits for lock with timeout
- Can prevent thundering herd with lock queuing

**Cons:**
- **External dependency** - requires Redis cluster
- Additional infrastructure complexity
- Lock TTL must be carefully tuned (too short = premature release, too long = blocking)
- Potential for deadlocks if lock ordering inconsistent
- Network latency overhead

**Best for:** Multi-instance deployments, microservices, distributed systems, high availability requirements

---

#### Approach 4: Event Sourcing / CQRS Pattern

**How it works:**
```typescript
// Don't store available_seats directly - derive from events
// Events: BookingCreated, BookingCancelled, BookingExpired, SeatReserved

async function bookSeats(tripId: string, numSeats: number) {
  // Read all events for this trip to compute current availability
  const events = await eventStore.getEvents(`trip:${tripId}`);
  const currentSeats = computeAvailableSeats(events);
  
  if (currentSeats < numSeats) {
    throw new HttpError(409, 'Not enough seats');
  }
  
  // Append new event atomically
  await eventStore.appendEvent(`trip:${tripId}`, {
    type: 'SeatReserved',
    seats: numSeats,
    timestamp: Date.now()
  });
}
```

**Pros:**
- Complete audit trail - every change is an event
- Time-travel queries - can reconstruct state at any point in time
- Naturally handles concurrent events through event ordering
- Scalable read models (projections)

**Cons:**
- **Major architectural change** - requires event store
- Complexity - event sourcing has learning curve
- Eventual consistency challenges
- Requires snapshots for performance
- Harder to query current state

**Best for:** Complex domains, audit requirements, systems needing temporal queries, long-term data retention

---

#### Approach 5: Queue-Based Sequential Processing

**How it works:**
```typescript
// All booking requests go through a queue
async function createBookingRequest(tripId: string, userId: string, numSeats: number) {
  const requestId = uuidv4();
  
  // Push to queue (FIFO, processed sequentially)
  await bookingQueue.push({
    requestId,
    tripId,
    userId,
    numSeats
  });
  
  // Return immediately, process asynchronously
  return { requestId, status: 'queued' };
}

// Worker processes queue sequentially
async function processBookingQueue() {
  while (true) {
    const request = await bookingQueue.pop();
    try {
      // Process booking - no concurrency concerns
      await processBooking(request);
    } catch (err) {
      // Handle error, potentially requeue
    }
  }
}
```

**Pros:**
- Eliminates race conditions - processing is sequential
- Natural backpressure handling
- Can implement priority queues
- Good for high-throughput scenarios
- Scales horizontally (multiple workers)

**Cons:**
- **Asynchronous** - user must wait or poll for result
- Additional infrastructure (message queue: RabbitMQ, SQS, etc.)
- Complexity - need job status tracking
- Latency - booking not immediate
- Requires idempotent processing (what if worker crashes mid-processing?)

**Best for:** High-volume systems, async workflows, batch processing, systems where slight delay is acceptable

---

#### Approach 6: Database CHECK Constraints + Unique Constraints

**How it works:**
```sql
-- Create booking reservations table
CREATE TABLE seat_reservations (
  id UUID PRIMARY KEY,
  trip_id UUID NOT NULL,
  seat_number INTEGER NOT NULL,
  booking_id UUID,
  expires_at TIMESTAMP,
  UNIQUE(trip_id, seat_number)  -- Prevents double-booking
);

-- Reserve specific seat numbers
INSERT INTO seat_reservations (trip_id, seat_number, booking_id, expires_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (trip_id, seat_number) DO NOTHING;
```

**Pros:**
- Database-enforced uniqueness - impossible to double-book
- Works without application-level locking
- Seat-level granularity (if needed)
- Natural handling of expired reservations

**Cons:**
- Requires schema change (separate reservations table)
- More complex queries (need to count available seats)
- Still need transaction coordination for multi-seat bookings
- Not suitable if seats are fungible (any seat is fine)

**Best for:** Assigned seating systems, theater/airplane bookings, when seat-level tracking needed

---

#### Approach 7: Two-Phase Booking (Reservation + Confirmation)

**How it works:**
```typescript
// Phase 1: Soft reservation (doesn't decrease available_seats)
async function reserveSeats(tripId: string, userId: string, numSeats: number) {
  // Check availability
  const trip = await db.get('SELECT * FROM trips WHERE id = ?', [tripId]);
  if (trip.available_seats < numSeats) {
    throw new HttpError(409, 'Not enough seats');
  }
  
  // Create soft reservation (doesn't block others, but counts in availability check)
  await db.run(`
    INSERT INTO reservations (trip_id, user_id, num_seats, expires_at)
    VALUES (?, ?, ?, ?)
  `, [tripId, userId, numSeats, Date.now() + 15*60*1000]);
}

// Phase 2: Confirmation (actually decreases available_seats)
async function confirmReservation(reservationId: string) {
  await db.transaction(async () => {
    const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [reservationId]);
    
    // Check if still valid
    const trip = await db.get('SELECT * FROM trips WHERE id = ?', [reservation.trip_id]);
    const activeReservations = await db.get(`
      SELECT SUM(num_seats) as reserved 
      FROM reservations 
      WHERE trip_id = ? AND expires_at > NOW()
    `, [reservation.trip_id]);
    
    if (trip.available_seats - activeReservations.reserved < reservation.num_seats) {
      throw new HttpError(409, 'Seats no longer available');
    }
    
    // Decrease and confirm
    await db.run('UPDATE trips SET available_seats = available_seats - ? WHERE id = ?',
      [reservation.num_seats, reservation.trip_id]);
  });
}
```

**Pros:**
- Separates availability check from commitment
- Can handle more concurrent requests initially
- Natural fit for payment flow (reserve → pay → confirm)

**Cons:**
- More complex state management
- Risk of overcommitment if not careful
- Requires reservation cleanup (expired reservations)
- Two-phase commit complexity

**Best for:** High-contention scenarios, payment flows, when you want to "hold" seats temporarily

---

### Comparison Matrix

| Approach | Complexity | Scalability | Distributed | Best For |
|----------|-----------|-------------|-------------|----------|
| **BEGIN IMMEDIATE** (Current) | Low | Single instance | No | Simple apps, SQLite |
| **SELECT FOR UPDATE** | Low | Good | No | PostgreSQL/MySQL |
| **Optimistic Locking** | Medium | Excellent | No | Read-heavy workloads |
| **Distributed Locking** | Medium | Excellent | Yes | Multi-instance, microservices |
| **Event Sourcing** | High | Excellent | Yes | Complex domains, audit needs |
| **Queue-Based** | High | Excellent | Yes | High-throughput, async |
| **CHECK Constraints** | Medium | Good | No | Assigned seating |
| **Two-Phase** | High | Good | Possible | Payment flows, high contention |

---

### Why We Chose `BEGIN IMMEDIATE` for GoTyolo

1. **Simplicity**: Single-instance deployment, straightforward implementation
2. **SQLite Compatibility**: SQLite's limitations make other approaches less suitable
3. **Strong Consistency**: Guarantees no overbooking without complex retry logic
4. **Low Latency**: Immediate booking confirmation (no queues, no retries)
5. **Correctness First**: For booking systems, preventing overbooking is critical

### When to Consider Alternatives

- **Multi-instance deployment** → Distributed locking or queue-based
- **High read-to-write ratio** → Optimistic locking
- **PostgreSQL/MySQL** → `SELECT FOR UPDATE` may be more efficient
- **Need audit trail** → Event sourcing
- **Very high contention** → Queue-based with worker pools
- **Assigned seating** → Reservation table with unique constraints

---

## 2. How Do You Handle Duplicate Webhooks?

### Problem
Payment providers may send the same webhook multiple times due to network issues, retries, or idempotency guarantees. Processing the same payment twice could lead to incorrect booking states or duplicate charges.

### Solution
**Idempotency keys** stored with UNIQUE constraint on the booking record, allowing duplicate webhooks to be safely ignored.

### Implementation Details

**Key Code (from `src/services/paymentService.ts`):**

```typescript
return db.transaction(async () => {
  // Check if idempotency_key already exists
  const existingIdem = await db.get<{ id: string }>(
    'SELECT id FROM bookings WHERE idempotency_key = ?',
    [idempotencyKey]
  );

  // If same booking, return existing state (idempotent)
  if (booking.idempotency_key === idempotencyKey) {
    logger.info('Duplicate webhook processed idempotently', { bookingId, idempotencyKey });
    return booking; // Return without re-processing
  }

  // If different booking, log warning but still return safely
  if (existingIdem && existingIdem.id !== bookingId) {
    logger.warn('Duplicate idempotency key for different booking', {...});
    return { id: bookingId, state: 'UNKNOWN', message: 'duplicate webhook' };
  }

  // First-time webhook: process payment and store idempotency_key
  await db.run(
    `UPDATE bookings SET state = ?, idempotency_key = ?, ... WHERE id = ?`,
    [nextState, idempotencyKey, ..., bookingId]
  );
});
```

**How It Works:**
1. **First webhook**: `idempotency_key` is not set → process payment → store `idempotency_key`
2. **Duplicate webhook**: `idempotency_key` matches → return current booking state without changes
3. **Webhook for wrong booking**: If `idempotency_key` exists for a different booking, log warning and return safely

**Database Schema:**
```sql
idempotency_key TEXT UNIQUE  -- Prevents duplicate processing
```

**Additional Safety:**
- Webhook endpoint **always returns 200 OK** (even for errors) to prevent payment provider retries
- Invalid webhooks (missing fields, wrong status) are logged but don't cause failures

---

## 3. What Happens If Payment Webhook Never Arrives? How Do You Auto-Expire Bookings?

### Problem
If a payment provider's webhook fails to arrive (network issues, provider downtime, etc.), bookings will remain in `PENDING_PAYMENT` state indefinitely, holding seats that should be released.

### Solution
**Time-based auto-expiration** with a scheduled cron job that runs every minute.

### Implementation Details

**Booking Creation:**
- Every booking gets an `expires_at` timestamp set to **15 minutes after creation**
- Bookings start in `PENDING_PAYMENT` state

**Expiry Service (from `src/services/expiryService.ts`):**

```typescript
export async function expirePendingBookings(): Promise<void> {
  const nowIso = new Date().toISOString();

  // Find all pending bookings past their expiration time
  const expired = await db.all<BookingRow>(
    `SELECT * FROM bookings 
     WHERE state = ? AND expires_at IS NOT NULL AND expires_at < ?`,
    [STATES.PENDING_PAYMENT, nowIso]
  );

  for (const booking of expired) {
    await db.transaction(async () => {
      // Double-check state (prevent race conditions)
      const fresh = await db.get<BookingRow>(
        'SELECT * FROM bookings WHERE id = ?', 
        [booking.id]
      );

      if (!fresh || fresh.state !== STATES.PENDING_PAYMENT) return;

      // Update booking to EXPIRED
      await db.run(
        'UPDATE bookings SET state = ?, updated_at = ? WHERE id = ?',
        [STATES.EXPIRED, nowIso, booking.id]
      );

      // Release seats back to trip
      await db.run(
        'UPDATE trips SET available_seats = available_seats + ?, updated_at = ? WHERE id = ?',
        [fresh.num_seats, nowIso, fresh.trip_id]
      );
    });
  }
}
```

**Scheduled Execution (from `src/index.ts`):**
```typescript
// Run expiry job every minute
cron.schedule('* * * * *', async () => {
  await expirePendingBookings();
});
```

**State Transition:**
```
PENDING_PAYMENT → [15 minutes pass] → EXPIRED (seats released)
```

**What Happens:**
1. User creates booking → `state = PENDING_PAYMENT`, `expires_at = now + 15 min`
2. If webhook arrives within 15 minutes → booking transitions to `CONFIRMED`
3. If webhook never arrives → cron job expires booking after 15 minutes → seats released

**Why This Works:**
- **Automatic recovery**: System doesn't depend on webhook reliability
- **Seat availability**: Expired bookings release seats, preventing inventory lockup
- **Transaction safety**: Each expiration is wrapped in a transaction to prevent partial updates

---

## 4. How Do You Calculate Refunds? Show the Formula

### Problem
When users cancel bookings, we need to calculate refund amounts based on cancellation policies (time before trip, cancellation fees).

### Solution
**Time-based refund calculation** with cancellation fee percentage deduction.

### Formula

```
refund_amount = price_at_booking × (1 - cancellation_fee_percent / 100)
```

**Special Cases:**
- **Before cutoff**: Refund calculated with formula above, seats released
- **After cutoff**: `refund_amount = 0`, seats NOT released (trip is imminent)

### Implementation Details

**Key Code (from `src/services/refundService.ts`):**

```typescript
const daysLeft = daysUntil(booking.start_date);
const refundable = daysLeft > booking.refundable_until_days_before;

const feePercent = booking.cancellation_fee_percent || 0;
const refundAmount = refundable
  ? Number((booking.price_at_booking * (1 - feePercent / 100)).toFixed(2))
  : 0;
```

**Examples:**

| Scenario | `price_at_booking` | `cancellation_fee_percent` | Days Until Trip | `refundable_until_days_before` | Refund Amount |
|----------|-------------------|---------------------------|-----------------|-------------------------------|---------------|
| Early cancellation | $100.00 | 10% | 20 days | 7 days | $90.00 |
| Late cancellation | $100.00 | 10% | 3 days | 7 days | $0.00 |
| No fee | $200.00 | 0% | 10 days | 7 days | $200.00 |
| High fee | $150.00 | 25% | 15 days | 7 days | $112.50 |

**Calculation Breakdown:**
```
Example: $100 booking, 10% fee, cancelled 20 days before trip (cutoff: 7 days)

1. daysLeft = 20
2. refundable = 20 > 7 = true
3. refundAmount = 100 × (1 - 10/100) = 100 × 0.90 = $90.00
4. Seats released back to trip
```

**Late Cancellation (After Cutoff):**
```
Example: $100 booking, cancelled 3 days before trip (cutoff: 7 days)

1. daysLeft = 3
2. refundable = 3 > 7 = false
3. refundAmount = 0
4. Seats NOT released (trip is too soon)
```

**Why This Approach:**
- **Fair pricing**: Users pay a fee for the cancellation inconvenience
- **Business logic**: Late cancellations don't get refunds (can't resell seats)
- **Inventory management**: Early cancellations release seats for resale

---

## 5. What Database Concurrency Control Do You Use?

### Problem
Concurrent database operations (multiple bookings, webhooks, cancellations) can lead to race conditions, inconsistent data, or lost updates without proper concurrency control.

### Solution
**SQLite's `BEGIN IMMEDIATE` transaction mode** with application-level transaction wrapper.

### Implementation Details

**Transaction Wrapper (from `src/db/database.ts`):**

```typescript
async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  await this.run('BEGIN IMMEDIATE');
  try {
    const result = await fn(this);
    await this.run('COMMIT');
    return result;
  } catch (err) {
    await this.run('ROLLBACK');
    throw err;
  }
}
```

**Transaction Modes in SQLite:**

| Mode | Lock Behavior | Use Case |
|------|--------------|----------|
| `BEGIN` (default) | Defers lock until write | Read-heavy workloads |
| `BEGIN IMMEDIATE` | Acquires reserved lock immediately | Write conflicts expected |
| `BEGIN EXCLUSIVE` | Acquires exclusive lock | Schema changes |

**Why `BEGIN IMMEDIATE`?**
- **Immediate lock acquisition**: Prevents other transactions from starting conflicting operations
- **Serializable isolation**: Ensures transactions see a consistent snapshot
- **Prevents deadlocks**: Lock ordering is predictable

**How It Works:**

1. **Transaction Start**: `BEGIN IMMEDIATE` acquires a reserved lock
2. **Operations Execute**: Read/write operations within transaction see consistent state
3. **Commit/Rollback**: 
   - `COMMIT` → Make changes permanent, release lock
   - `ROLLBACK` → Discard changes, release lock

**Example: Concurrent Booking Attempts**

```
Time    | Transaction A              | Transaction B
--------|---------------------------|----------------------------
T1      | BEGIN IMMEDIATE           |
T2      | SELECT available_seats    | BEGIN IMMEDIATE (WAITS)
T3      | UPDATE seats = seats - 1  | (still waiting)
T4      | COMMIT                    |
T5      |                           | (lock acquired)
T6      |                           | SELECT available_seats
T7      |                           | UPDATE fails (no seats left)
T8      |                           | ROLLBACK
```

**Additional Database Settings:**

```typescript
PRAGMA foreign_keys = ON;      // Enforce referential integrity
PRAGMA journal_mode = WAL;     // Write-Ahead Logging (better concurrency)
```

**WAL Mode Benefits:**
- **Concurrent reads**: Multiple readers can access database while writer is active
- **Better performance**: Reads don't block writes and vice versa
- **Crash recovery**: WAL journal provides durability guarantees

---

## 6. How Would You Test This System for Race Conditions?

### Problem
Race conditions are hard to reproduce and detect. We need systematic testing to ensure concurrency safety.

### Solution
**Concurrent API calls** using `Promise.allSettled()` to simulate simultaneous requests, combined with deterministic test scenarios.

### Implementation Details

**Test Strategy (from `tests/smoke.test.ts`):**

```typescript
console.log('📋 Test 1: Concurrency - Two users racing for last seat');

// Create trip with only 1 seat
const raceTrip = await apiRequest('POST', '/api/trips', {
  max_capacity: 1,
  // ... other fields
});

const userA = uuidv4();
const userB = uuidv4();

// Race two booking requests simultaneously
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

// Verify exactly one succeeds, one fails
const successes = results.filter((r) => r.status === 'fulfilled');
const failures = results.filter((r) => r.status === 'rejected');

assert(successes.length === 1, `Expected 1 success, got ${successes.length}`);
assert(failures.length === 1, `Expected 1 failure, got ${failures.length}`);

// Verify no overbooking occurred
const tripAfter = await apiRequest('GET', `/api/trips/${tripId}`);
assert(tripAfter.available_seats === 0, 'Expected available_seats=0 after one booking');
```

**What This Test Validates:**
1. **Atomic seat reservation**: Only one booking succeeds
2. **Conflict handling**: Second request returns 409 Conflict
3. **No overbooking**: Final seat count is correct (0, not negative)

**Additional Race Condition Test Scenarios:**

### Scenario 1: Webhook Race Conditions
```typescript
// Test: Duplicate webhooks processed simultaneously
const [webhook1, webhook2] = await Promise.allSettled([
  processWebhook(bookingId, 'success', idempotencyKey),
  processWebhook(bookingId, 'success', idempotencyKey), // Same key
]);

// Verify: Both return same result, booking state unchanged after first
```

### Scenario 2: Cancel vs Expiry Race
```typescript
// Test: User cancels booking while expiry job runs
const [cancelResult, expiryResult] = await Promise.allSettled([
  cancelBooking(bookingId),
  expirePendingBookings(),
]);

// Verify: Only one succeeds, seats released exactly once
```

### Scenario 3: Multiple Concurrent Cancellations
```typescript
// Test: Multiple cancel requests for same booking
const results = await Promise.allSettled([
  cancelBooking(bookingId),
  cancelBooking(bookingId),
  cancelBooking(bookingId),
]);

// Verify: First succeeds, others return 409 (already cancelled)
```

**Advanced Testing Strategies:**

1. **Load Testing**: Use tools like `artillery` or `k6` to simulate hundreds of concurrent requests
   ```bash
   artillery quick --count 100 --num 10 http://localhost:3000/api/trips/{tripId}/book
   ```

2. **Property-Based Testing**: Use libraries like `fast-check` to generate random concurrent operation sequences

3. **Database-Level Testing**: Directly manipulate database state to test edge cases
   ```typescript
   // Manually set expires_at in past to test expiry
   await db.run('UPDATE bookings SET expires_at = ? WHERE id = ?', 
     [new Date(Date.now() - 1000).toISOString(), bookingId]);
   ```

4. **Integration Tests with Controlled Timing**: Use timers to test expiry behavior
   ```typescript
   // Create booking, fast-forward time, verify expiry
   jest.useFakeTimers();
   // ... create booking ...
   jest.advanceTimersByTime(16 * 60 * 1000); // 16 minutes
   // ... verify expired ...
   ```

**Key Testing Principles:**
- **Deterministic**: Same inputs produce same results
- **Isolated**: Tests don't interfere with each other
- **Realistic**: Simulate actual user behavior patterns
- **Comprehensive**: Cover all state transitions and edge cases

---

## Summary

The GoTyolo booking system uses a combination of:

1. **Database-level locking** (`BEGIN IMMEDIATE`) to prevent overbooking
2. **Idempotency keys** to handle duplicate webhooks safely
3. **Time-based expiration** with cron jobs to handle missing webhooks
4. **Formula-based refunds** with time-sensitive policies
5. **Transaction isolation** for consistent concurrent operations
6. **Concurrent testing** to validate race condition handling

These design decisions ensure the system is **robust, reliable, and safe under concurrent load** while maintaining business logic correctness.

