class CaptionPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.period = sampleRate / 16000;
    this.remaining = this.period;
    this.sum = 0;
    this.pcm = new Int16Array(640); // 40 ms of mono PCM16.
    this.index = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i];
      value /= channels.length;
      let left = 1;
      while (left > 1e-8) {
        const portion = Math.min(left, this.remaining);
        this.sum += value * portion;
        this.remaining -= portion;
        left -= portion;
        if (this.remaining < 1e-8) {
          this.pcm[this.index++] = Math.round(Math.max(-1, Math.min(1, this.sum / this.period)) * 32767);
          this.sum = 0;
          this.remaining = this.period;
          if (this.index === this.pcm.length) {
            this.port.postMessage(this.pcm.buffer, [this.pcm.buffer]);
            this.pcm = new Int16Array(640);
            this.index = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("caption-pcm", CaptionPcm);
