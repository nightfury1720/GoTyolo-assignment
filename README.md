# GoTyolo Travel Booking System

> **Backend API for a travel booking platform with payment processing, refunds, and admin visibility**

## 📋 Overview

GoTyolo is a travel booking system that handles:
- ✅ Trip discovery and booking
- ✅ Payment processing with webhook idempotency
- ✅ Refund policies with cancellation fees
- ✅ Auto-expiry of pending bookings (15 minutes)
- ✅ Admin metrics and at-risk trip detection
- ✅ Concurrency-safe booking (prevents overbooking)

## 🚀 Quick Start

### Prerequisites

- **Node.js 20+** OR **Docker & Docker Compose**

### Option 1: Local Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Seed database with sample data
npm run seed

# Start server
npm start

# Or run in development mode
npm run dev
```

Server runs on **http://localhost:3000**

### Option 2: Docker

```bash
# Build and run with Docker Compose
docker-compose up --build

# Stop containers
docker-compose down
```

## 📚 API Endpoints

### Trips

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/trips` | List all published trips |
| `GET` | `/api/trips/:id` | Get trip details |

### Bookings

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/trips/:tripId/book` | Create a booking (reserve seats) |
| `GET` | `/api/bookings/:id` | Get booking details |
| `POST` | `/api/bookings/:id/cancel` | Cancel a booking (with refund if applicable) |

### Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/payments/webhook` | Process payment webhook (always returns 200 OK) |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/admin/trips/:tripId/metrics` | Get detailed trip metrics |
| `GET` | `/api/admin/trips/at-risk` | List at-risk trips (low occupancy, departing soon) |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check endpoint |

## 📖 API Examples

### Create a Booking

```bash
curl -X POST http://localhost:3000/api/trips/<trip-id>/book \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "user-123",
    "num_seats": 2
  }'
```

**Response:**
```json
{
  "booking": {
    "id": "uuid",
    "trip_id": "uuid",
    "user_id": "user-123",
    "num_seats": 2,
    "state": "PENDING_PAYMENT",
    "price_at_booking": 200.00,
    "expires_at": "2026-01-25T10:15:00.000Z",
    ...
  },
  "payment_url": "https://payments.example.com/pay/<booking-id>"
}
```

### Process Payment Webhook

```bash
curl -X POST http://localhost:3000/api/payments/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "booking_id": "<booking-id>",
    "status": "success",
    "idempotency_key": "webhook-key-123"
  }'
```

**Note:** Always returns `200 OK` even for invalid requests (prevents payment provider retries).

### Cancel a Booking

```bash
curl -X POST http://localhost:3000/api/bookings/<booking-id>/cancel
```

**Response:**
```json
{
  "id": "uuid",
  "state": "CANCELLED",
  "refund_amount": 90.00,
  "cancelled_at": "2026-01-25T10:30:00.000Z",
  ...
}
```

### Get Trip Metrics

```bash
curl http://localhost:3000/api/admin/trips/<trip-id>/metrics
```

**Response:**
```json
{
  "trip_id": "uuid",
  "title": "Paris City Tour",
  "occupancy_percent": 75,
  "total_seats": 20,
  "booked_seats": 15,
  "available_seats": 5,
  "booking_summary": {
    "confirmed": 12,
    "pending_payment": 2,
    "cancelled": 1,
    "expired": 0
  },
  "financial": {
    "gross_revenue": 1200.00,
    "refunds_issued": 100.00,
    "net_revenue": 1100.00
  }
}
```

## 🧪 Testing

### Run Smoke Tests

```bash
npm run test:smoke
```

**Tests cover:**
- ✅ Concurrency: Two users racing for last seat (only one succeeds)
- ✅ Webhook idempotency: Same webhook processed twice
- ✅ Refund calculation: Correct amount with cancellation fee
- ✅ Seat release: Cancelled bookings release seats
- ✅ Auto-expiry: Pending bookings expire after 15 minutes

## 🏗️ Architecture

### Technology Stack

- **Language:** TypeScript (type safety, better IDE support)
- **Runtime:** Node.js 20+
- **Framework:** Express.js
- **Database:** SQLite (with `BEGIN IMMEDIATE` transactions for concurrency)
- **Scheduling:** node-cron (auto-expiry job runs every minute)

### Project Structure

```
src/
├── index.ts              # Application entry point
├── types/               # TypeScript type definitions
├── db/                  # Database connection & migrations
├── models/              # Trip and Booking entity classes
├── routes/              # API route handlers
├── services/            # Business logic (booking, payment, refund, expiry)
├── middleware/          # Validation & error handling
└── utils/              # State machine & logging
```

## 🔑 Key Design Decisions

### 1. Preventing Overbooking

**Solution:** Use `BEGIN IMMEDIATE` transactions that lock the database during seat availability check and decrement. The check and update are atomic, so concurrent requests cannot both succeed for the last seat.

**Implementation:** `src/services/bookingService.ts` uses `withTransaction()` wrapper that executes `BEGIN IMMEDIATE` → check seats → decrement → `COMMIT`.

### 2. Handling Duplicate Webhooks

**Solution:** Store `idempotency_key` (UNIQUE constraint) on the booking record. On subsequent webhooks with the same key, return the current booking state without re-processing (idempotent behavior).

**Implementation:** `src/services/paymentService.ts` checks for existing `idempotency_key` before processing.

### 3. Auto-Expiry of Pending Bookings

**Solution:** A cron job runs every minute checking for bookings where `state = 'PENDING_PAYMENT'` and `expires_at < now()`. These bookings are transitioned to `EXPIRED` and their seats are released back to the trip.

**Implementation:** `src/services/expiryService.ts` + scheduled in `src/index.ts`.

### 4. Refund Calculation

**Formula:**
```
refund_amount = price_at_booking × (1 - cancellation_fee_percent / 100)
```

**Example:** $100 booking with 10% fee = $100 × 0.90 = **$90 refund**

**Rules:**
- **Before cutoff** (more than `refundable_until_days_before` days before trip): Full refund minus fee, seats released
- **After cutoff**: No refund ($0), seats NOT released (trip is imminent)

**Implementation:** `src/services/refundService.ts`

### 5. Database Concurrency Control

**Solution:** SQLite's `BEGIN IMMEDIATE` transaction mode with application-level `withTransaction()` wrapper. This provides serializable isolation for critical operations.

**Implementation:** `src/services/transaction.ts`

### 6. Testing for Race Conditions

**Approach:** The smoke test includes a concurrent booking test using `Promise.allSettled()` to race two booking attempts for a single-seat trip. Exactly one must succeed and one must fail with 409 Conflict.

**Implementation:** `tests/smoke.test.ts`

## 📊 Booking State Machine

```
PENDING_PAYMENT
  ├── [payment_success] → CONFIRMED
  ├── [payment_failed] → EXPIRED
  └── [auto_expire (15 min)] → EXPIRED

CONFIRMED
  ├── [cancel_before_cutoff] → CANCELLED (with refund, seats released)
  └── [cancel_after_cutoff] → CANCELLED (no refund, seats kept)

CANCELLED (terminal)
EXPIRED (terminal)
```

## 🐛 Bugs Found & Fixed

1. **Webhook HTTP Status:** Fixed webhook endpoint to always return `200 OK` even for validation errors (prevents payment provider retries)
2. **Transaction Safety:** All critical operations use `BEGIN IMMEDIATE` transactions to prevent race conditions
3. **Seat Release Logic:** Ensured seats are released atomically within transactions on expiry/cancellation

## 📝 Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Start production server |
| `npm run dev` | Start development server (with ts-node) |
| `npm run seed` | Seed database with sample data |
| `npm run expire` | Manually trigger expiry job |
| `npm run test:smoke` | Run smoke tests |
| `npm run clean` | Remove compiled files |

## 🔍 Database Schema

### Trips Table
- `id` (UUID, PRIMARY KEY)
- `title`, `destination`
- `start_date`, `end_date`
- `price` (per seat)
- `max_capacity`, `available_seats`
- `status` (DRAFT | PUBLISHED)
- `refundable_until_days_before`
- `cancellation_fee_percent`

### Bookings Table
- `id` (UUID, PRIMARY KEY)
- `trip_id` (FOREIGN KEY)
- `user_id`
- `num_seats`
- `state` (PENDING_PAYMENT | CONFIRMED | CANCELLED | EXPIRED)
- `price_at_booking`
- `payment_reference`
- `expires_at` (15 minutes after creation)
- `cancelled_at`
- `refund_amount`
- `idempotency_key` (UNIQUE, for webhook deduplication)





