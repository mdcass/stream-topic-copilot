import express from "express";
import path from "node:path";

import type { AppService } from "./appService.js";

export function createApp(service: AppService, publicDir: string, sessionsDir: string) {
  const app = express();

  app.use(express.json());
  app.use("/artifacts", express.static(sessionsDir));
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

  app.post("/api/session/mock-transcript", async (request, response) => {
    try {
      response.json({ session: await service.injectMockTranscript(request.body.text) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("*", (_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });

  return app;
}
