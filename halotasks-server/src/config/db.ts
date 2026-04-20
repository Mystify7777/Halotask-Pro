import mongoose from 'mongoose';
import dns from 'node:dns';

const getDnsFallbackServers = () => {
  const raw = process.env.MONGO_DNS_SERVERS;

  if (!raw) {
    return ['8.8.8.8', '1.1.1.1'];
  }

  return raw
    .split(',')
    .map((server) => server.trim())
    .filter((server) => server.length > 0);
};

const isSrvDnsRefusal = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const withCode = error as Error & { code?: string; syscall?: string };
  return withCode.code === 'ECONNREFUSED' && withCode.syscall === 'querySrv';
};

export const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error('MONGO_URI is not configured');
  }

  try {
    await mongoose.connect(mongoUri);
  } catch (error) {
    if (!mongoUri.startsWith('mongodb+srv://') || !isSrvDnsRefusal(error)) {
      throw error;
    }

    const fallbackServers = getDnsFallbackServers();
    if (fallbackServers.length === 0) {
      throw error;
    }

    dns.setServers(fallbackServers);
    await mongoose.connect(mongoUri);
  }

  console.log('MongoDB connected');
};