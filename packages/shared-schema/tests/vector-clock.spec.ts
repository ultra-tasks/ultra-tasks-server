import { describe, it, expect } from 'vitest';
import {
  compareVectorClocks,
  mergeVectorClocks,
  limitVectorClockSize,
  MAX_VECTOR_CLOCK_SIZE,
} from '../src/vector-clock';

describe('compareVectorClocks', () => {
  describe('basic cases', () => {
    it('should return EQUAL for identical clocks', () => {
      const clock = { a: 1, b: 2 };
      expect(compareVectorClocks(clock, clock)).toBe('EQUAL');
    });

    it('should return EQUAL for two empty clocks', () => {
      expect(compareVectorClocks({}, {})).toBe('EQUAL');
    });

    it('should return LESS_THAN when a is strictly behind b', () => {
      const a = { x: 1, y: 2 };
      const b = { x: 2, y: 3 };
      expect(compareVectorClocks(a, b)).toBe('LESS_THAN');
    });

    it('should return GREATER_THAN when a is strictly ahead of b', () => {
      const a = { x: 5, y: 10 };
      const b = { x: 3, y: 7 };
      expect(compareVectorClocks(a, b)).toBe('GREATER_THAN');
    });

    it('should return CONCURRENT when neither dominates', () => {
      const a = { x: 3, y: 1 };
      const b = { x: 1, y: 3 };
      expect(compareVectorClocks(a, b)).toBe('CONCURRENT');
    });

    it('should return LESS_THAN when a has subset of keys (missing key = 0)', () => {
      const a = { x: 1 };
      const b = { x: 1, y: 2 };
      expect(compareVectorClocks(a, b)).toBe('LESS_THAN');
    });

    it('should return GREATER_THAN when a has superset of keys', () => {
      const a = { x: 1, y: 2 };
      const b = { x: 1 };
      expect(compareVectorClocks(a, b)).toBe('GREATER_THAN');
    });
  });

  describe('pruning-aware mode', () => {
    const buildMaxClock = (prefix: string, startVal: number): Record<string, number> => {
      const clock: Record<string, number> = {};
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE; i++) {
        clock[`${prefix}_${i}`] = startVal + i;
      }
      return clock;
    };

    it('should compare only shared keys when both clocks >= MAX_VECTOR_CLOCK_SIZE', () => {
      // Build two max-size clocks with some shared and some unique keys
      const a: Record<string, number> = {};
      const b: Record<string, number> = {};

      // 5 shared keys where a dominates
      for (let i = 0; i < 5; i++) {
        a[`shared_${i}`] = 10;
        b[`shared_${i}`] = 5;
      }
      // Fill remaining slots with unique keys
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE - 5; i++) {
        a[`a_only_${i}`] = 100;
        b[`b_only_${i}`] = 100;
      }

      // Without pruning-aware mode, unique keys would cause CONCURRENT
      // With pruning-aware mode (both at MAX), only shared keys are compared
      expect(Object.keys(a).length).toBe(MAX_VECTOR_CLOCK_SIZE);
      expect(Object.keys(b).length).toBe(MAX_VECTOR_CLOCK_SIZE);
      expect(compareVectorClocks(a, b)).toBe('GREATER_THAN');
    });

    it('should return EQUAL when shared keys are equal and both at max size', () => {
      const a: Record<string, number> = {};
      const b: Record<string, number> = {};

      for (let i = 0; i < 5; i++) {
        a[`shared_${i}`] = 10;
        b[`shared_${i}`] = 10;
      }
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE - 5; i++) {
        a[`a_only_${i}`] = 50;
        b[`b_only_${i}`] = 50;
      }

      expect(compareVectorClocks(a, b)).toBe('EQUAL');
    });

    it('should return CONCURRENT when shared keys are genuinely concurrent', () => {
      const a: Record<string, number> = {};
      const b: Record<string, number> = {};

      // Shared keys where a wins some, b wins others
      for (let i = 0; i < 3; i++) {
        a[`shared_a_wins_${i}`] = 10;
        b[`shared_a_wins_${i}`] = 5;
      }
      for (let i = 0; i < 3; i++) {
        a[`shared_b_wins_${i}`] = 5;
        b[`shared_b_wins_${i}`] = 10;
      }
      // Fill remaining with unique keys
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE - 6; i++) {
        a[`a_only_${i}`] = 100;
        b[`b_only_${i}`] = 100;
      }

      expect(compareVectorClocks(a, b)).toBe('CONCURRENT');
    });

    it('should use ALL keys when only one clock is at MAX_VECTOR_CLOCK_SIZE', () => {
      const a: Record<string, number> = {};
      // a has MAX keys
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE; i++) {
        a[`client_${i}`] = 10;
      }
      // b has fewer keys, with one key not in a
      const b: Record<string, number> = { client_0: 5, extra_client: 100 };

      // Since only a is at MAX, all keys are used
      // a has client_0..client_9 at 10, extra_client at 0 (missing)
      // b has client_0 at 5, extra_client at 100, client_1..9 at 0
      // a > b on client_0..9, b > a on extra_client => CONCURRENT
      expect(compareVectorClocks(a, b)).toBe('CONCURRENT');
    });

    it('should use ALL keys when neither clock is at MAX_VECTOR_CLOCK_SIZE', () => {
      const a = { x: 5 };
      const b = { y: 5 };

      // Both small clocks, all keys used
      // a: x=5, y=0 -> aGreater on x
      // b: x=0, y=5 -> bGreater on y
      expect(compareVectorClocks(a, b)).toBe('CONCURRENT');
    });

    it('should return CONCURRENT when both clocks at MAX but completely disjoint keys', () => {
      const a = buildMaxClock('a_client', 1);
      const b = buildMaxClock('b_client', 1);

      // No shared keys at all — independent client populations
      expect(Object.keys(a).length).toBe(MAX_VECTOR_CLOCK_SIZE);
      expect(Object.keys(b).length).toBe(MAX_VECTOR_CLOCK_SIZE);
      expect(compareVectorClocks(a, b)).toBe('CONCURRENT');
    });

    it('should use ALL keys when one clock is at MAX and other is at MAX-1', () => {
      // a has exactly MAX entries
      const a: Record<string, number> = {};
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE; i++) {
        a[`client_${i}`] = 10;
      }
      // b has MAX-1 entries with one unique key
      const b: Record<string, number> = {};
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE - 2; i++) {
        b[`client_${i}`] = 5;
      }
      b['unique_b'] = 100;

      // Only a is at MAX, so all keys are used (no pruning-aware mode)
      // a > b on shared client keys, b > a on unique_b => CONCURRENT
      expect(Object.keys(a).length).toBe(MAX_VECTOR_CLOCK_SIZE);
      expect(Object.keys(b).length).toBe(MAX_VECTOR_CLOCK_SIZE - 1);
      expect(compareVectorClocks(a, b)).toBe('CONCURRENT');
    });

    it('should use pruning-aware mode when both clocks exceed MAX (more than MAX entries)', () => {
      // This tests the >= condition — clocks larger than MAX (e.g., from merge before pruning)
      const a: Record<string, number> = {};
      const b: Record<string, number> = {};
      for (let i = 0; i < 3; i++) {
        a[`shared_${i}`] = 10;
        b[`shared_${i}`] = 5;
      }
      for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE; i++) {
        a[`a_only_${i}`] = 100;
        b[`b_only_${i}`] = 100;
      }

      // Both exceed MAX, pruning-aware mode → only shared keys compared → a dominates
      expect(Object.keys(a).length).toBeGreaterThan(MAX_VECTOR_CLOCK_SIZE);
      expect(Object.keys(b).length).toBeGreaterThan(MAX_VECTOR_CLOCK_SIZE);
      expect(compareVectorClocks(a, b)).toBe('GREATER_THAN');
    });
  });
});

describe('limitVectorClockSize', () => {
  it('should return unchanged when within limit', () => {
    const clock = { a: 1, b: 2, c: 3 };
    const result = limitVectorClockSize(clock);
    expect(result).toBe(clock); // Same reference
  });

  it('should return unchanged when exactly at limit', () => {
    const clock: Record<string, number> = {};
    for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE; i++) {
      clock[`client_${i}`] = i + 1;
    }
    const result = limitVectorClockSize(clock);
    expect(result).toBe(clock);
  });

  it('should prune to MAX keeping highest-counter clients', () => {
    const clock: Record<string, number> = {};
    for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE + 5; i++) {
      clock[`client_${i}`] = i + 1;
    }

    const result = limitVectorClockSize(clock);
    expect(Object.keys(result).length).toBe(MAX_VECTOR_CLOCK_SIZE);

    // The lowest-counter clients should be pruned
    // client_0 (1), client_1 (2), ..., client_4 (5) should be pruned
    for (let i = 0; i < 5; i++) {
      expect(result[`client_${i}`]).toBeUndefined();
    }
    // Higher-counter clients should be kept
    for (let i = 5; i < MAX_VECTOR_CLOCK_SIZE + 5; i++) {
      expect(result[`client_${i}`]).toBe(i + 1);
    }
  });

  it('should preserve specified client IDs even with low counters', () => {
    const clock: Record<string, number> = { lowClient: 1 };
    for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE + 5; i++) {
      clock[`high_${i}`] = 100 + i;
    }

    const result = limitVectorClockSize(clock, ['lowClient']);
    expect(Object.keys(result).length).toBe(MAX_VECTOR_CLOCK_SIZE);
    expect(result['lowClient']).toBe(1);
  });

  it('should handle empty preserveClientIds', () => {
    const clock: Record<string, number> = {};
    for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE + 3; i++) {
      clock[`client_${i}`] = i + 1;
    }

    const result = limitVectorClockSize(clock, []);
    expect(Object.keys(result).length).toBe(MAX_VECTOR_CLOCK_SIZE);
  });

  it('should handle preserveClientIds not present in clock', () => {
    const clock: Record<string, number> = {};
    for (let i = 0; i < MAX_VECTOR_CLOCK_SIZE + 3; i++) {
      clock[`client_${i}`] = i + 1;
    }

    const result = limitVectorClockSize(clock, ['nonexistent']);
    expect(Object.keys(result).length).toBe(MAX_VECTOR_CLOCK_SIZE);
    expect(result['nonexistent']).toBeUndefined();
  });
});

describe('mergeVectorClocks', () => {
  it('should merge by taking max of each key', () => {
    const a = { x: 3, y: 1 };
    const b = { x: 1, y: 5 };
    expect(mergeVectorClocks(a, b)).toEqual({ x: 3, y: 5 });
  });

  it('should include keys only present in one clock', () => {
    const a = { x: 3 };
    const b = { y: 5 };
    expect(mergeVectorClocks(a, b)).toEqual({ x: 3, y: 5 });
  });

  it('should handle one empty clock', () => {
    const a = { x: 3, y: 1 };
    expect(mergeVectorClocks(a, {})).toEqual({ x: 3, y: 1 });
    expect(mergeVectorClocks({}, a)).toEqual({ x: 3, y: 1 });
  });

  it('should handle both empty clocks', () => {
    expect(mergeVectorClocks({}, {})).toEqual({});
  });
});
