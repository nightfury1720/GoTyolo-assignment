import { TRANSITIONS, BookingState, BookingEvent } from '../types';

export function transition(currentState: BookingState, event: BookingEvent): BookingState {
  const stateTransitions = TRANSITIONS[currentState];
  const nextState = stateTransitions?.[event];

  if (!nextState) {
    throw new Error(`Invalid transition from ${currentState} with event ${event}`);
  }

  return nextState;
}
