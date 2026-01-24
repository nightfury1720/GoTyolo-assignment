# 🚀 GoTyolo - Travel Booking System

> A robust Node.js/TypeScript backend API for a travel booking platform that handles concurrent bookings, payment webhooks, and refund management with enterprise-grade concurrency control.

---

## 📋 Table of Contents

- [Tech Stack](#-tech-stack)
- [Features](#-features)
- [Architecture Overview](#-architecture-overview)
- [Quick Start](#-quick-start)
- [API Documentation](#-api-documentation)
- [Database Schema](#-database-schema)
- [State Machine](#-state-machine)
- [Concurrency Control](#-concurrency-control)
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

## 🔒 Concurrency Control

### Database Concurrency Control

**We use PostgreSQL transactions with optimistic concurrency control.** The system avoids explicit row-level locking (`SELECT FOR UPDATE`) in favor of a reservation-based approach that naturally serializes concurrent requests through database transactions.

#### Key Principles

- ✅ **No explicit locks** - Transactions ensure atomic seat availability checks
- ✅ **Serializable isolation** - PostgreSQL's default transaction isolation prevents dirty reads
- ✅ **Reservation buffer** - The `reservations` table acts as a temporary seat hold

### Preventing Overbooking

**How it works:**

1. **Calculate Available Seats Dynamically**
   ```sql
   SELECT COALESCE(SUM(num_seats), 0) as total_seats
   FROM reservations
   WHERE trip_id = ? AND expires_at > NOW()
   ```

2. **Available Seats Formula**
   ```
   Available Seats = max_capacity - reserved_seats
   ```

3. **Create Reservation & Booking**
   - Create reservation record (holds seats temporarily)
   - Create booking record in `PENDING_PAYMENT` state
   - Transaction ensures atomicity

4. **Transaction Serialization**
   - Concurrent requests are serialized automatically
   - Only one can succeed when competing for the last seat

**Why this prevents overbooking:**

- ✅ **Single source of truth** - Available seats calculated from reservations table
- ✅ **Transaction isolation** - Concurrent requests can't see uncommitted reservations
- ✅ **Automatic cleanup** - Expired reservations are cleaned up before availability checks

### Handling Duplicate Webhooks

**Idempotency through unique keys:**

1. Each webhook includes an `idempotency_key` parameter
2. The key is stored in `bookings.idempotency_key` (unique constraint)
3. On webhook receipt:
   - Check if `idempotency_key` exists for different booking → return duplicate error
   - Check if webhook already processed → return current state
   - Otherwise process webhook and store the key

**Benefits:**

- ✅ **Safe retries** - Payment providers can safely retry failed webhooks
- ✅ **No double processing** - Same webhook won't create duplicate state changes
- ✅ **Audit trail** - Track which webhooks were processed when

### Auto-Expiration of Bookings

**Background cleanup process:**

When payment webhooks never arrive, bookings remain in `PENDING_PAYMENT` state indefinitely. The system uses a background job to automatically expire stale bookings.

#### Expiry Service

- **Function**: `expirePendingBookings()` runs periodically (via cron job)
- **Frequency**: Configurable (default: every 5 minutes)

#### Expiration Logic

1. Find bookings where `state = PENDING_PAYMENT` and `expires_at < NOW()`
2. Find orphaned reservations where `expires_at < NOW()` and `booking_id IS NULL`

#### Cleanup Actions

- Update booking state to `EXPIRED`
- Delete associated reservations to release seats back to availability

#### Timing

- **Expiration Window**: Bookings expire 15 minutes after creation
- **Rationale**:
  - Gives users enough time to complete payment
  - Prevents seats from being held indefinitely
  - Balances user experience with seat availability

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
