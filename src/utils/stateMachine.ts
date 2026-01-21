import { STATES, EVENTS, TRANSITIONS, BookingState, BookingEvent } from '../types';

/**
 * Transition a booking from one state to another based on an event.
 * Throws an error if the transition is invalid.
 */
export function transition(currentState: BookingState, event: BookingEvent): BookingState {
  const stateTransitions = TRANSITIONS[currentState];
  const nextState = stateTransitions?.[event];

  if (!nextState) {
    throw new Error(`Invalid transition from ${currentState} with event ${event}`);
  }

  return nextState;
}

/**
 * Check if a state is terminal (no further transitions possible)
 */
export function isTerminalState(state: BookingState): boolean {
  return state === STATES.CANCELLED || state === STATES.EXPIRED;
}

/**
 * Check if a transition is valid without throwing
 */
export function canTransition(currentState: BookingState, event: BookingEvent): boolean {
  const stateTransitions = TRANSITIONS[currentState];
  return !!stateTransitions?.[event];
}

export { STATES, EVENTS };
