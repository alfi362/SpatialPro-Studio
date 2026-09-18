"""Demucs process orchestration, validation, and storage lifecycle."""

from __future__ import annotations

import importlib.util
import logging
import os
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from ..config import (
    JOBS_DIR,
    MAX_UPLOAD_BYTES,
    PROCESS_TIMEOUT_SECONDS,
    PROJECT_ROOT,
    STEM_ORDER,
    SUPPORTED_EXTENSIONS,
    SUPPORTED_MODELS,
    UPLOADS_DIR,
)

logger = logging.getLogger("spatialpro.separation")
_processing_lock = threading.BoundedSemaphore(value=1)


class SeparationError(RuntimeError):
    """A processing failure that can be safely returned to the client."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass(frozen=True)
class SeparationResult:
    """Metadata for one completed separation job."""

    job_id: str
    model: str
    output_dir: Path
    stems: tuple[Path, ...]


def processor_available() -> bool:
    """Return whether Demucs is importable by the active Python runtime."""
    return importlib.util.find_spec("demucs") is not None


def uploaded_file_size(audio_file: FileStorage) -> int | None:
    """Measure a seekable multipart stream without consuming the upload."""
    stream = audio_file.stream
    try:
        position = stream.tell()
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(position, os.SEEK_SET)
        return size
    except (AttributeError, OSError, ValueError):
        try:
            stream.seek(0)
        except (AttributeError, OSError, ValueError):
            pass
        return None


def validate_audio_request(audio_file: FileStorage | None, model: str) -> str:
    """Validate request metadata and return the normalized source extension."""
    if audio_file is None or not audio_file.filename:
        raise SeparationError("AUDIO_REQUIRED", "Choose an audio file before processing.", 400)

    if model not in SUPPORTED_MODELS:
        raise SeparationError(
            "INVALID_MODEL",
            "The selected separation model is not supported.",
            400,
        )

    safe_original_name = secure_filename(audio_file.filename)
    extension = Path(safe_original_name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise SeparationError(
            "UNSUPPORTED_AUDIO",
            "Use a WAV, MP3, FLAC, M4A, AAC, AIFF, OGG, Opus, or WMA audio file.",
            415,
        )

    upload_size = uploaded_file_size(audio_file)
    if upload_size == 0:
        raise SeparationError("EMPTY_AUDIO", "The selected audio file is empty.", 400)
    if upload_size is not None and upload_size > MAX_UPLOAD_BYTES:
        raise SeparationError(
            "FILE_TOO_LARGE",
            f"Audio files must be smaller than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            413,
        )

    return extension


def separate_audio(audio_file: FileStorage | None, model: str) -> SeparationResult:
    """Validate, separate, and retain the generated stems for browser playback."""
    extension = validate_audio_request(audio_file, model)
    if not processor_available():
        raise SeparationError(
            "PROCESSOR_UNAVAILABLE",
            "Demucs is not installed in this Python environment. You can still load the saved demo stems.",
            503,
        )

    if not _processing_lock.acquire(blocking=False):
        raise SeparationError(
            "PROCESSOR_BUSY",
            "Another separation is currently running. Please try again when it finishes.",
            429,
        )

    job_id = uuid4().hex
    upload_dir = UPLOADS_DIR / job_id
    output_dir = JOBS_DIR / job_id
    upload_path = upload_dir / f"source{extension}"

    try:
        upload_dir.mkdir(parents=True, exist_ok=False)
        output_dir.mkdir(parents=True, exist_ok=False)
        assert audio_file is not None  # Narrowed by validate_audio_request.
        audio_file.save(upload_path)

        command = [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            model,
            str(upload_path),
            "--out",
            str(output_dir),
        ]
        logger.info("Starting separation job %s with model %s", job_id, model)
        result = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=PROCESS_TIMEOUT_SECONDS,
            check=False,
        )

        if result.returncode != 0:
            logger.error(
                "Separation job %s failed with code %s. stderr: %s",
                job_id,
                result.returncode,
                result.stderr[-4000:],
            )
            shutil.rmtree(output_dir, ignore_errors=True)
            raise SeparationError(
                "SEPARATION_FAILED",
                "Audio separation failed. Verify that FFmpeg is installed and the file is valid.",
                500,
            )

        stem_files = tuple(
            sorted(
                (path for path in output_dir.rglob("*.wav") if path.is_file()),
                key=lambda path: (STEM_ORDER.get(path.stem.lower(), 99), path.stem.lower()),
            )
        )
        if not stem_files:
            logger.error("Separation job %s completed without WAV outputs", job_id)
            shutil.rmtree(output_dir, ignore_errors=True)
            raise SeparationError(
                "OUTPUT_MISSING",
                "Separation completed but no playable stems were produced.",
                500,
            )

        logger.info("Separation job %s completed with %d stems", job_id, len(stem_files))
        return SeparationResult(job_id, model, output_dir, stem_files)
    except SeparationError:
        raise
    except subprocess.TimeoutExpired as error:
        logger.exception("Separation job %s timed out", job_id)
        shutil.rmtree(output_dir, ignore_errors=True)
        raise SeparationError(
            "PROCESSING_TIMEOUT",
            "Separation took too long and was stopped. Try a shorter audio file.",
            504,
        ) from error
    except OSError as error:
        logger.exception("Filesystem or process error in separation job %s", job_id)
        shutil.rmtree(output_dir, ignore_errors=True)
        raise SeparationError(
            "PROCESSING_ERROR",
            "The audio processor could not start. Check the server logs and installation.",
            500,
        ) from error
    except Exception as error:
        logger.exception("Unexpected error in separation job %s", job_id)
        shutil.rmtree(output_dir, ignore_errors=True)
        raise SeparationError(
            "INTERNAL_ERROR",
            "An unexpected server error occurred.",
            500,
        ) from error
    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)
        _processing_lock.release()
