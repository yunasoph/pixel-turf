import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { env } from './config';
import pino from 'pino';

const logger = pino({
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});

async function bootstrap() {
  try {
    await mongoose.connect(env.MONGODB_URI);
    logger.info('✅ Connected to MongoDB Atlas');
  } catch (err) {
    logger.error(err, '❌ Failed to connect to MongoDB');
    process.exit(1);
  }

  const app = express();
  const httpServer = createServer(app);
  
  const io = new Server(httpServer, {
    cors: {
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    },
  });

  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  io.on('connection', (socket) => {
    logger.info(`⚡ Client connected: ${socket.id}`);
    socket.on('disconnect', () => {
      logger.info(`🔌 Client disconnected: ${socket.id}`);
    });
  });

  httpServer.listen(env.PORT, () => {
    logger.info(`🚀 Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });
}

bootstrap();
