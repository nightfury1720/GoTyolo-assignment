import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';

/**
 * Middleware to handle express-validator validation results.
 * Returns 400 Bad Request with error details if validation fails.
 */
export function handleValidation(
  req: Request,
  res: Response,
  next: NextFunction
): Response | void {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  return next();
}
