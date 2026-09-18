"""SpatialPro Flask application factory."""

from __future__ import annotations

import logging
import os

from flask import Flask, request
from werkzeug.exceptions import RequestEntityTooLarge

from .config import (
    FRONTEND_ASSETS_DIR,
    MAX_UPLOAD_BYTES,
    ensure_storage_directories,
)
from .routes import error_response, routes


def create_app(test_config: dict | None = None) -> Flask:
    """Create and configure a SpatialPro application instance."""
    ensure_storage_directories()
    logging.basicConfig(
        level=os.getenv("SPATIALPRO_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    app = Flask(
        __name__,
        static_folder=str(FRONTEND_ASSETS_DIR),
        static_url_path="/assets",
    )
    app.config.update(
        MAX_CONTENT_LENGTH=MAX_UPLOAD_BYTES,
        JSON_SORT_KEYS=False,
    )
    if test_config:
        app.config.update(test_config)

    app.register_blueprint(routes)

    @app.after_request
    def add_security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; "
            "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )
        if request.path.startswith(("/process-audio", "/api/", "/health")):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(RequestEntityTooLarge)
    def handle_large_upload(_error):
        return error_response(
            "FILE_TOO_LARGE",
            f"Audio files must be smaller than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            413,
        )

    return app
