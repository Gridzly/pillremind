
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = 8000;
const FUNCTIONS_URL =
  "http://127.0.0.1:5001/pillremind-e6294/us-central1/";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf"
};

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  // Proxy Firebase Callable Functions requests to the local emulator.
  if (requestUrl.pathname.startsWith("/api/functions/")) {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        error: { message: "POST required" }
      }));
    }

    const functionName = requestUrl.pathname
      .slice("/api/functions/".length);

    // Only permit the functions used by Medminder.
    const allowedFunctions = new Set([
      "createConnectionCode",
      "redeemConnectionCode",
      "getMyConnections"
    ]);

    if (!allowedFunctions.has(functionName)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        error: { message: "Function not allowed" }
      }));
    }

    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);

      const headers = {
        "Content-Type": "application/json"
      };

      // Forward the Firebase ID token. The function must still
      // validate the signed-in user's identity and permissions.
      if (req.headers.authorization) {
        headers.Authorization = req.headers.authorization;
      }

      const upstream = await fetch(
        FUNCTIONS_URL + functionName,
        {
          method: "POST",
          headers,
          body
        }
      );

      const responseBody = await upstream.arrayBuffer();

      res.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ||
          "application/json"
      });

      return res.end(Buffer.from(responseBody));
    } catch (error) {
      console.error("Functions proxy error:", error);

      res.writeHead(502, {
        "Content-Type": "application/json"
      });

      return res.end(JSON.stringify({
        error: {
          message: "Could not reach the local Firebase Functions emulator."
        }
      }));
    }
  }

  // Serve the website files.
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }

  if (pathname === "/") pathname = "/index.html";

  const filePath = path.resolve(ROOT, "." + pathname);

  if (
    filePath !== ROOT &&
    !filePath.startsWith(ROOT + path.sep)
  ) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      return res.end("File not found");
    }

    res.writeHead(200, {
      "Content-Type":
        mimeTypes[path.extname(filePath).toLowerCase()] ||
        "application/octet-stream",
      "Cache-Control": "no-store"
    });

    res.end(content);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Medminder website and proxy: http://localhost:${PORT}`);
});
