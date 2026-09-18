"""Development and WSGI entry point for SpatialPro."""

from __future__ import annotations

import os

from backend import create_app

app = create_app()


def main() -> None:
    """Run the local SpatialPro development server."""
    host = os.getenv("SPATIALPRO_HOST", "127.0.0.1")
    port = int(os.getenv("SPATIALPRO_PORT", "5000"))
    debug = os.getenv("SPATIALPRO_DEBUG", "").lower() in {"1", "true", "yes"}
    app.run(host=host, port=port, debug=debug, use_reloader=debug)


if __name__ == "__main__":
    main()
