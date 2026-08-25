export interface Clock {
  now(): Date;
}

export interface EventSink<Event> {
  publish(event: Event): void;
}

export interface ApplicationDependencies<Event> {
  clock: Clock;
  events: EventSink<Event>;
}
