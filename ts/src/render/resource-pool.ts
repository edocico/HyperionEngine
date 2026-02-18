export class ResourcePool {
  private buffers = new Map<string, GPUBuffer>();
  private textures = new Map<string, GPUTexture>();
  private textureViews = new Map<string, GPUTextureView>();
  private samplers = new Map<string, GPUSampler>();

  setBuffer(name: string, buffer: GPUBuffer): void {
    this.buffers.set(name, buffer);
  }

  getBuffer(name: string): GPUBuffer | undefined {
    return this.buffers.get(name);
  }

  setTexture(name: string, texture: GPUTexture): void {
    this.textures.set(name, texture);
  }

  getTexture(name: string): GPUTexture | undefined {
    return this.textures.get(name);
  }

  setTextureView(name: string, view: GPUTextureView): void {
    this.textureViews.set(name, view);
  }

  getTextureView(name: string): GPUTextureView | undefined {
    return this.textureViews.get(name);
  }

  setSampler(name: string, sampler: GPUSampler): void {
    this.samplers.set(name, sampler);
  }

  getSampler(name: string): GPUSampler | undefined {
    return this.samplers.get(name);
  }

  destroy(): void {
    for (const buf of this.buffers.values()) buf.destroy();
    for (const tex of this.textures.values()) tex.destroy();
    this.buffers.clear();
    this.textures.clear();
    this.textureViews.clear();
    this.samplers.clear();
  }
}
