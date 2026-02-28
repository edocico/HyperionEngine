import { describe, it, expect } from 'vitest';
import { TexturePriorityQueue } from './texture-manager';

describe('TexturePriorityQueue', () => {
  it('dequeues highest priority (lowest distance) first', () => {
    const queue = new TexturePriorityQueue();
    queue.enqueue('url-far', 100);
    queue.enqueue('url-near', 5);
    queue.enqueue('url-mid', 50);

    expect(queue.dequeue()).toBe('url-near');
    expect(queue.dequeue()).toBe('url-mid');
    expect(queue.dequeue()).toBe('url-far');
  });

  it('returns null when empty', () => {
    const queue = new TexturePriorityQueue();
    expect(queue.dequeue()).toBeNull();
  });

  it('reheap updates order after priority changes', () => {
    const queue = new TexturePriorityQueue();
    queue.enqueue('url-a', 100);
    queue.enqueue('url-b', 50);
    queue.enqueue('url-c', 200);

    // Change priorities: url-c is now closest
    queue.updatePriority('url-c', 1);
    queue.updatePriority('url-a', 150);

    expect(queue.dequeue()).toBe('url-c');
    expect(queue.dequeue()).toBe('url-b');
    expect(queue.dequeue()).toBe('url-a');
  });

  it('reports correct size', () => {
    const queue = new TexturePriorityQueue();
    expect(queue.size).toBe(0);
    queue.enqueue('a', 1);
    expect(queue.size).toBe(1);
    queue.dequeue();
    expect(queue.size).toBe(0);
  });

  it('enqueue with existing url updates priority instead of duplicating', () => {
    const queue = new TexturePriorityQueue();
    queue.enqueue('url-a', 100);
    queue.enqueue('url-b', 50);
    queue.enqueue('url-a', 10); // re-enqueue with higher priority

    expect(queue.size).toBe(2);
    expect(queue.dequeue()).toBe('url-a');
    expect(queue.dequeue()).toBe('url-b');
  });

  it('updatePriority on unknown url is a no-op', () => {
    const queue = new TexturePriorityQueue();
    queue.enqueue('url-a', 50);
    queue.updatePriority('url-nonexistent', 1);
    expect(queue.size).toBe(1);
    expect(queue.dequeue()).toBe('url-a');
  });

  it('peek returns top element without removing it', () => {
    const queue = new TexturePriorityQueue();
    queue.enqueue('url-a', 10);
    queue.enqueue('url-b', 5);
    expect(queue.peek()).toBe('url-b');
    expect(queue.size).toBe(2); // not removed
    expect(queue.peek()).toBe('url-b'); // stable
  });

  it('peek returns null when empty', () => {
    const queue = new TexturePriorityQueue();
    expect(queue.peek()).toBeNull();
  });

  it('clear removes all entries', () => {
    const queue = new TexturePriorityQueue();
    queue.enqueue('a', 1);
    queue.enqueue('b', 2);
    queue.enqueue('c', 3);
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeNull();
  });

  it('handles large number of entries correctly', () => {
    const queue = new TexturePriorityQueue();
    const count = 1000;
    for (let i = 0; i < count; i++) {
      queue.enqueue(`url-${i}`, Math.random() * 10000);
    }
    expect(queue.size).toBe(count);

    // Verify the queue drains completely and each dequeue returns a valid URL
    for (let i = 0; i < count; i++) {
      const url = queue.dequeue();
      expect(url).not.toBeNull();
    }
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeNull();
  });
});
