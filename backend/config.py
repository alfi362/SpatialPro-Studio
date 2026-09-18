"""Application paths, limits, and supported audio models."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
FRONTEND_ASSETS_DIR = FRONTEND_DIR / "assets"
STORAGE_DIR = PROJECT_ROOT / "storage"
DEMO_DIR = STORAGE_DIR / "demo"
JOBS_DIR = STORAGE_DIR / "jobs"
UPLOADS_DIR = STORAGE_DIR / "uploads"

MAX_UPLOAD_BYTES = 500 * 1024 * 1024
PROCESS_TIMEOUT_SECONDS = 60 * 60

SUPPORTED_MODELS = {
    "htdemucs": "Balanced",
    "htdemucs_ft": "Fine-tuned",
    "hdemucs_mmi": "Experimental",
}
SUPPORTED_EXTENSIONS = {
    ".aac",
    ".aif",
    ".aiff",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
}
STEM_ORDER = {"bass": 0, "drums": 1, "vocals": 2, "other": 3}
STEM_LABELS = {
    "bass": "Bass",
    "drums": "Drums",
    "vocals": "Vocals",
    "other": "Other",
}
DEMO_FILES = tuple(f"{stem}.wav" for stem in STEM_ORDER)


def ensure_storage_directories() -> None:
    """Create only the writable runtime directories used by the server."""
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
