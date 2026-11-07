// Recorder worklet of the deck golden renders (owner: deck): a k-rate "ratio"
// parameter with EXACTLY the descriptor of src/js/pitch-worklet.js, written
// to every output sample, so the golden render captures the value Chromium
// computed for each 128-frame render quantum (the value pitch-worklet.js read
// as params.ratio[0] under the same automation).
class RatioRecorder extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  process(inputs, outputs, params) {
    const v = params.ratio[0];
    for (const ch of outputs[0]) ch.fill(v);
    return true;
  }
}

registerProcessor('ratio-recorder', RatioRecorder);
