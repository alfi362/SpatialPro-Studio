import { SpatialAudioEngine } from './audio-engine.js';

'use strict';

const MAX_FILE_BYTES = 500 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set(['aac', 'aif', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'wma']);
const MODEL_HINTS = {
    htdemucs: 'A strong balance of speed and separation quality.',
    htdemucs_ft: 'Slower processing with refined detail and fewer artifacts.',
    hdemucs_mmi: 'An alternate model for tracks that need a different separation profile.'
};
const STEM_META = {
    bass: { label: 'Bass', glyph: 'B', color: '#43d7a5', role: 'Low-end foundation' },
    drums: { label: 'Drums', glyph: 'D', color: '#ff8d6b', role: 'Rhythm and percussion' },
    vocals: { label: 'Vocals', glyph: 'V', color: '#aa8cff', role: 'Lead and backing voice' },
    other: { label: 'Other', glyph: 'O', color: '#5ac8f5', role: 'Harmony and instruments' }
};
const STEM_ORDER = { bass: 0, drums: 1, vocals: 2, other: 3 };
const DEFAULT_POSITIONS = {
    bass: { x: -0.62, depth: 0.16 },
    drums: { x: 0.61, depth: 0.2 },
    vocals: { x: 0.02, depth: -0.67 },
    other: { x: 0.06, depth: 0.68 }
};

const elements = {
    audioInput: document.getElementById('audio-upload'),
    dropzone: document.getElementById('dropzone'),
    selectedFile: document.getElementById('selected-file'),
    fileName: document.getElementById('file-name'),
    fileMeta: document.getElementById('file-meta'),
    removeFile: document.getElementById('remove-file'),
    mode: document.getElementById('demucs-mode'),
    modelHint: document.getElementById('model-hint'),
    process: document.getElementById('process-audio'),
    demo: document.getElementById('load-demo'),
    status: document.getElementById('status-panel'),
    statusTitle: document.getElementById('status-title'),
    statusMessage: document.getElementById('status-message'),
    channelSection: document.getElementById('channel-section'),
    channelRack: document.getElementById('channel-rack'),
    channelCount: document.getElementById('channel-count'),
    stage: document.getElementById('spatial-stage'),
    emptyStage: document.getElementById('empty-stage'),
    markerLayer: document.getElementById('marker-layer'),
    play: document.getElementById('play-all'),
    playLabel: document.getElementById('play-label'),
    reset: document.getElementById('reset-positions'),
    mixTitle: document.getElementById('mix-title'),
    mixSubtitle: document.getElementById('mix-subtitle'),
    timeCurrent: document.getElementById('time-current'),
    timeTotal: document.getElementById('time-total'),
    theme: document.getElementById('theme-toggle'),
    engineBadge: document.getElementById('engine-badge'),
    engineLabel: document.getElementById('engine-label')
};

const state = {
    selectedFile: null,
    tracks: [],
    busy: false,
    drag: null,
    hasInteracted: false
};

const engine = new SpatialAudioEngine(DEFAULT_POSITIONS);

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

function fileExtension(filename) {
    return filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
}

function setStatus(kind, title, message) {
    elements.status.dataset.state = kind;
    elements.statusTitle.textContent = title;
    elements.statusMessage.textContent = message;
}

function setBusy(busy) {
    state.busy = busy;
    elements.process.disabled = busy || !state.selectedFile;
    elements.demo.disabled = busy;
    elements.audioInput.disabled = busy;
    elements.mode.disabled = busy;
    elements.removeFile.disabled = busy;
    elements.dropzone.setAttribute('aria-disabled', String(busy));
}

function clearSelectedFile() {
    state.selectedFile = null;
    elements.audioInput.value = '';
    elements.selectedFile.hidden = true;
    elements.process.disabled = true;
}

function selectFile(file) {
    state.hasInteracted = true;
    if (!file) {
        clearSelectedFile();
        return;
    }

    const extension = fileExtension(file.name);
    if (!AUDIO_EXTENSIONS.has(extension)) {
        clearSelectedFile();
        setStatus('error', 'Unsupported file', 'Choose a WAV, MP3, FLAC, M4A, AAC, AIFF, OGG, Opus, or WMA file.');
        return;
    }
    if (file.size === 0) {
        clearSelectedFile();
        setStatus('error', 'File is empty', 'Choose an audio file that contains playable audio.');
        return;
    }
    if (file.size > MAX_FILE_BYTES) {
        clearSelectedFile();
        setStatus('error', 'File is too large', 'Choose an audio file smaller than 500 MB.');
        return;
    }

    state.selectedFile = file;
    elements.fileName.textContent = file.name;
    elements.fileMeta.textContent = `${extension.toUpperCase()} · ${formatBytes(file.size)}`;
    elements.selectedFile.querySelector('.file-icon').textContent = extension.slice(0, 4).toUpperCase();
    elements.selectedFile.hidden = false;
    elements.process.disabled = state.busy;
    setStatus('idle', 'Track selected', 'Choose a separation quality, then separate the track.');
}

function canonicalStemId(value) {
    const normalized = String(value || '').toLowerCase();
    if (normalized.includes('bass')) return 'bass';
    if (normalized.includes('drum')) return 'drums';
    if (normalized.includes('vocal')) return 'vocals';
    if (normalized.includes('other') || normalized.includes('accompaniment')) return 'other';
    return normalized.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'stem';
}

function normalizeManifest(payload) {
    if (!payload || !Array.isArray(payload.stems) || !payload.stems.length) {
        throw new Error('The processor returned no playable stems.');
    }

    const usedIds = new Set();
    const manifest = payload.stems.map((entry, index) => {
        const rawUrl = typeof entry === 'string' ? entry : entry?.url;
        if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
            throw new Error('The processor returned an invalid stem URL.');
        }
        const resolvedUrl = new URL(rawUrl, window.location.href);
        if (resolvedUrl.origin !== window.location.origin) {
            throw new Error('A stem URL pointed outside this SpatialPro server.');
        }

        const filename = decodeURIComponent(resolvedUrl.pathname.split('/').pop() || `stem-${index + 1}`);
        const baseId = canonicalStemId(typeof entry === 'string' ? filename : (entry.id || filename));
        let id = baseId;
        let suffix = 2;
        while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
        usedIds.add(id);

        const baseMeta = STEM_META[baseId] || {
            label: typeof entry === 'object' && entry.label ? String(entry.label) : `Stem ${index + 1}`,
            glyph: String(index + 1),
            color: `hsl(${(index * 79 + 175) % 360} 76% 65%)`,
            role: 'Separated audio channel'
        };

        return {
            id,
            baseId,
            label: typeof entry === 'object' && entry.label ? String(entry.label) : baseMeta.label,
            glyph: baseMeta.glyph,
            color: baseMeta.color,
            role: baseMeta.role,
            url: `${resolvedUrl.pathname}${resolvedUrl.search}`
        };
    });

    manifest.sort((a, b) => (STEM_ORDER[a.baseId] ?? 99) - (STEM_ORDER[b.baseId] ?? 99));
    return manifest;
}

async function readApiResponse(response) {
    let payload;
    try {
        payload = await response.json();
    } catch (_) {
        throw new Error(`The server returned an unreadable response (${response.status}).`);
    }
    if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.error || `Request failed (${response.status}).`);
    }
    return payload;
}

function positionDescription(track) {
    const horizontal = Math.abs(track.x) < 0.1 ? 'centered' : `${Math.round(Math.abs(track.x) * 100)}% ${track.x < 0 ? 'left' : 'right'}`;
    const depth = Math.abs(track.depth) < 0.1 ? 'near listener' : `${Math.round(Math.abs(track.depth) * 100)}% ${track.depth < 0 ? 'front' : 'back'}`;
    return `${horizontal}, ${depth}`;
}

function markerAriaLabel(track) {
    const elevation = Math.round(track.elevation * 100);
    return `${track.label}, ${positionDescription(track)}, elevation ${elevation > 0 ? '+' : ''}${elevation}. Use arrow keys to move.`;
}

function renderChannels() {
    elements.channelRack.innerHTML = state.tracks.map(track => {
        const volumePercent = Math.round(track.volume * 100);
        const elevationPercent = Math.round(track.elevation * 100);
        return `
            <article class="channel-card" data-track-id="${escapeHtml(track.id)}" style="--track-color: ${track.color}">
                <div class="channel-card-head">
                    <span class="channel-glyph" aria-hidden="true">${escapeHtml(track.glyph)}</span>
                    <span class="channel-name">
                        <strong>${escapeHtml(track.label)}</strong>
                        <span class="position-copy">${escapeHtml(positionDescription(track))}</span>
                    </span>
                    <button class="mute-button" type="button" data-action="mute" aria-pressed="false" aria-label="Mute ${escapeHtml(track.label)}">Mute</button>
                </div>
                <div class="channel-controls">
                    <div class="range-field">
                        <label for="volume-${escapeHtml(track.id)}">Volume <output>${volumePercent}%</output></label>
                        <input id="volume-${escapeHtml(track.id)}" data-control="volume" type="range" min="0" max="1" step="0.01" value="${track.volume}" style="--range: ${volumePercent}%" aria-label="${escapeHtml(track.label)} volume">
                    </div>
                    <div class="range-field">
                        <label for="elevation-${escapeHtml(track.id)}">Height <output>${elevationPercent > 0 ? '+' : ''}${elevationPercent}</output></label>
                        <input id="elevation-${escapeHtml(track.id)}" data-control="elevation" type="range" min="-1" max="1" step="0.01" value="${track.elevation}" style="--range: ${(track.elevation + 1) * 50}%" aria-label="${escapeHtml(track.label)} height">
                    </div>
                </div>
            </article>`;
    }).join('');
    elements.channelSection.hidden = !state.tracks.length;
    elements.channelCount.textContent = `${state.tracks.length} loaded`;
}

function renderMarkers() {
    elements.markerLayer.innerHTML = '';
    state.tracks.forEach(track => {
        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'stem-marker';
        marker.dataset.trackId = track.id;
        marker.style.setProperty('--track-color', track.color);
        marker.setAttribute('aria-label', markerAriaLabel(track));
        marker.innerHTML = `<span class="stem-marker-glyph" aria-hidden="true">${escapeHtml(track.glyph)}</span><span class="stem-marker-name" aria-hidden="true">${escapeHtml(track.label)}</span>`;
        addMarkerEvents(marker);
        elements.markerLayer.appendChild(marker);
    });
    elements.emptyStage.hidden = Boolean(state.tracks.length);
    requestAnimationFrame(positionAllMarkers);
}

function renderMix(sourceLabel) {
    renderChannels();
    renderMarkers();
    elements.mixTitle.textContent = sourceLabel;
    elements.mixSubtitle.textContent = `${state.tracks.length} synchronized spatial stems`;
    elements.timeTotal.textContent = formatTime(engine.duration);
    elements.play.disabled = !state.tracks.length;
    elements.reset.disabled = !state.tracks.length;
    updateTransport();
}

function markerFor(trackId) {
    return [...elements.markerLayer.children].find(marker => marker.dataset.trackId === trackId) || null;
}

function cardFor(trackId) {
    return [...elements.channelRack.children].find(card => card.dataset.trackId === trackId) || null;
}

function positionMarker(track) {
    const marker = markerFor(track.id);
    if (!marker) return;
    const rect = elements.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const markerRadius = marker.offsetWidth / 2;
    const radius = Math.max(0, Math.min(rect.width, rect.height) / 2 - markerRadius - 7);
    marker.style.left = `${rect.width / 2 + track.x * radius}px`;
    marker.style.top = `${rect.height / 2 + track.depth * radius}px`;
    marker.setAttribute('aria-label', markerAriaLabel(track));
}

function positionAllMarkers() {
    state.tracks.forEach(positionMarker);
}

function updateTrackPositionUI(track) {
    positionMarker(track);
    const card = cardFor(track.id);
    const positionCopy = card?.querySelector('.position-copy');
    if (positionCopy) positionCopy.textContent = positionDescription(track);
}

function constrainPosition(x, depth) {
    const distance = Math.hypot(x, depth);
    if (distance <= 1) return { x, depth };
    return { x: x / distance, depth: depth / distance };
}

function moveTrackToPointer(event, marker, track) {
    const stageRect = elements.stage.getBoundingClientRect();
    const markerRadius = marker.offsetWidth / 2;
    const radius = Math.max(1, Math.min(stageRect.width, stageRect.height) / 2 - markerRadius - 7);
    const targetX = event.clientX - stageRect.left - state.drag.offsetX;
    const targetY = event.clientY - stageRect.top - state.drag.offsetY;
    const next = constrainPosition(
        (targetX - stageRect.width / 2) / radius,
        (targetY - stageRect.height / 2) / radius
    );
    track.x = next.x;
    track.depth = next.depth;
    engine.applyPosition(track);
    updateTrackPositionUI(track);
}

function addMarkerEvents(marker) {
    marker.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const track = state.tracks.find(item => item.id === marker.dataset.trackId);
        if (!track) return;
        const rect = marker.getBoundingClientRect();
        state.drag = {
            pointerId: event.pointerId,
            trackId: track.id,
            offsetX: event.clientX - (rect.left + rect.width / 2),
            offsetY: event.clientY - (rect.top + rect.height / 2)
        };
        marker.setPointerCapture(event.pointerId);
        marker.classList.add('is-dragging');
        event.preventDefault();
    });

    marker.addEventListener('pointermove', event => {
        if (!state.drag || state.drag.pointerId !== event.pointerId || state.drag.trackId !== marker.dataset.trackId) return;
        const track = state.tracks.find(item => item.id === state.drag.trackId);
        if (track) moveTrackToPointer(event, marker, track);
    });

    const finishDrag = event => {
        if (!state.drag || state.drag.pointerId !== event.pointerId) return;
        marker.classList.remove('is-dragging');
        if (marker.hasPointerCapture(event.pointerId)) marker.releasePointerCapture(event.pointerId);
        state.drag = null;
    };
    marker.addEventListener('pointerup', finishDrag);
    marker.addEventListener('pointercancel', finishDrag);

    marker.addEventListener('keydown', event => {
        const track = state.tracks.find(item => item.id === marker.dataset.trackId);
        if (!track) return;
        const step = event.shiftKey ? 0.1 : 0.035;
        let x = track.x;
        let depth = track.depth;
        if (event.key === 'ArrowLeft') x -= step;
        else if (event.key === 'ArrowRight') x += step;
        else if (event.key === 'ArrowUp') depth -= step;
        else if (event.key === 'ArrowDown') depth += step;
        else if (event.key === 'Home') { x = 0; depth = 0; }
        else return;
        event.preventDefault();
        const next = constrainPosition(x, depth);
        track.x = next.x;
        track.depth = next.depth;
        engine.applyPosition(track);
        updateTrackPositionUI(track);
    });
}

function updateTransport() {
    const playing = engine.playing;
    elements.play.classList.toggle('is-playing', playing);
    elements.play.setAttribute('aria-pressed', String(playing));
    elements.playLabel.textContent = playing ? 'Pause mix' : 'Play mix';
}

async function activateManifest(payload, sourceLabel) {
    const manifest = normalizeManifest(payload);
    setStatus('busy', 'Loading audio', `Preparing 0 of ${manifest.length} stems…`);
    const prepared = await engine.prepare(manifest, (completed, total, label) => {
        setStatus('busy', 'Loading audio', `Prepared ${completed} of ${total} · ${label}`);
    });
    state.tracks = engine.commit(prepared);
    renderMix(sourceLabel);
    setStatus('success', 'Mix ready', 'Press play, then drag each stem around the listener.');
}

async function processSelectedFile() {
    if (!state.selectedFile || state.busy) return;
    state.hasInteracted = true;
    setBusy(true);
    setStatus('busy', 'Separating track', 'This runs locally and may take several minutes on the first pass.');
    const formData = new FormData();
    formData.append('audio', state.selectedFile, state.selectedFile.name);

    try {
        await engine.ensureContext();
        const response = await fetch(`/process-audio?mode=${encodeURIComponent(elements.mode.value)}`, {
            method: 'POST',
            body: formData,
            credentials: 'same-origin'
        });
        const payload = await readApiResponse(response);
        const cleanName = state.selectedFile.name.replace(/\.[^.]+$/, '');
        await activateManifest(payload, cleanName || 'Separated mix');
    } catch (error) {
        console.error(error);
        setStatus('error', 'Could not prepare this mix', error.message || 'An unexpected error occurred.');
    } finally {
        setBusy(false);
    }
}

async function loadDemo() {
    if (state.busy) return;
    state.hasInteracted = true;
    setBusy(true);
    setStatus('busy', 'Opening saved mix', 'Loading the four local stem files…');
    try {
        await engine.ensureContext();
        const response = await fetch('/api/demo', { credentials: 'same-origin', cache: 'no-store' });
        const payload = await readApiResponse(response);
        await activateManifest(payload, 'Saved demo mix');
    } catch (error) {
        console.error(error);
        setStatus('error', 'Demo could not be loaded', error.message || 'Start SpatialPro with python run.py and try again.');
    } finally {
        setBusy(false);
    }
}

function resetPositions() {
    state.tracks.forEach((track, index) => {
        const fallbackAngle = ((index / Math.max(state.tracks.length, 1)) * Math.PI * 2) - Math.PI / 2;
        const position = DEFAULT_POSITIONS[track.baseId] || { x: Math.cos(fallbackAngle) * 0.62, depth: Math.sin(fallbackAngle) * 0.62 };
        track.x = position.x;
        track.depth = position.depth;
        engine.applyPosition(track);
        updateTrackPositionUI(track);
    });
    setStatus('idle', 'Positions reset', 'The original spatial layout has been restored.');
}

async function togglePlayback() {
    if (!state.tracks.length) return;
    try {
        if (engine.playing) engine.pause();
        else await engine.play();
        updateTransport();
    } catch (error) {
        console.error(error);
        setStatus('error', 'Playback unavailable', error.message || 'The browser could not start audio playback.');
    }
}

async function checkHealth() {
    try {
        const response = await fetch('/health', { cache: 'no-store', credentials: 'same-origin' });
        const payload = await readApiResponse(response);
        const fullEngine = Boolean(payload?.processor?.demucs);
        elements.engineBadge.dataset.state = fullEngine ? 'ready' : 'demo';
        elements.engineLabel.textContent = fullEngine ? 'Engine ready' : 'Demo ready';
        elements.engineBadge.title = fullEngine
            ? 'Demucs is available for local separation'
            : 'Saved stems are ready; install Demucs to separate new tracks';
        if (!fullEngine && !state.hasInteracted) {
            setStatus('warning', 'Demo mode available', 'Demucs is not installed here, but the saved spatial mix is ready to explore.');
        }
    } catch (_) {
        elements.engineBadge.dataset.state = 'offline';
        elements.engineLabel.textContent = 'Server offline';
        elements.engineBadge.title = 'Start the app with python run.py';
        if (!state.hasInteracted) {
            setStatus('error', 'Local server not found', 'Start SpatialPro with python run.py, then reopen this page.');
        }
    }
}

elements.audioInput.addEventListener('change', () => selectFile(elements.audioInput.files?.[0] || null));
elements.removeFile.addEventListener('click', event => {
    event.preventDefault();
    selectFile(null);
    setStatus('idle', 'Source cleared', 'Choose another track or load the saved stems.');
});

['dragenter', 'dragover'].forEach(type => elements.dropzone.addEventListener(type, event => {
    event.preventDefault();
    if (!state.busy) elements.dropzone.classList.add('is-dragging');
}));
['dragleave', 'drop'].forEach(type => elements.dropzone.addEventListener(type, event => {
    event.preventDefault();
    elements.dropzone.classList.remove('is-dragging');
}));
elements.dropzone.addEventListener('drop', event => {
    if (!state.busy) selectFile(event.dataTransfer?.files?.[0] || null);
});

elements.mode.addEventListener('change', () => {
    elements.modelHint.textContent = MODEL_HINTS[elements.mode.value] || '';
});
elements.process.addEventListener('click', processSelectedFile);
elements.demo.addEventListener('click', loadDemo);
elements.play.addEventListener('click', togglePlayback);
elements.reset.addEventListener('click', resetPositions);

elements.channelRack.addEventListener('input', event => {
    const input = event.target.closest('input[data-control]');
    const card = event.target.closest('.channel-card');
    if (!input || !card) return;
    const track = state.tracks.find(item => item.id === card.dataset.trackId);
    if (!track) return;
    const value = Number.parseFloat(input.value);
    const output = input.closest('.range-field').querySelector('output');
    if (input.dataset.control === 'volume') {
        track.volume = value;
        engine.applyGain(track);
        const percent = Math.round(value * 100);
        input.style.setProperty('--range', `${percent}%`);
        output.textContent = `${percent}%`;
    } else {
        track.elevation = value;
        engine.applyPosition(track);
        const percent = Math.round(value * 100);
        input.style.setProperty('--range', `${(value + 1) * 50}%`);
        output.textContent = `${percent > 0 ? '+' : ''}${percent}`;
        const marker = markerFor(track.id);
        marker?.setAttribute('aria-label', markerAriaLabel(track));
    }
});

elements.channelRack.addEventListener('click', event => {
    const button = event.target.closest('button[data-action="mute"]');
    const card = event.target.closest('.channel-card');
    if (!button || !card) return;
    const track = state.tracks.find(item => item.id === card.dataset.trackId);
    if (!track) return;
    track.muted = !track.muted;
    engine.applyGain(track);
    button.setAttribute('aria-pressed', String(track.muted));
    button.setAttribute('aria-label', `${track.muted ? 'Unmute' : 'Mute'} ${track.label}`);
    button.textContent = track.muted ? 'Muted' : 'Mute';
});

function syncThemeUi() {
    const isDark = document.documentElement.dataset.theme === 'dark';
    elements.theme.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} theme`);
    document.querySelector('meta[name="theme-color"]').content = isDark ? '#090b11' : '#f4f5f9';
}

elements.theme.addEventListener('click', () => {
    const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    try { localStorage.setItem('spatialpro-theme', nextTheme); } catch (_) { /* Storage can be disabled. */ }
    syncThemeUi();
});

const resizeObserver = new ResizeObserver(positionAllMarkers);
resizeObserver.observe(elements.stage);

function updateClock() {
    elements.timeCurrent.textContent = formatTime(engine.currentTime());
    requestAnimationFrame(updateClock);
}

window.addEventListener('beforeunload', () => engine.unload());
syncThemeUi();
updateClock();
checkHealth();
