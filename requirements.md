# GoTyolo - Booking System with Refunds: Requirements

## Overview
You are building a backend API for a simple travel booking platform. This case study evaluates your ability to:
- Design clear data models and state machines
- Handle concurrent requests safely
- Process payments with webhooks
- Implement refund policies correctly
- Write clean, well-documented code
- Debug and fix issues in unfamiliar code

## Problem Statement
**Business Context**: GoTyolo is a travel platform that sells trips to users. They currently have basic trip discovery and direct booking capability, and now adding payment processing with webhooks, refund management, and admin visibility.

**Your Mission**: Build a backend API that manages trip bookings, processes payments with webhooks, implements refund policies, and provides admin visibility.

## Functional Requirements

### 1. Data Model

#### Trip
- `id` (UUID)
- `title` (string)
- `destination` (string)
- `start_date` (datetime)
- `end_date` (datetime)
- `price` (decimal) - price per seat
- `max_capacity` (integer) - total seats
- `available_seats` (integer) - seats left (denormalized, must stay in sync)
- `status` (enum: DRAFT, PUBLISHED)
- `refund_policy`:
  - `refundable_until_days_before` (integer, e.g., 7)
  - `cancellation_fee_percent` (integer, e.g., 10)
- `created_at` (datetime)
- `updated_at` (datetime)

#### Booking
- `id` (UUID)
- `trip_id` (UUID, foreign key)
- `user_id` (UUID)
- `num_seats` (integer) - how many seats booked
- `state` (enum: PENDING_PAYMENT, CONFIRMED, CANCELLED, EXPIRED)
- `price_at_booking` (decimal) - total price paid (price per seat × num_seats)
- `payment_reference` (string) - reference from payment provider
- `created_at` (datetime)
- `expires_at` (datetime) - 15 mins after creation, auto-expire if still PENDING_PAYMENT
- `cancelled_at` (datetime, nullable)
- `refund_amount` (decimal, nullable) - amount refunded
- `idempotency_key` (string, unique) - for webhook deduplication
- `updated_at` (datetime)

**Schema Notes**: Simple schema with Trips table and Bookings table (with trip_id reference). Users can be implicit (just store user_id).

### 2. Booking Lifecycle & Payment Webhook

#### State Machine:
```
PENDING_PAYMENT (initial state)
    ↓
    [webhook arrives: payment_success] → CONFIRMED
    [webhook arrives: payment_failed] → EXPIRED
    [15 mins pass, no webhook] → EXPIRED (auto-cleanup job)

CONFIRMED (stable state)
    ↓
    [user cancels before cutoff] → CANCELLED (with refund)
    [user cancels after cutoff] → CANCELLED (no refund)

CANCELLED → (terminal)
EXPIRED → (terminal)
```

#### Critical Rules:

**Seat Reservation:**
- When booking created: decrement `available_seats` by `num_seats`
- When booking expires/cancelled: increment `available_seats` back
- Never allow negative `available_seats` (reject if not enough seats)

**Payment Webhook:**
- Webhook body: `{ "booking_id": "...", "status": "success|failed", "idempotency_key": "..." }`
- Use `idempotency_key` to prevent double-processing same webhook
- If duplicate: return 200 OK (idempotent)
- If invalid booking: return 200 OK (don't fail, just log)
- Always return 200 OK to the payment provider

**Concurrency:**
- Two users booking simultaneously for last seat: only one should succeed
- Use database transaction + row-level locking (PostgreSQL: `SELECT FOR UPDATE`)
- Other user gets: `409 Conflict - No seats available`

### 3. Refund & Cancellation Policy

#### Rules:

**Before Cutoff** (more than `refundable_until_days_before` before trip start):
- State: PENDING_PAYMENT or CONFIRMED
- Refund: `price_at_booking × (1 - cancellation_fee_percent/100)`
- Example: $100 booking, 10% fee → refund $90
- Release seats immediately
- New state: CANCELLED

**After Cutoff** (less than `refundable_until_days_before` before trip start):
- State: CONFIRMED only (can't refund pending payments)
- Refund: $0
- Don't release seats (trip is imminent)
- New state: CANCELLED

**Invalid Cancellations:**
- Cannot cancel already EXPIRED or CANCELLED bookings
- Cannot cancel PENDING_PAYMENT that already has payment webhook processed
- Return `409 Conflict` with clear message

### 4. Admin APIs

#### Trip Metrics - GET /admin/trips/{tripId}/metrics
Response:
```json
{
  "trip_id": "...",
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

#### At-Risk Trips - GET /admin/trips/at-risk
Returns trips where:
- Departure is within 7 days, AND
- Occupancy < 50%

Response:
```json
{
  "at_risk_trips": [
    {
      "trip_id": "...",
      "title": "...",
      "departure_date": "2026-01-25",
      "occupancy_percent": 30,
      "reason": "Low occupancy with imminent departure"
    }
  ]
}
```

## Required API Endpoints

### Trip Management
- `GET /trips` - List all published trips
- `GET /trips/{tripId}` - Get trip details
- `POST /trips` - Create new trip (admin)
- `PUT /trips/{tripId}` - Update trip (admin)
- `DELETE /trips/{tripId}` - Delete trip (admin)

### Booking Management
- `POST /trips/{tripId}/book` - Create booking
- `GET /bookings/{bookingId}` - Get booking details
- `POST /bookings/{bookingId}/cancel` - Cancel booking
- `GET /bookings` - List user bookings (with user_id query param)

### Payment Webhooks
- `POST /payments/webhook` - Handle payment webhook

### Admin APIs
- `GET /admin/trips/{tripId}/metrics` - Trip metrics
- `GET /admin/trips/at-risk` - At-risk trips

## Booking Flow Example

### Happy Path:
1. User calls `POST /trips/trip-123/book` with `{ "num_seats": 2 }`
2. Backend:
   - Check if trip exists and is PUBLISHED
   - Check if 2 seats available
   - Create booking with state=PENDING_PAYMENT, expires_at=now+15min
   - Decrement trip.available_seats by 2
   - Return booking details with payment_url (generated or mocked)
3. User pays on payment provider site
4. Payment provider calls `POST /payments/webhook` with:
   ```json
   {
     "booking_id": "booking-456",
     "status": "success",
     "idempotency_key": "webhook-789"
   }
   ```
5. Backend:
   - Check if idempotency_key already processed (prevent duplicates)
   - Update booking.state = CONFIRMED
   - Log the event
6. User calls `GET /bookings/booking-456` → gets state=CONFIRMED

### Cancellation Path:
1. User calls `POST /bookings/booking-456/cancel`
2. Backend:
   - Check if booking state is CONFIRMED
   - Check if trip start_date - today > refundable_until_days_before
   - If yes: calculate refund, set booking.state=CANCELLED, refund_amount=X
   - If no: set booking.state=CANCELLED, refund_amount=0
   - Increment trip.available_seats back
   - (Optional: trigger actual refund to payment system)
3. Return cancellation confirmation

## Debugging Challenge

You will be given:
- A seed script that creates trips, users, makes bookings
- A partially buggy implementation

**Example bugs to find:**
- Race condition: two users book same trip simultaneously, both get confirmed (overbooking)
- Wrong refund calculation: refund_amount not using cancellation_fee_percent correctly
- Seat release not happening: cancelled bookings don't increment available_seats
- Idempotency broken: duplicate webhook creates duplicate refunds
- Auto-expiry not working: PENDING_PAYMENT bookings never expire

**Your task:**
1. Run seed script and observe data
2. Query database to find inconsistencies
3. Identify root causes
4. Propose and implement fixes
5. Document findings in README

## Technical Requirements

### Stack
- **Language**: Python, JavaScript/Node, Java, Go (your choice)
- **Framework**: FastAPI, Express, Spring Boot, etc. (something you know well)
- **Database**: PostgreSQL recommended (easy concurrency testing), or MySQL/SQLite
- **No low-code platforms** - write actual business logic

### Mandatory Deliverables
1. **GitHub Repository**
   - Public or shared link
   - Clean commit history (5-10 commits showing progress)
   - .gitignore file

2. **Containerization**
   - Dockerfile (can be simple)
   - docker-compose.yml with database service
   - App starts with `docker-compose up`
   - Can stop with `docker-compose down`

3. **Documentation (README.md)**
   - Tech stack and why you chose it
   - Setup instructions (copy-paste commands)
   - How to run the app
   - API documentation (endpoints, request/response examples)
   - Architecture overview (how you handle concurrency, webhooks, etc.)
   - Bugs found and how you fixed them

4. **Sample Data**
   - Seed script (SQL or app endpoint) that populates:
     - 3-5 sample trips
     - 10-15 sample bookings (various states)
     - Historical bookings and cancellations
   - App should be usable immediately after startup

### Recommended (not required)
- Unit tests for business logic (refund calculation, state transitions)
- Integration tests for API endpoints
- Postman collection or curl examples

## Evaluation Criteria
*(The case study mentions evaluation criteria but doesn't list them in detail)*

## Tips
- Start with the database schema - get this right first
- Build core CRUD APIs (list trips, create booking) before webhooks
- Test concurrency early - write simple concurrent booking test
- Use timestamps - created_at, updated_at, expires_at are your friends
- Log everything - especially webhook processing (invaluable for debugging)
- Document your concurrency approach - say whether you use row locks, versioning, etc.
- Keep it simple - don't over-engineer; focus on correctness

## Questions to Answer in Your README
1. How do you prevent overbooking?
2. How do you handle duplicate webhooks?
3. What happens if payment webhook never arrives? How do you auto-expire bookings?
4. How do you calculate refunds? Show the formula.
5. What database concurrency control do you use?
6. How would you test this system for race conditions?
