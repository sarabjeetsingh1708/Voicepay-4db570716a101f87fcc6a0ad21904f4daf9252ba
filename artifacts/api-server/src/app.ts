import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import router from "./routes";

const app: Express = express();

// Allow the Expo web build (same origin) and any local dev URLs
app.use(
  cors({
    origin: true, // reflect request origin — safe for development
    credentials: true,
  })
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// API routes
app.use("/api", router);

// ── Serve the static Expo web build from the awaazpe artifact ─────────────
// When running the API server in production the awaazpe static build lives at
// ../awaazpe/static-build/  relative to this package.
// If the folder exists, serve it so everything comes from one port.
const staticBuildDir = path.resolve(__dirname, "..", "..", "awaazpe", "static-build");

if (fs.existsSync(staticBuildDir)) {
  app.use(express.static(staticBuildDir));

  // SPA fallback — any non-API route returns index.html
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    const indexPath = path.join(staticBuildDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      next();
    }
  });
}

export default app;