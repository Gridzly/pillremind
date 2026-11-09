const http = require("http");
const fs = require("fs");
const path = require("path");

// Use the hosting platform's assigned port.
const PORT = process.env.PORT || 8000;

const ROOT = __dirname;

// Firebase Functions emulator URL.
// This only works if the emulator is running in this environment.
const FUNCTIONS_URL =
  "http://127.0.0.1:5001/pillremind-e6294/us-central1/";

const allowedFunctions = new Set([
  "createConnectionCode",
  "redeemConnectionCode",
  "getMyConnections",
]);

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
  ".webp": "image/webp",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    // Firebase Functions proxy
    if (url.pathname.startsWith("/api/functions/")) {
      if (req.method !== "POST") {
        res.writeHead(405, {
          "Content-Type": "application/json",
        });

        return res.end(JSON.stringify({
          error: {
            message: "Use POST for Firebase Function requests.",
          },
        }));
      }

      const functionName = decodeURIComponent(
        url.pathname.slice("/api/functions/".length)
      );

      if (!allowedFunctions.has(functionName)) {
        res.writeHead(404, {
          "Content-Type": "application/json",
        });

        return res.end(JSON.stringify({
          error: {
            message: "Function not found.",
          },
        }));
      }

      try {
        let body = "";

        for await (const chunk of req) {
          body += chunk;
        }

        const upstream = await fetch(
          FUNCTIONS_URL + functionName,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(req.headers.authorization
                ? {
                    Authorization: req.headers.authorization,
                  }
                : {}),
            },
            body,
          }
        );

        const responseBody = await upstream.text();

        res.writeHead(upstream.status, {
          "Content-Type":
            upstream.headers.get("content-type") ||
            "application/json",
          "Cache-Control": "no-store",
        });

        return res.end(responseBody);

      } catch (error) {
        console.error("Function proxy error:", error);

        res.writeHead(502, {
          "Content-Type": "application/json",
        });

        return res.end(JSON.stringify({
          error: {
            message:
              "Cannot reach Firebase Functions emulator. Check port 5001.",
          },
        }));
      }
    }

    // Serve website files
    let requestedPath = decodeURIComponent(url.pathname);

    if (requestedPath === "/") {
      requestedPath = "/index.html";
    }

    const filePath = path.resolve(
      ROOT,
      "." + requestedPath
    );

    if (
      !filePath.startsWith(ROOT + path.sep) &&
      filePath !== ROOT
    ) {
      res.writeHead(403);
      return res.end("Forbidden");
    }

    fs.stat(filePath, (error, stats) => {
      if (error || !stats.isFile()) {
        res.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
        });

        return res.end("File not found: " + requestedPath);
      }

      res.writeHead(200, {
        "Content-Type":
          mimeTypes[path.extname(filePath).toLowerCase()] ||
          "application/octet-stream",
      });

      fs.createReadStream(filePath).pipe(res);
    });

  } catch (error) {
    console.error("Server request error:", error);

    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "application/json",
      });
    }

    res.end(JSON.stringify({
      error: {
        message: "Internal server error.",
      },
    }));
  }
});

// Listen on the assigned hosting port.
server.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("MEDMINDER SERVER STARTED!");
  console.log("================================");
  console.log(`Port: ${PORT}`);
  console.log("Host: 0.0.0.0");
  console.log("Functions proxy: /api/functions/<functionName>");
});
