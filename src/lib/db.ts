import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from './logger';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ db: mongoose.connection.name }, 'mongodb connected');
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

export function dbStatus(): 'connected' | 'connecting' | 'disconnected' {
  const s = mongoose.connection.readyState;
  return s === 1 ? 'connected' : s === 2 ? 'connecting' : 'disconnected';
}
