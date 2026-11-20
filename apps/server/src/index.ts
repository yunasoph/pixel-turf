import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import pino from "pino";
import { env } from "./config";
import { registerGameSockets } from "./game/sockets";

const logger = pino({
  transport: env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
});

async function bootstrap() {
  if (env.MONGODB_URI) {
    try {
      await mongoose.connect(env.MONGODB_URI);
      logger.info("✅ Connected to MongoDB Atlas");
    } catch (err) {
      logger.warn(
        err,
        "⚠️ Failed to connect to MongoDB; continuing with in-memory rooms"
      );
    }
  } else {
    logger.info("ℹ️ MONGODB_URI not set; running with in-memory rooms");
  }

  const app = express();
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: env.CLIENT_ORIGINS,
      credentials: true,
    },
  });

  app.use(cors({ origin: env.CLIENT_ORIGINS, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      time: new Date().toISOString(),
    });
  });

  registerGameSockets(io);

  httpServer.listen(env.PORT, () => {
    logger.info(`🚀 Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });
}

bootstrap();
