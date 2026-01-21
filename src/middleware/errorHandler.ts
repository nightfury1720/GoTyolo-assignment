import { Request, Response, NextFunction } from 'express';
import { HttpError } from '../types';
import { logger } from '../utils/logger';

/**
 * Global error handling middleware.
 * Handles HttpErrors with custom status codes and logs all errors.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): Response | void {
  // If headers already sent, delegate to default Express error handler
  if (res.headersSent) {
    return next(err);
  }

  // Handle custom HttpError
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }

  // Log unexpected errors
  logger.error('Unexpected error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Return generic 500 for unexpected errors
  const status = 500;
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal Server Error' 
    : err.message;
  
  return res.status(status).json({ error: message });
}
