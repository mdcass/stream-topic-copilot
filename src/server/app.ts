import fs from "node:fs";
import express from "express";
import path from "node:path";

import type { AppService } from "./appService.js";

function isViteDevelopmentServerExpected(): boolean {
  return process.env.npm_lifecycle_event === "dev" || process.env.npm_lifecycle_event === "dev:server";
}

export function createApp(service: AppService, publicDir: string, sessionsDir: string, rootDir: string) {
  const app = express();
  const indexPath = path.join(publicDir, "index.html");

  app.use(express.json());
  app.use("/artifacts", express.static(sessionsDir));
  app.use((request, response, next) => {
    if (
      isViteDevelopmentServerExpected() &&
      request.method === "GET" &&
      !request.path.startsWith("/api") &&
      request.accepts("html")
    ) {
      response.redirect(`http://127.0.0.1:5173${request.originalUrl}`);
      return;
    }

    next();
  });
  app.use(express.static(publicDir));

  app.get("/api/state", async (_request, response) => {
    response.json(await service.getState());
  });

  app.post("/api/config", async (request, response) => {
    try {
      const config = await service.updateConfig(request.body ?? {});
      response.json({ config });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/permissions/request", async (_request, response) => {
    try {
      response.json(await service.requestRelevantPermissions());
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/permissions/open-settings", async (_request, response) => {
    try {
      response.json(await service.openRelevantPrivacySettings());
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/start", async (_request, response) => {
    try {
      response.json({ session: await service.startSession() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/resume/:id", async (request, response) => {
    try {
      response.json({ session: await service.resumeSession(request.params.id) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/end", async (request, response) => {
    try {
      const status = request.body?.status === "interrupted" ? "interrupted" : "finished";
      response.json({ session: await service.endSession(status) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/analyze", async (_request, response) => {
    try {
      response.json({ session: await service.analyzeNow() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/topic-state", async (request, response) => {
    try {
      response.json({
        session: await service.setTopicState(request.body.topicId, request.body.nextState)
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/undo", async (_request, response) => {
    try {
      response.json({ session: await service.undoLastAction() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/live-prompt/dismiss", async (request, response) => {
    try {
      response.json({ session: await service.dismissLivePrompt(request.body.promptId) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/theme/dismiss", async (request, response) => {
    try {
      response.json({ session: await service.dismissRevisitableTheme(request.body.themeId) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/theme/pin", async (request, response) => {
    try {
      response.json({ session: await service.pinRevisitableTheme(request.body.themeId) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/theme/unpin", async (request, response) => {
    try {
      response.json({ session: await service.unpinRevisitableTheme(request.body.themeId) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/session/mock-transcript", async (request, response) => {
    try {
      response.json({ session: await service.injectMockTranscript(request.body.text, request.body.sourceId) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("*", (request, response) => {
    if (fs.existsSync(indexPath)) {
      response.sendFile(indexPath);
      return;
    }

    response.status(503).type("text/plain").send(
      [
        `UI assets not found at ${indexPath}.`,
        "For development, open http://127.0.0.1:5173 after running `npm run dev`.",
        `For the server-only URL on http://127.0.0.1:4312, build the UI first with \`npm run build\` or set PUBLIC_DIR to a built UI directory in ${path.join(rootDir, ".env")}.`
      ].join("\n")
    );
  });

  return app;
}
