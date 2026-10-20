// Audition a bounded window of the actual encoded File through one native media
// element. Keep only one deadline timer, and treat native seeks as user control.
export class MediaWindowPlayer {
  constructor(audio, { onChange = () => {}, onManualSeek = () => {}, onError = () => {} } = {}) {
    this.audio = audio;
    this.onChange = onChange;
    this.onManualSeek = onManualSeek;
    this.onError = onError;
    this.window = null;
    this.looping = false;
    this.timer = null;
    this.version = 0;
    this.seekTarget = null;
    audio.addEventListener('play', () => {
      this.completed = false;
      if (this.window && audio.currentTime >= this.window.end) this.seek(this.window.start);
      this.schedule();
      this.onChange();
    });
    audio.addEventListener('pause', () => {
      this.clearTimer();
      this.onChange();
    });
    for (const type of ['timeupdate', 'ratechange', 'ended']) audio.addEventListener(type, () => this.schedule());
    audio.addEventListener('seeking', () => {
      this.clearTimer();
      if (this.seekTarget !== null && Math.abs(audio.currentTime - this.seekTarget) < 0.05) return;
      this.stop();
      this.onManualSeek();
    });
    audio.addEventListener('seeked', () => {
      this.seekTarget = null;
      this.schedule();
      this.onChange();
    });
    audio.addEventListener('error', () => this.stop());
  }
  clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }
  seek(time) {
    this.seekTarget = time;
    this.audio.currentTime = time;
  }
  play() {
    const version = this.version;
    this.audio.play().catch((error) => {
      if (version === this.version && error.name !== 'AbortError') {
        this.stop();
        this.onError();
      }
    });
  }
  start(window, { loop = false, play = true } = {}) {
    this.clearTimer();
    this.version++;
    this.window = window;
    this.looping = loop;
    this.completed = false;
    this.seek(window.start);
    if (play) this.play();
    else this.audio.pause();
    this.schedule();
    this.onChange();
  }
  stop({ pause = false } = {}) {
    this.clearTimer();
    this.version++;
    this.window = null;
    this.looping = false;
    this.seekTarget = null;
    if (pause) this.audio.pause();
    this.onChange();
  }
  schedule() {
    this.clearTimer();
    const audio = this.audio,
      window = this.window;
    if (!window || audio.seeking || audio.error || (audio.paused && (!audio.ended || this.completed))) return;
    const remaining = window.end - audio.currentTime;
    if (remaining <= 0 || audio.ended) {
      if (this.looping) {
        this.seek(window.start);
        if (audio.paused) this.play();
      } else {
        this.completed = true;
        audio.pause();
        this.seek(window.end);
      }
      this.onChange();
      return;
    }
    const version = this.version;
    this.timer = setTimeout(
      () => {
        if (version === this.version) this.schedule();
      },
      Math.max(10, (remaining * 1000) / Math.max(0.1, audio.playbackRate || 1)),
    );
  }
}
