export class SpatialAudioEngine {
    constructor(defaultPositions = {}) {
        this.defaultPositions = defaultPositions;
        this.context = null;
        this.master = null;
        this.tracks = [];
        this.duration = 0;
        this.offset = 0;
        this.startedAt = 0;
        this.playing = false;
    }

    async ensureContext() {
        if (!this.context) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) {
                throw new Error('This browser does not support Web Audio. Use a current Chrome, Edge, Firefox, or Safari release.');
            }
            this.context = new AudioContextClass();
            this.master = this.context.createGain();
            this.master.gain.value = 0.92;
            this.master.connect(this.context.destination);
            this.configureListener();
        }
        return this.context;
    }

    configureListener() {
        const listener = this.context.listener;
        if ('positionX' in listener) {
            listener.positionX.value = 0;
            listener.positionY.value = 0;
            listener.positionZ.value = 0;
            listener.forwardX.value = 0;
            listener.forwardY.value = 0;
            listener.forwardZ.value = -1;
            listener.upX.value = 0;
            listener.upY.value = 1;
            listener.upZ.value = 0;
        } else {
            listener.setPosition(0, 0, 0);
            listener.setOrientation(0, 0, -1, 0, 1, 0);
        }
    }

    async prepare(manifest, onProgress) {
        const context = await this.ensureContext();
        let completed = 0;
        return Promise.all(manifest.map(async item => {
            const response = await fetch(item.url, { cache: 'no-store', credentials: 'same-origin' });
            if (!response.ok) {
                throw new Error(`Could not load ${item.label} (${response.status}).`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const buffer = await context.decodeAudioData(arrayBuffer);
            completed += 1;
            onProgress?.(completed, manifest.length, item.label);
            return { ...item, buffer };
        }));
    }

    commit(prepared) {
        this.unload();
        this.tracks = prepared.map((item, index) => {
            const gain = this.context.createGain();
            const panner = this.context.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 1;
            panner.maxDistance = 9;
            panner.rolloffFactor = 0.48;
            panner.coneInnerAngle = 360;
            panner.coneOuterAngle = 360;
            gain.connect(panner);
            panner.connect(this.master);

            const fallbackAngle = ((index / Math.max(prepared.length, 1)) * Math.PI * 2) - Math.PI / 2;
            const fallbackPosition = { x: Math.cos(fallbackAngle) * 0.62, depth: Math.sin(fallbackAngle) * 0.62 };
            const position = this.defaultPositions[item.id] || fallbackPosition;
            const track = {
                ...item,
                gain,
                panner,
                source: null,
                x: position.x,
                depth: position.depth,
                elevation: 0,
                volume: 0.82,
                muted: false
            };
            this.applyGain(track, true);
            this.applyPosition(track, true);
            return track;
        });
        this.duration = this.tracks.length
            ? Math.min(...this.tracks.map(track => track.buffer.duration))
            : 0;
        this.offset = 0;
        this.startedAt = 0;
        this.playing = false;
        return this.tracks;
    }

    createSource(track) {
        const source = this.context.createBufferSource();
        source.buffer = track.buffer;
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = Math.min(this.duration, track.buffer.duration);
        source.connect(track.gain);
        return source;
    }

    async play() {
        if (!this.tracks.length || this.playing) return;
        await this.ensureContext();
        if (this.context.state === 'suspended') await this.context.resume();
        const when = this.context.currentTime + 0.055;
        const offset = this.duration ? this.offset % this.duration : 0;
        this.tracks.forEach(track => {
            const source = this.createSource(track);
            track.source = source;
            source.start(when, Math.min(offset, track.buffer.duration - 0.001));
        });
        this.startedAt = when;
        this.playing = true;
    }

    pause() {
        if (!this.playing) return;
        this.offset = this.currentTime();
        this.stopSources();
        this.playing = false;
    }

    stopSources() {
        this.tracks.forEach(track => {
            if (!track.source) return;
            try { track.source.stop(); } catch (_) { /* Source may already be stopped. */ }
            try { track.source.disconnect(); } catch (_) { /* Node may already be disconnected. */ }
            track.source = null;
        });
    }

    currentTime() {
        if (!this.duration) return 0;
        if (!this.playing) return this.offset % this.duration;
        const elapsed = Math.max(0, this.context.currentTime - this.startedAt);
        return (this.offset + elapsed) % this.duration;
    }

    applyGain(track, immediate = false) {
        const value = track.muted ? 0 : track.volume;
        if (immediate || !this.context) {
            track.gain.gain.value = value;
        } else {
            track.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.018);
        }
    }

    applyPosition(track, immediate = false) {
        const x = track.x * 3.2;
        const y = track.elevation * 2.2;
        const z = track.depth * 3.2;
        const panner = track.panner;
        if ('positionX' in panner) {
            if (immediate) {
                panner.positionX.value = x;
                panner.positionY.value = y;
                panner.positionZ.value = z;
            } else {
                const now = this.context.currentTime;
                panner.positionX.setTargetAtTime(x, now, 0.018);
                panner.positionY.setTargetAtTime(y, now, 0.018);
                panner.positionZ.setTargetAtTime(z, now, 0.018);
            }
        } else {
            panner.setPosition(x, y, z);
        }
    }

    unload() {
        this.stopSources();
        this.tracks.forEach(track => {
            try { track.gain.disconnect(); } catch (_) { /* Already disconnected. */ }
            try { track.panner.disconnect(); } catch (_) { /* Already disconnected. */ }
        });
        this.tracks = [];
        this.duration = 0;
        this.offset = 0;
        this.startedAt = 0;
        this.playing = false;
    }
}
