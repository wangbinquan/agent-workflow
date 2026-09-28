"""Serve only the four public demo assets on loopback, never the repository tree."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
ASSETS = {
    "/": (HERE / "index.html", "text/html; charset=utf-8"),
    "/index.html": (HERE / "index.html", "text/html; charset=utf-8"),
    "/demo.css": (HERE / "demo.css", "text/css; charset=utf-8"),
    "/build/app.js": (HERE / "build/app.js", "text/javascript; charset=utf-8"),
    "/packages/frontend/src/styles.css": (ROOT / "packages/frontend/src/styles.css", "text/css; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        asset = ASSETS.get(urlsplit(self.path).path)
        if asset is None or not asset[0].is_file():
            self.send_error(404)
            return
        data = asset[0].read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", asset[1])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print("Observability design demo: http://127.0.0.1:48371", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 48371), Handler).serve_forever()
