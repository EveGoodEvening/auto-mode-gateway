import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBroker, type ApprovalSubject } from '../../src/approval/broker.js';

const subject: ApprovalSubject = { tool: 'Bash', kind: 'command', text: 'npm install inert', paths: [], escalation: 'gray-no-reviewer' };
afterEach(() => { vi.useRealTimers(); });

describe('ApprovalBroker', () => {
  it('lists pending requests in creation order and settles exactly once on decision', async () => {
    let clock = 1000;
    const broker = new ApprovalBroker({ timeout_ms: 500, max_pending: 5, now: () => clock });
    const first = broker.request(subject);
    clock = 1001;
    const second = broker.request({ ...subject, tool: 'Write' });
    const [a, b] = broker.list();
    expect(a).toMatchObject({ created_at: 1000, expires_at: 1500, subject });
    expect(b?.subject.tool).toBe('Write');
    expect(broker.decide(a!.id, 'allow')).toBe(true);
    expect(broker.decide(a!.id, 'block')).toBe(false);
    expect(await first).toMatchObject({ status: 'decided', decision: 'allow' });
    expect(broker.decide(b!.id, 'block')).toBe(true);
    expect(await second).toMatchObject({ status: 'decided', decision: 'block' });
    expect(broker.size).toBe(0);
    expect(broker.recent().map((item) => item.result)).toEqual(['block', 'allow']);
  });

  it('returns false for unknown ids', () => {
    expect(new ApprovalBroker({ timeout_ms: 500, max_pending: 5 }).decide('nope', 'allow')).toBe(false);
  });

  it('times out', async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker({ timeout_ms: 500, max_pending: 5 });
    const pending = broker.request(subject);
    await vi.advanceTimersByTimeAsync(499);
    expect(broker.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: 'timeout' });
    expect(broker.recent()[0]?.result).toBe('timeout');
  });

  it('aborts on a pre-aborted or later-aborted signal', async () => {
    const broker = new ApprovalBroker({ timeout_ms: 5000, max_pending: 5 });
    expect(await broker.request(subject, AbortSignal.abort())).toEqual({ status: 'aborted' });
    expect(broker.size).toBe(0);
    const controller = new AbortController();
    const pending = broker.request(subject, controller.signal);
    expect(broker.size).toBe(1);
    controller.abort();
    expect(await pending).toEqual({ status: 'aborted' });
    expect(broker.size).toBe(0);
  });

  it('rejects when the queue is full', async () => {
    const broker = new ApprovalBroker({ timeout_ms: 5000, max_pending: 1 });
    void broker.request(subject);
    expect(await broker.request(subject)).toEqual({ status: 'rejected' });
    broker.close();
  });

  it('close settles pending as aborted and rejects later requests', async () => {
    const broker = new ApprovalBroker({ timeout_ms: 5000, max_pending: 5 });
    const pending = broker.request(subject);
    broker.close();
    expect(await pending).toEqual({ status: 'aborted' });
    expect(await broker.request(subject)).toEqual({ status: 'rejected' });
    expect(broker.size).toBe(0);
  });

  it('notifies subscribers, isolates throwing listeners and supports unsubscribe', async () => {
    const broker = new ApprovalBroker({ timeout_ms: 5000, max_pending: 5 });
    const listener = vi.fn();
    broker.subscribe(() => { throw new Error('ui failure'); });
    const unsubscribe = broker.subscribe(listener);
    const pending = broker.request(subject);
    expect(listener).toHaveBeenCalledTimes(1);
    broker.decide(broker.list()[0]!.id, 'allow');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(await pending).toMatchObject({ status: 'decided', decision: 'allow' });
    unsubscribe();
    void broker.request(subject);
    expect(listener).toHaveBeenCalledTimes(2);
    broker.close();
  });

  it('bounds history and returns copies', () => {
    const broker = new ApprovalBroker({ timeout_ms: 5000, max_pending: 10, history_limit: 2 });
    for (let index = 0; index < 3; index++) {
      void broker.request({ ...subject, tool: `t${index}` });
      broker.decide(broker.list()[0]!.id, 'block');
    }
    const recent = broker.recent();
    expect(recent.map((item) => item.subject.tool)).toEqual(['t2', 't1']);
    recent[0]!.result = 'allow';
    expect(broker.recent()[0]?.result).toBe('block');
  });
});
