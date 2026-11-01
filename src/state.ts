// Stateful mode: an in-memory overlay on the generated collections. The generated
// records stay the baseline; the overlay records what clients created, changed and
// deleted, keyed by the concrete collection path (`/users`, `/users/3/posts`).
// Everything here is deterministic: the same requests in the same order give the
// same results.

export interface CollectionState {
  /** Records created with POST, by id (as a string), in creation order. */
  created: Map<string, Record<string, unknown>>;
  /** Generated records changed with PUT/PATCH, by id. */
  updated: Map<string, Record<string, unknown>>;
  /** Ids of generated records removed with DELETE. */
  deleted: Set<string>;
  /** Ids of the generated records, once computed. */
  baseIds?: unknown[];
  /** How many records were created here, for ids and seeds. */
  creates: number;
}

/** What clients changed in a stateful mock server. Pass it to `respond()` as `state`. */
export class MockState {
  private collections = new Map<string, CollectionState>();

  /** Forget every change, back to the generated data. */
  reset(): void {
    this.collections.clear();
  }

  /** The state of one collection, created on first use. */
  collection(path: string): CollectionState {
    let c = this.collections.get(path);
    if (!c) this.collections.set(path, (c = { created: new Map(), updated: new Map(), deleted: new Set(), creates: 0 }));
    return c;
  }
}
