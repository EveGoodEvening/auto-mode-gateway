const RESERVATION_METADATA_BYTES = 256;
function validReservation(bytes: number, reasoning: number): boolean {
  return Number.isSafeInteger(bytes) && Number.isSafeInteger(reasoning) && bytes >= 0 && reasoning >= 0 && reasoning <= bytes;
}

/** One live ledger shared by parsing, retained content and serialization temporaries. */
export class ResponseBudget {
  private bytes = 0;
  private reasoning = 0;
  private closed = false;
  private readonly allocations = new WeakMap<Uint8Array, ResponseReservation>();
  private readonly reservations = new Set<ResponseReservation>();
  constructor(readonly maximum: number, readonly reasoningMaximum: number) {}

  reserve(bytes: number, reasoning = 0): ResponseReservation {
    if (this.closed) throw new ResponseBudgetError();
    if (!validReservation(bytes, reasoning)) throw new RangeError('Invalid response reservation');
    this.replace(0, 0, bytes + RESERVATION_METADATA_BYTES, reasoning);
    const reservation = new ResponseReservation(this, bytes, reasoning);
    this.reservations.add(reservation);
    return reservation;
  }

  /** Atomic replacement preserves the aggregate/subset pair, including reclassification. */
  replace(previousBytes: number, previousReasoning: number, bytes: number, reasoning: number): void {
    if (!validReservation(previousBytes, previousReasoning) || !validReservation(bytes, reasoning)
      || previousBytes > this.bytes || previousReasoning > this.reasoning) throw new RangeError('Invalid response reservation');
    const nextBytes = this.bytes - previousBytes + bytes;
    const nextReasoning = this.reasoning - previousReasoning + reasoning;
    if (nextReasoning > nextBytes) throw new RangeError('Invalid response release');
    if (nextBytes > this.maximum || nextReasoning > this.reasoningMaximum) throw new ResponseBudgetError();
    if (this.closed && (bytes > previousBytes || reasoning > previousReasoning)) throw new ResponseBudgetError();
    this.bytes = nextBytes;
    this.reasoning = nextReasoning;
  }

  release(reservation: ResponseReservation): void { this.reservations.delete(reservation); }

  /** Register a pre-reserved allocation; subsequent consumers adopt, rather than duplicate, ownership. */
  registerBytes(value: Uint8Array, reservation: ResponseReservation): void {
    if (reservation.budget !== this || reservation.released || reservation.bytes < value.byteLength) throw new RangeError('Invalid response allocation');
    const previous = this.allocations.get(value);
    if (previous && previous !== reservation && !previous.released) throw new RangeError('Duplicate response allocation');
    this.allocations.set(value, reservation);
  }

  claimBytes(value: Uint8Array, reasoning = 0): ResponseReservation {
    const previous = this.allocations.get(value);
    if (previous && !previous.released) return previous;
    const reservation = this.reserve(value.byteLength, reasoning);
    this.allocations.set(value, reservation);
    return reservation;
  }

  releaseBytes(value: Uint8Array): void { this.allocations.get(value)?.release(); }

  close(): void {
    this.closed = true;
    for (const reservation of this.reservations) reservation.release();
  }
}

/** A reservation moves with its allocation and is released exactly once. */
export class ResponseReservation {
  private complete = false;
  constructor(readonly budget: ResponseBudget, private amount: number, private subset: number) {}
  get released(): boolean { return this.complete; }
  get bytes(): number { return this.amount; }
  get reasoning(): number { return this.subset; }

  resize(bytes: number, reasoning = this.reasoning): void {
    if (this.complete) throw new RangeError('Released response reservation');
    if (!validReservation(bytes, reasoning)) throw new RangeError('Invalid response reservation');
    this.budget.replace(this.amount + RESERVATION_METADATA_BYTES, this.subset, bytes + RESERVATION_METADATA_BYTES, reasoning);
    this.amount = bytes;
    this.subset = reasoning;
  }

  release(): void {
    if (this.complete) return;
    this.budget.replace(this.amount + RESERVATION_METADATA_BYTES, this.subset, 0, 0);
    this.complete = true;
    this.budget.release(this);
  }
}

export interface ResponseAccounting {
  budget: ResponseBudget;
}

export class ResponseBudgetError extends Error {
  readonly blocked = true;
  constructor() { super('Response resource limit exceeded'); this.name = 'ResponseBudgetError'; }
}
