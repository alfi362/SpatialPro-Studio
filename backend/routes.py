"""HTTP routes for the SpatialPro interface, API, and generated media."""

from __future__ import annotations

import shutil
from pathlib import Path
from uuid import UUID

from flask import Blueprint, jsonify, request, send_from_directory, url_for

from .config import (
    DEMO_DIR,
    DEMO_FILES,
    FRONTEND_DIR,
    JOBS_DIR,
    STEM_LABELS,
    SUPPORTED_MODELS,
)
from .services.separation import SeparationError, processor_available, separate_audio

routes = Blueprint("spatialpro", __name__)


def error_response(code: str, message: str, status: int):
    """Return the stable public error shape used by every API endpoint."""
    return jsonify({"error": {"code": code, "message": message}}), status


def valid_job_id(value: str) -> bool:
    try:
        UUID(hex=value)
        return True
    except (ValueError, AttributeError):
        return False


def stem_payload(stem_path: Path, job_id: str, job_output_dir: Path) -> dict[str, str]:
    stem_id = stem_path.stem.lower().strip()
    label = STEM_LABELS.get(stem_id, stem_id.replace("_", " ").title() or "Stem")
    relative_path = stem_path.relative_to(job_output_dir).as_posix()
    return {
        "id": stem_id,
        "label": label,
        "url": url_for(
            "spatialpro.serve_job_media",
            job_id=job_id,
            filename=relative_path,
        ),
    }


@routes.get("/")
@routes.get("/index.html")
def serve_index():
    return send_from_directory(FRONTEND_DIR, "index.html", max_age=0)


@routes.get("/health")
def health():
    has_demucs = processor_available()
    has_ffmpeg = shutil.which("ffmpeg") is not None
    return jsonify(
        {
            "status": "ready" if has_demucs else "demo_only",
            "processor": {
                "demucs": has_demucs,
                "ffmpeg": has_ffmpeg,
            },
            "models": [
                {"id": model_id, "label": label}
                for model_id, label in SUPPORTED_MODELS.items()
            ],
            "demo_available": all((DEMO_DIR / filename).is_file() for filename in DEMO_FILES),
        }
    )


@routes.get("/api/demo")
def demo_manifest():
    missing = [filename for filename in DEMO_FILES if not (DEMO_DIR / filename).is_file()]
    if missing:
        return error_response("DEMO_UNAVAILABLE", "The saved demo stems are not available.", 404)

    stems = []
    for filename in DEMO_FILES:
        stem_id = Path(filename).stem
        stems.append(
            {
                "id": stem_id,
                "label": STEM_LABELS[stem_id],
                "url": url_for("spatialpro.serve_demo_media", filename=filename),
            }
        )
    return jsonify({"source": "demo", "stems": stems})


@routes.get("/media/demo/<path:filename>")
def serve_demo_media(filename: str):
    if Path(filename).name != filename or filename not in DEMO_FILES:
        return error_response("MEDIA_NOT_FOUND", "Stem file not found.", 404)
    return send_from_directory(DEMO_DIR, filename, conditional=True)


@routes.get("/media/jobs/<job_id>/<path:filename>")
def serve_job_media(job_id: str, filename: str):
    if not valid_job_id(job_id):
        return error_response("MEDIA_NOT_FOUND", "Stem file not found.", 404)
    return send_from_directory(JOBS_DIR / job_id, filename, conditional=True)


@routes.post("/process-audio")
def process_audio():
    model = request.args.get("mode", "htdemucs")
    try:
        result = separate_audio(request.files.get("audio"), model)
    except SeparationError as error:
        return error_response(error.code, error.message, error.status)

    return jsonify(
        {
            "job_id": result.job_id,
            "model": result.model,
            "stems": [
                stem_payload(stem_path, result.job_id, result.output_dir)
                for stem_path in result.stems
            ],
        }
    )
