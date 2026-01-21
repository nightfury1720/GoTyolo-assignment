import { STATES, EVENTS, TRANSITIONS, BookingState, BookingEvent } from '../types';

export function transition(currentState: BookingState, event: BookingEvent): BookingState {
  const stateTransitions = TRANSITIONS[currentState];
  const nextState = stateTransitions?.[event];

  if (!nextState) {
    throw new Error(`Invalid transition from ${currentState} with event ${event}`);
  }

  return nextState;
}

export function isTerminalState(state: BookingState): boolean {
  return state === STATES.CANCELLED || state === STATES.EXPIRED;
}

export function canTransition(currentState: BookingState, event: BookingEvent): boolean {
  const stateTransitions = TRANSITIONS[currentState];
  return !!stateTransitions?.[event];
}

export { STATES, EVENTS };
