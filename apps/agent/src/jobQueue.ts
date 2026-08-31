// §F-1 Processing Queue / §E Job Queue & Worker Pool — bounds how many file
// operations run concurrently (default 2, via AgentConfig.maxConcurrentFileOps) so
// that several large video moves landing at once don't saturate a NAS connection.
// Each submitted task is fully isolated: one task's rejection never affects any
// other task's execution or resolution (§F-1 Failure Isolation).

export class JobWorkerPool {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly concurrency: number) {
    if (concurrency < 1) throw new Error("concurrency must be >= 1");
  }

  submit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.drain();
          });
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}
