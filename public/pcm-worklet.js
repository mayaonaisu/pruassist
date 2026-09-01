// AudioWorklet processor for in-person capture. Deliberately dumb: it batches the mono microphone
// input (delivered in 128-sample render quanta) into ~2048-sample frames and posts each to the main
// thread, where the tested pcm.ts resamples to 16 kHz and encodes little-endian linear16 for Deepgram.
// No resampling or format logic lives here, so nothing untestable ships in the worklet. Served as a
// static file from /public so there is no bundler step and no blob-URL (which WebKit has historically
// mishandled for worklets).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true; // no input connected this quantum — keep the processor alive
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n === this._buf.length) {
        const frame = this._buf.slice(0, this._n); // a fresh copy so the buffer can be transferred
        this.port.postMessage(frame, [frame.buffer]);
        this._n = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
