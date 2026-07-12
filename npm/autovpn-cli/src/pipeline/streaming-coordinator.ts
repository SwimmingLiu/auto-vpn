interface WorkerPoolOptions<T> {
  concurrency: number;
  capacity: number;
  worker: (item: T) => Promise<void>;
}

interface Admission<T> {
  item: T;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface DrainWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class AsyncPermitPool {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('permit limit must be a positive integer');
    this.available = limit;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.available += 1;
  }
}

export class BoundedWorkerPool<T> {
  private readonly concurrency: number;
  private readonly limit: number;
  private readonly worker: (item: T) => Promise<void>;
  private readonly queue: T[] = [];
  private readonly admissionWaiters: Admission<T>[] = [];
  private readonly drainWaiters: DrainWaiter[] = [];
  private active = 0;
  private closed = false;
  private failure: unknown;
  private failed = false;

  constructor(options: WorkerPoolOptions<T>) {
    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
      throw new RangeError('concurrency must be a positive integer');
    }
    if (!Number.isInteger(options.capacity) || options.capacity < 0) {
      throw new RangeError('capacity must be a non-negative integer');
    }
    this.concurrency = options.concurrency;
    this.limit = options.concurrency + options.capacity;
    this.worker = options.worker;
  }

  submit(item: T): Promise<void> {
    if (this.failed) {
      return Promise.reject(this.failure);
    }
    if (this.closed) {
      return Promise.reject(new Error('worker pool is closed'));
    }
    if (this.active + this.queue.length < this.limit) {
      this.accept(item);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.admissionWaiters.push({ item, resolve, reject });
    });
  }

  close(): void {
    this.closed = true;
    this.settleDrainWaitersIfIdle();
  }

  drain(): Promise<void> {
    if (this.isIdle()) {
      return this.failed ? Promise.reject(this.failure) : Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.drainWaiters.push({ resolve, reject });
    });
  }

  abort(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.failure = error;
    }
    this.closed = true;
    this.queue.length = 0;
    this.rejectAdmissionWaiters(this.failure);
    this.settleDrainWaitersIfIdle();
  }

  private accept(item: T): void {
    if (this.active < this.concurrency) {
      this.start(item);
    } else {
      this.queue.push(item);
    }
  }

  private start(item: T): void {
    this.active += 1;
    Promise.resolve()
      .then(() => this.worker(item))
      .catch((error: unknown) => this.recordFailure(error))
      .finally(() => {
        this.active -= 1;
        if (!this.failed) {
          this.fillAvailableSlots();
        }
        this.settleDrainWaitersIfIdle();
      });
  }

  private fillAvailableSlots(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      this.start(this.queue.shift() as T);
    }
    while (this.active + this.queue.length < this.limit && this.admissionWaiters.length > 0) {
      const admission = this.admissionWaiters.shift() as Admission<T>;
      this.accept(admission.item);
      admission.resolve();
    }
  }

  private recordFailure(error: unknown): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.failure = error;
    this.closed = true;
    this.queue.length = 0;
    this.rejectAdmissionWaiters(error);
  }

  private rejectAdmissionWaiters(error: unknown): void {
    for (const admission of this.admissionWaiters.splice(0)) {
      admission.reject(error);
    }
  }

  private isIdle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  private settleDrainWaitersIfIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    for (const waiter of this.drainWaiters.splice(0)) {
      if (this.failed) {
        waiter.reject(this.failure);
      } else {
        waiter.resolve();
      }
    }
  }
}
