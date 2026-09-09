import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Keep HTTP and Socket.IO origin policies aligned.  Reflecting every Origin while
 * allowing credentials is unsafe, so development has an explicit local default
 * and production requires the deploy URL to be configured.
 */
export function corsOptions(frontendUrl = process.env.FRONTEND_URL, nodeEnv = process.env.NODE_ENV): CorsOptions {
  const origins = frontendUrl?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [];
  const allowedOrigins = origins.length > 0 ? origins : nodeEnv === 'production' ? [] : ['http://localhost:3000'];

  return {
    origin: allowedOrigins.length === 0 ? false : allowedOrigins,
    credentials: true,
  };
}
