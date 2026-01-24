# 🚀 GoTyolo - Travel Booking System

> A robust Node.js/TypeScript backend API for a travel booking platform that handles concurrent bookings, payment webhooks, and refund management with enterprise-grade concurrency control.

---

## ❓ Questions & Answers

### How do you prevent overbooking?

The system prevents overbooking using **PostgreSQL transactions with row-level locking** (`SELECT FOR UPDATE`). Here's how it works:

1. **Transaction-based locking**: When creating a booking, the system locks the trip row using `SELECT FOR UPDATE` within a transaction
2. **Dynamic seat calculation**: Available seats are calculated by summing:
   - All `PENDING_PAYMENT` bookings with `expires_at > NOW()`
   - All `CONFIRMED` bookings
3. **Atomic check-and-reserve**: The availability check and booking creation happen atomically within the same transaction
4. **Conflict detection**: If available seats < requested seats, the transaction fails with `409 Conflict`

**Formula:**
```
Available Seats = max_capacity - (pending_seats + confirmed_seats)
```

This ensures that concurrent booking requests are serialized, and only the correct number of bookings can succeed based on actual availability.

### How do you handle duplicate webhooks?

Duplicate webhooks are handled through **idempotency keys** with a unique database constraint:

1. **Unique constraint**: Each webhook includes an `idempotency_key` that's stored in `bookings.idempotency_key` (UNIQUE constraint)
2. **Duplicate detection**: On webhook receipt:
   - If `idempotency_key` exists for a different booking → return duplicate error
   - If `idempotency_key` matches current booking → return current state (idempotent)
   - Otherwise → process webhook and store the key
3. **Safe retries**: Payment providers can safely retry failed webhooks without causing duplicate state changes

This ensures that the same webhook can be processed multiple times safely, and duplicate webhooks from different sources are detected and rejected.

### What happens if payment webhook never arrives? How do you auto-expire bookings?

If a payment webhook never arrives, bookings automatically expire through a **background cleanup job**:

1. **Expiration timestamp**: Each booking in `PENDING_PAYMENT` state has an `expires_at` timestamp (15 minutes after creation)
2. **Background job**: The `expirePendingBookings()` function runs periodically (via cron job, default: every 5 minutes)
3. **Expiration logic**: Finds all bookings where:
   - `state = PENDING_PAYMENT`
   - `expires_at < NOW()`
4. **Cleanup actions**: Updates booking state to `EXPIRED`, which releases the seats back to availability

**Timing**: Bookings expire 15 minutes after creation, giving users enough time to complete payment while preventing seats from being held indefinitely.

### How do you calculate refunds? Show the formula.

Refunds are calculated based on cancellation fees and refund cutoff dates:

**Refund Formula:**
```
Refund Amount = price_at_booking × (1 - cancellation_fee_percent/100)
```

**Business Rules:**

- **Before refund cutoff** (trip starts > `refundable_until_days_before` days from now):
  - ✅ Apply cancellation fee and refund remaining amount
  - ✅ Release seats back to availability

- **After refund cutoff** (trip starts ≤ `refundable_until_days_before` days from now):
  - ❌ No refund ($0)
  - ❌ Keep seats reserved (trip is imminent, can't resell)

**Example:**
```
Booking: $100
Cancellation Fee: 10%

Before cutoff: Refund = $100 × (1 - 0.10) = $90
After cutoff:  Refund = $0
```

### What database concurrency control do you use?

The system uses **PostgreSQL transactions with row-level locking** (`SELECT FOR UPDATE`):

1. **Row-level locks**: `SELECT FOR UPDATE` locks the trip row during booking creation
2. **Transaction isolation**: PostgreSQL's default READ COMMITTED isolation level ensures consistency
3. **Atomic operations**: All seat availability checks and booking creation happen within a single transaction
4. **Automatic serialization**: Concurrent requests are automatically serialized by the database, ensuring only one can modify the trip at a time

This approach provides strong consistency guarantees while avoiding the complexity of application-level locking mechanisms.

### How would you test this system for race conditions?

Race condition testing involves **concurrent request simulation**:

1. **Setup**: Create a trip with limited seats (e.g., 2 seats available)
2. **Concurrent requests**: Launch 3+ simultaneous booking requests for 1 seat each using `Promise.all()`
3. **Verification**:
   - Exactly 2 bookings should succeed
   - 1+ bookings should fail with `409 Conflict - Not enough seats available`
   - Database should remain consistent (no overbooking)
   - Total confirmed + pending seats should never exceed `max_capacity`

**Test Implementation:**
```typescript
const promises = [];
for (let i = 0; i < 3; i++) {
  promises.push(
    createBooking(tripId, userId, 1)
      .catch(err => ({ error: err.message, status: err.status }))
  );
}
const results = await Promise.all(promises);

const successful = results.filter(r => !r.error);
const failed = results.filter(r => r.error);
assert(successful.length <= availableSeats);
assert(failed.length >= 1);
assert(failed.every(r => r.status === 409));
```

This tests real concurrency scenarios and verifies that transaction isolation prevents overbooking.

---

## 📋 Table of Contents

- [Questions & Answers](#-questions--answers)
- [Tech Stack](#-tech-stack)
- [Features](#-features)
- [Architecture Overview](#-architecture-overview)
- [Quick Start](#-quick-start)
- [API Documentation](#-api-documentation)
- [Database Schema](#-database-schema)
- [State Machine](#-state-machine)
- [Refund System](#-refund-system)
- [Testing](#-testing)
- [Performance & Monitoring](#-performance--monitoring)
- [Development](#-development)

---

## 🛠 Tech Stack

| Category | Technology |
|----------|-----------|
| **Language** | TypeScript |
| **Runtime** | Node.js |
| **Database** | PostgreSQL |
| **Framework** | Express.js |
| **Containerization** | Docker + Docker Compose |

---

## ✨ Features

- ✅ **Concurrent Booking Management** - Prevents overbooking with reservation-based seat tracking
- ✅ **Payment Webhook Processing** - Idempotent webhook handling with duplicate detection
- ✅ **Automatic Expiration** - Background job expires stale bookings and releases seats
- ✅ **Refund Calculation** - Smart refund system with cancellation fees and cutoff dates
- ✅ **State Machine** - Robust booking state transitions (PENDING_PAYMENT → CONFIRMED → CANCELLED)
- ✅ **Transaction Safety** - Database transactions ensure data consistency
- ✅ **Comprehensive Logging** - Full audit trail for debugging and monitoring

---

## 🏗 Architecture Overview

This system implements a **two-phase booking process** to handle concurrency safely:

### Phase 1: Reservation
- Create a reservation (temporarily holds seats)
- Create booking in `PENDING_PAYMENT` state
- Reservation expires after 15 minutes

### Phase 2: Confirmation
- Payment webhook converts reservation to confirmed booking
- Seats are permanently allocated
- Reservation is cleaned up

### Key Design Decision

The system uses a `reservations` table as a **seat buffer**, where available seats are calculated dynamically by summing active reservations rather than relying on a denormalized counter. This ensures a single source of truth and prevents race conditions.

---

## 🚀 Quick Start

### Prerequisites

- Node.js (v18+)
- Docker & Docker Compose
- PostgreSQL (via Docker)

### Installation

```bash
# 1. Clone the repository
git clone <repository-url>
cd gotyolo-assignment

# 2. Install dependencies
npm install

# 3. Start PostgreSQL database
docker-compose up postgres -d

# 4. Run database migrations and seed data
npm run build
node dist/scripts/seed.js

# 5. Start the application
npm run dev
# or with Docker
docker-compose up
```

### Verify Installation

```bash
# Run tests
npm test

# Check API health
curl http://localhost:3000/api/trips
```

---

## 📚 API Documentation

### Trips

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/trips` | List all published trips | Public |
| `GET` | `/api/trips/:id` | Get trip details | Public |
| `POST` | `/api/trips` | Create new trip | Admin |
| `PUT` | `/api/trips/:id` | Update trip | Admin |

### Bookings

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `POST` | `/api/trips/:id/book` | Create new booking | Public |
| `GET` | `/api/bookings/:id` | Get booking details | Public |
| `POST` | `/api/bookings/:id/cancel` | Cancel booking | Public |
| `GET` | `/api/bookings` | List user bookings | Public |

### Payments

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `POST` | `/api/payments/webhook` | Handle payment webhook | Webhook |

### Admin

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `GET` | `/api/admin/trips/:id/metrics` | Get trip metrics | Admin |
| `GET` | `/api/admin/trips/at-risk` | List at-risk trips | Admin |

---

## 🗄 Database Schema

### Key Tables

| Table | Purpose |
|-------|---------|
| `trips` | Trip information, capacity, and pricing |
| `bookings` | Booking records with state machine |
| `reservations` | Temporary seat holds for concurrency control |

### Indexes

- `idx_bookings_trip_id` - Fast trip booking lookups
- `idx_bookings_state` - Filter bookings by state
- `idx_bookings_expires_at` - Expiry job optimization
- `idx_reservations_trip_id` - Seat availability calculations
- `idx_reservations_expires_at` - Reservation cleanup
- `idx_trips_status` - Published trip filtering

---

## 🔄 State Machine

```
┌─────────────────┐
│ PENDING_PAYMENT │
└────────┬────────┘
         │
         ├─── Payment Success ───► ┌───────────┐
         │                          │ CONFIRMED │
         │                          └─────┬─────┘
         │                                │
         │                                ├─── User Cancellation ───► ┌───────────┐
         │                                │                           │ CANCELLED │
         │                                │                           └───────────┘
         │                                │
         └─── Payment Failed/Timeout ───► ┌──────────┐
                                          │ EXPIRED  │
                                          └──────────┘

Terminal States: EXPIRED, CANCELLED
```

### State Transitions

- `PENDING_PAYMENT` → `CONFIRMED` (payment webhook success)
- `PENDING_PAYMENT` → `EXPIRED` (payment timeout or failure)
- `CONFIRMED` → `CANCELLED` (user cancellation)
- `EXPIRED` → (terminal state)
- `CANCELLED` → (terminal state)

---

## 💰 Refund System

### Refund Formula

```
Refund Amount = price_at_booking × (1 - cancellation_fee_percent/100)
```

### Business Rules

#### Before Refund Cutoff
*(Trip starts > `refundable_until_days_before` days from now)*

- ✅ **Pending Payments**: Apply cancellation fee and refund remaining amount
- ✅ **Confirmed Bookings**: Apply cancellation fee and refund remaining amount
- ✅ **Seats**: Release seats back to availability (trip is far enough away)

#### After Refund Cutoff
*(Trip starts ≤ `refundable_until_days_before` days from now)*

- ❌ **Pending Payments**: No refund (can't cancel confirmed payments after cutoff)
- ❌ **Confirmed Bookings**: No refund ($0)
- ❌ **Seats**: Keep seats reserved (trip is imminent, can't resell)

### Example

```
Booking: $100
Cancellation Fee: 10%

Before cutoff: Refund = $100 × (1 - 0.10) = $90
After cutoff:  Refund = $0
```

---

## 🧪 Testing

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
const promises = [];
for (let i = 0; i < 3; i++) {
  promises.push(createReservation(tripId, userId, 1));
}
const results = await Promise.all(promises);

const successful = results.filter(r => !r.error);
const failed = results.filter(r => r.error);
assert(successful.length <= availableSeats);
assert(failed.length >= 1);
```

**Why this works:**

- ✅ Tests real concurrency scenarios
- ✅ Verifies transaction isolation prevents overbooking
- ✅ Ensures error handling works correctly

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
ts-node tests/comprehensive.test.ts
```

---

## ⚡ Performance & Monitoring

### Performance Considerations

- **Connection Pooling**: PostgreSQL connection pool with 20 max connections
- **Transaction Scoping**: Keep transactions as short as possible
- **Background Cleanup**: Periodic job removes expired reservations
- **Optimistic Concurrency**: Avoids locks while maintaining consistency

### Monitoring and Debugging

- **Comprehensive Logging**: All state transitions and business logic logged
- **Transaction Tracing**: Database operations wrapped in transactions for consistency
- **Error Handling**: Detailed error responses with appropriate HTTP status codes
- **Audit Trail**: Full history of bookings, payments, and cancellations

---

## 🐛 Bugs Found and Fixes

During development, several concurrency-related bugs were identified and fixed:

| Bug | Fix |
|-----|-----|
| **Race Condition Overbooking** | Implemented reservation-based seat tracking |
| **Missing Seat Release** | Added reservation cleanup in expiry service |
| **Duplicate Webhook Processing** | Implemented idempotency key checking |
| **Inconsistent Refund Calculation** | Fixed formula to properly apply cancellation fees |

---

## 💻 Development

### Available Scripts

```bash
# Build TypeScript
npm run build

# Start development server
npm run dev

# Run production server
npm start

# Seed database
npm run seed

# Run expiry job
npm run expire

# Run tests
npm test

# Clean build artifacts
npm run clean
```

### Project Structure

```
gotyolo-assignment/
├── src/
│   ├── db/              # Database configuration & migrations
│   ├── models/          # Data models (Booking, Trip)
│   ├── routes/          # API route handlers
│   ├── services/       # Business logic services
│   ├── middleware/     # Express middleware
│   ├── utils/          # Utility functions
│   └── types/          # TypeScript type definitions
├── scripts/            # Utility scripts (seed, expiry)
├── tests/              # Test files
└── dist/               # Compiled JavaScript output
```

### Environment Variables

Create a `.env` file (if needed) with:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/gotyolo
PORT=3000
```

---

## 📝 License

ISC

---

## 👥 Contributing

This is an assignment project. For questions or issues, please refer to the project maintainer.

---

**Built with ❤️ using TypeScript and PostgreSQL**
