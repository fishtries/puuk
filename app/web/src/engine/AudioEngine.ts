import { AudioEngineEventMap, PlaybackStatus } from '../types/player';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener<T> = (data: T) => void;

export interface AudioLoadOptions {
  autoplay?: boolean;
  normalizationGainDb?: number;
}

export const MIN_NORMALIZATION_GAIN_DB = -12.0;
export const MAX_NORMALIZATION_GAIN_DB = 12.0;
export const MAX_EFFECTIVE_GAIN = Math.pow(10, MAX_NORMALIZATION_GAIN_DB / 20); // ~3.98107

export type WebAudioStatus = 'idle' | 'active' | 'unavailable';

export class AudioEngine {
  public static readonly MIN_GAIN_DB = MIN_NORMALIZATION_GAIN_DB;
  public static readonly MAX_GAIN_DB = MAX_NORMALIZATION_GAIN_DB;
  public static readonly MAX_GAIN_LINEAR = MAX_EFFECTIVE_GAIN;

  private static instance: AudioEngine | null = null;
  private audio: HTMLAudioElement;
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private isInitialized = false;
  private webAudioStatus: WebAudioStatus = 'idle';
  private status: PlaybackStatus = 'idle';
  private rafId: number | null = null;
  private userVolume = 1;
  private normalizationGainDb = 0;
  private isMuted = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners: Map<keyof AudioEngineEventMap, Set<Listener<any>>> = new Map();

  private constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.audio.crossOrigin = 'anonymous';
    this.setupAudioListeners();
  }

  public static getInstance(): AudioEngine {
    if (!AudioEngine.instance) {
      AudioEngine.instance = new AudioEngine();
    }
    return AudioEngine.instance;
  }

  private initAudioContext(): boolean {
    if (this.isInitialized) return true;

    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) throw new Error('Web Audio API is not supported');

      // Частичная инициализация из прошлой попытки переиспользуется: узлы создаются
      // только при отсутствии, а createMediaElementSource допустим ровно один раз
      // на элемент (повторный вызов бросает InvalidStateError).
      if (!this.audioContext) {
        this.audioContext = new AudioContextClass();
      }
      if (!this.gainNode) {
        this.gainNode = this.audioContext.createGain();
      }
      if (!this.analyserNode) {
        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = 128;
        this.analyserNode.smoothingTimeConstant = 0.8;
      }
      if (!this.sourceNode) {
        this.sourceNode = this.audioContext.createMediaElementSource(this.audio);
        this.sourceNode.connect(this.gainNode);
        this.gainNode.connect(this.analyserNode);
        this.analyserNode.connect(this.audioContext.destination);
      }

      this.isInitialized = true;
      this.webAudioStatus = 'active';
      this.applyEffectiveGain(false);
      return true;
    } catch (e) {
      if (this.webAudioStatus !== 'unavailable') {
        console.warn('Web Audio API init failed, falling back to element volume:', e);
      }
      this.webAudioStatus = 'unavailable';
      return false;
    }
  }

  private async resumeAudioContext(): Promise<void> {
    if (!this.audioContext || this.audioContext.state !== 'suspended') return;
    try {
      await this.audioContext.resume();
    } catch (e) {
      console.warn('AudioContext resume failed:', e);
    }
  }

  private setupAudioListeners(): void {
    this.audio.addEventListener('play', () => {
      this.setStatus('playing');
      this.startTimeLoop();
    });

    this.audio.addEventListener('pause', () => {
      if (this.status !== 'loading') {
        this.setStatus('paused');
      }
      this.stopTimeLoop();
    });

    this.audio.addEventListener('ended', () => {
      this.setStatus('idle');
      this.stopTimeLoop();
      this.emit('ended', undefined as void);
    });

    this.audio.addEventListener('waiting', () => {
      this.setStatus('loading');
    });

    this.audio.addEventListener('canplay', () => {
      if (this.status === 'loading') {
        this.setStatus('playing');
      }
    });

    this.audio.addEventListener('error', () => {
      const errMsg = this.audio.error?.message || 'Audio playback error';
      this.setStatus('error');
      this.stopTimeLoop();
      this.emit('error', { message: errMsg });
    });
  }

  private setStatus(status: PlaybackStatus): void {
    this.status = status;
    this.emit('statuschange', { status });
  }

  private startTimeLoop(): void {
    this.stopTimeLoop();
    const tick = () => {
      if (this.audio && !this.audio.paused) {
        this.emit('timeupdate', {
          currentTime: this.audio.currentTime,
          duration: this.audio.duration || 0,
        });

        if (this.analyserNode) {
          const bufferLength = this.analyserNode.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          this.analyserNode.getByteFrequencyData(dataArray);
          this.emit('analyserdata', { frequencyData: dataArray });
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopTimeLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public static clampGainDb(gainDb: number): number {
    if (isNaN(gainDb) || !isFinite(gainDb)) return 0;
    return Math.max(MIN_NORMALIZATION_GAIN_DB, Math.min(MAX_NORMALIZATION_GAIN_DB, gainDb));
  }

  public static dbToLinear(gainDb: number): number {
    if (isNaN(gainDb) || !isFinite(gainDb)) return 1.0;
    const clamped = AudioEngine.clampGainDb(gainDb);
    return Math.pow(10, clamped / 20);
  }

  public getEffectiveGain(): number {
    if (this.isMuted) return 0;
    const normLinear = AudioEngine.dbToLinear(this.normalizationGainDb);
    const raw = this.userVolume * normLinear;
    return Math.max(0, Math.min(MAX_EFFECTIVE_GAIN, raw));
  }

  public setUserVolume(val: number): void {
    const clamped = Math.max(0, Math.min(1, isNaN(val) ? 1 : val));
    this.userVolume = clamped;
    this.applyEffectiveGain();
  }

  public setNormalizationGainDb(gainDb: number, smooth = true): void {
    this.normalizationGainDb = AudioEngine.clampGainDb(gainDb);
    this.applyEffectiveGain(smooth);
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.applyEffectiveGain();
  }

  public getUserVolume(): number {
    return this.userVolume;
  }

  public getNormalizationGainDb(): number {
    return this.normalizationGainDb;
  }

  public getWebAudioStatus(): WebAudioStatus {
    return this.webAudioStatus;
  }

  /**
   * True, когда Web Audio недоступен и треку требуется усиление (>0 dB):
   * HTMLAudioElement.volume ограничен 1.0, поэтому boost в fallback-режиме
   * обрезается и нормализация считается неполной.
   */
  public isNormalizationDegraded(): boolean {
    return this.webAudioStatus !== 'active' && this.normalizationGainDb > 0.01;
  }

  public applyEffectiveGain(smooth = true): void {
    const effectiveGain = this.getEffectiveGain();

    if (this.isInitialized && this.gainNode && this.audioContext) {
      this.audio.volume = 1;
      const currentTime = this.audioContext.currentTime;
      this.gainNode.gain.cancelScheduledValues(currentTime);

      if (smooth) {
        this.gainNode.gain.setTargetAtTime(effectiveGain, currentTime, 0.06);
      } else {
        this.gainNode.gain.setValueAtTime(effectiveGain, currentTime);
      }
    } else {
      this.audio.volume = Math.max(0, Math.min(1, effectiveGain));
    }
  }

  public async load(
    url: string,
    options: boolean | AudioLoadOptions = true
  ): Promise<void> {
    const autoplay = typeof options === 'boolean' ? options : (options.autoplay ?? true);
    if (typeof options === 'object' && options.normalizationGainDb !== undefined) {
      this.normalizationGainDb = AudioEngine.clampGainDb(options.normalizationGainDb);
    }

    this.initAudioContext();
    await this.resumeAudioContext();

    this.applyEffectiveGain(true);

    this.setStatus('loading');
    this.audio.src = url;
    this.audio.load();

    if (autoplay) {
      try {
        await this.audio.play();
      } catch (err) {
        console.warn('Autoplay prevented or failed:', err);
        this.setStatus('paused');
      }
    }
  }

  public async play(): Promise<void> {
    this.initAudioContext();
    await this.resumeAudioContext();
    // Между stop() прежнего трека и load() нового источника нет: play() без
    // src бросил бы NotSupportedError и вешал на плеер статус 'error'.
    if (!this.audio.currentSrc) return;
    return this.audio.play();
  }

  /**
   * Немедленное отключение звучащего источника: пауза + сброс src. Вызывается
   * при переключении трека ДО запроса нового потока, чтобы прежняя дорожка не
   * звучала, пока готовится новый источник. Собственных событий статуса не
   * эмитит: store сам переводит трек в 'loading', а 'pause'-listener подавлен
   * внутренним loading-статусом.
   */
  public stop(): void {
    this.status = 'loading';
    this.audio.pause();
    this.audio.src = '';
    this.stopTimeLoop();
  }

  public pause(): void {
    this.audio.pause();
  }

  public seek(seconds: number): void {
    if (isFinite(seconds)) {
      this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration || seconds));
      this.emit('timeupdate', {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
    }
  }

  public setVolume(val: number): void {
    this.setUserVolume(val);
  }

  public getCurrentTime(): number {
    return this.audio.currentTime;
  }

  public getDuration(): number {
    return this.audio.duration || 0;
  }

  public getStatus(): PlaybackStatus {
    return this.status;
  }

  public getFrequencyData(): Uint8Array {
    if (!this.analyserNode) return new Uint8Array(32);
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(data);
    return data;
  }

  public getAudioContextState(): string {
    return this.audioContext ? this.audioContext.state : 'uninitialized';
  }

  public on<K extends keyof AudioEngineEventMap>(event: K, listener: Listener<AudioEngineEventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set.add(listener as Listener<any>);
    return () => {
      set.delete(listener as Listener<any>);
    };
  }

  private emit<K extends keyof AudioEngineEventMap>(event: K, data: AudioEngineEventMap[K]): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach((listener) => listener(data));
    }
  }

  public destroy(): void {
    this.stopTimeLoop();
    this.audio.pause();
    this.audio.src = '';
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    this.listeners.clear();
    this.audioContext = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.sourceNode = null;
    this.isInitialized = false;
    this.webAudioStatus = 'idle';
    AudioEngine.instance = null;
  }
}

export const audioEngine = AudioEngine.getInstance();
