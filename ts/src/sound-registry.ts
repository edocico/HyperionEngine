import type { SoundHandle } from './audio-types';

export type AudioDecoder = (data: ArrayBuffer) => Promise<AudioBuffer>;
export type AudioFetcher = (url: string) => Promise<ArrayBuffer>;

export class SoundRegistry {
  private readonly decoder: AudioDecoder;
  private readonly fetcher: AudioFetcher;
  private readonly buffers = new Map<SoundHandle, AudioBuffer>();
  private readonly urlToHandle = new Map<string, SoundHandle>();
  private nextHandle = 0;

  constructor(decoder: AudioDecoder, fetcher: AudioFetcher) {
    this.decoder = decoder;
    this.fetcher = fetcher;
  }

  async load(url: string): Promise<SoundHandle> {
    const existing = this.urlToHandle.get(url);
    if (existing !== undefined) return existing;

    const data = await this.fetcher(url);
    const buffer = await this.decoder(data);
    const handle = this.nextHandle++ as SoundHandle;
    this.buffers.set(handle, buffer);
    this.urlToHandle.set(url, handle);
    return handle;
  }

  getBuffer(handle: SoundHandle): AudioBuffer | undefined {
    return this.buffers.get(handle);
  }

  get count(): number {
    return this.buffers.size;
  }
}
