export interface BusEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export type EventHandler = (event: BusEvent) => void;
export type Unsubscribe = () => void;

export interface EventBus {
  subscribe(channel: string, handler: EventHandler): Unsubscribe;
  unsubscribe(channel: string, handler: EventHandler): void;
  publish(channel: string, event: BusEvent): void;
  close?(): Promise<void>;
}

export class InMemoryEventBus implements EventBus {
  protected readonly subscriptions = new Map<string, Set<EventHandler>>();

  subscribe(channel: string, handler: EventHandler): Unsubscribe {
    const handlers = this.subscriptions.get(channel) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.subscriptions.set(channel, handlers);

    return () => {
      this.unsubscribe(channel, handler);
    };
  }

  unsubscribe(channel: string, handler: EventHandler): void {
    const handlers = this.subscriptions.get(channel);

    if (!handlers) {
      return;
    }

    handlers.delete(handler);

    if (handlers.size === 0) {
      this.subscriptions.delete(channel);
    }
  }

  publish(channel: string, event: BusEvent): void {
    this.dispatch(channel, event);
  }

  protected dispatch(channel: string, event: BusEvent): void {
    const handlers = this.subscriptions.get(channel);

    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('EventBus handler failed:', error);
      }
    }
  }
}

export class RedisEventBus extends InMemoryEventBus {
  private readonly url: string;
  private readonly prefix: string;
  private readonly remoteSubscriptions = new Set<string>();
  private readonly closeSignals = new Set<() => Promise<void>>();
  private publisher: any = null;
  private subscriber: any = null;
  private started = false;
  private startPromise: Promise<void> | null = null;

  constructor(config: { url: string; prefix?: string }) {
    super();
    this.url = config.url;
    this.prefix = config.prefix || 'dashboard';
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.init();
    return this.startPromise;
  }

  subscribe(channel: string, handler: EventHandler): Unsubscribe {
    const unsubscribe = super.subscribe(channel, handler);
    void this.ensureRemoteSubscribed(channel);

    return () => {
      unsubscribe();
      void this.ensureRemoteUnsubscribed(channel);
    };
  }

  publish(channel: string, event: BusEvent): void {
    super.publish(channel, event);
    void this.publishRemote(channel, event);
  }

  async close(): Promise<void> {
    for (const closeSignal of this.closeSignals) {
      await closeSignal().catch(() => undefined);
    }

    this.closeSignals.clear();
    this.started = false;
    this.startPromise = null;
  }

  private async init(): Promise<void> {
    const moduleName = 'redis';
    const redis = await import(moduleName).catch((error) => {
      console.error('Redis package is not installed. Install `redis` to enable EVENT_BUS_TYPE=redis.', error);
      throw error;
    });
    const createClient = redis.createClient;
    const publisher = createClient({ url: this.url });
    const subscriber = createClient({ url: this.url });

    await publisher.connect();
    await subscriber.connect();

    this.publisher = publisher;
    this.subscriber = subscriber;
    this.started = true;

    this.closeSignals.add(async () => {
      await subscriber.quit().catch(() => undefined);
      await publisher.quit().catch(() => undefined);
    });

    for (const channel of this.subscriptions.keys()) {
      await this.subscribeRemote(channel);
    }
  }

  private async publishRemote(channel: string, event: BusEvent): Promise<void> {
    if (!this.publisher) {
      await this.start().catch((error) => {
        console.error('Redis EventBus startup failed:', error);
      });
    }

    if (!this.publisher) {
      return;
    }

    await this.publisher.publish(this.toRedisChannel(channel), JSON.stringify(event)).catch((error) => {
      console.error('Redis EventBus publish failed:', error);
    });
  }

  private async ensureRemoteSubscribed(channel: string): Promise<void> {
    if (!this.subscriber) {
      await this.start().catch((error) => {
        console.error('Redis EventBus startup failed:', error);
      });
    }

    if (!this.subscriber) {
      return;
    }

    await this.subscribeRemote(channel);
  }

  private async subscribeRemote(channel: string): Promise<void> {
    if (!this.subscriber || this.remoteSubscriptions.has(channel)) {
      return;
    }

    const redisChannel = this.toRedisChannel(channel);
    await this.subscriber.subscribe(redisChannel, (payload: string) => {
      let parsed: BusEvent | null = null;

      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = null;
      }

      if (!parsed || typeof parsed !== 'object') {
        return;
      }

      this.dispatch(channel, parsed);
    });
    this.remoteSubscriptions.add(channel);
  }

  private async ensureRemoteUnsubscribed(channel: string): Promise<void> {
    if (!this.subscriber || this.subscriptions.get(channel)?.size) {
      return;
    }

    if (!this.remoteSubscriptions.has(channel)) {
      return;
    }

    await this.subscriber.unsubscribe(this.toRedisChannel(channel)).catch(() => undefined);
    this.remoteSubscriptions.delete(channel);
  }

  private toRedisChannel(channel: string): string {
    return this.prefix + ':' + channel;
  }
}

export async function createEventBus(config: { type?: string; redisUrl?: string }): Promise<EventBus> {
  const busType = String(config.type || 'emitter').trim().toLowerCase();

  if (busType === 'redis') {
    if (!config.redisUrl) {
      console.warn('EVENT_BUS_TYPE=redis but REDIS_URL is not configured. Falling back to in-memory event bus.');
      return new InMemoryEventBus();
    }

    const bus = new RedisEventBus({ url: config.redisUrl });
    await bus.start().catch((error) => {
      console.error('Failed to initialize Redis event bus, using in-memory bus:', error);
      throw error;
    });
    return bus;
  }

  if (busType !== 'emitter' && busType !== 'memory') {
    console.warn('Unknown EVENT_BUS_TYPE "' + busType + '". Falling back to in-memory event bus.');
  }

  return new InMemoryEventBus();
}
