import { describe, expect, it, vi } from 'vitest';
import { reportSessionAnswer, subscribeSessionAnswers } from './sessionAnswers';

describe('sessionAnswers', () => {
  it('delivers an answer to every subscriber and stops after unsubscribe', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeSessionAnswers(a);
    const offB = subscribeSessionAnswers(b);
    reportSessionAnswer({ sessionKey: 'k', verdict: 'valid' });
    expect(a).toHaveBeenCalledWith({ sessionKey: 'k', verdict: 'valid' });
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    reportSessionAnswer({ sessionKey: 'k', verdict: 'invalid' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
  });

  it('a throwing subscriber can neither break the caller nor starve the others', () => {
    const good = vi.fn();
    const off1 = subscribeSessionAnswers(() => {
      throw new Error('boom');
    });
    const off2 = subscribeSessionAnswers(good);
    expect(() => reportSessionAnswer({ sessionKey: 'k', verdict: 'valid' })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    off1();
    off2();
  });
});
